use std::{ffi::OsString, path::PathBuf};

mod verification_job;

enum Command {
    Backup {
        data_directory: PathBuf,
        destination: PathBuf,
    },
    Serve {
        certification: Option<workflowd::lifecycle::CertificationLifecycle>,
        data_directory: PathBuf,
    },
    WaitCertificationExit {
        pid: u32,
        process_start_time_unix_millis: u64,
    },
    VerificationJobChild,
    VerificationJobHost,
}

#[tokio::main]
async fn main() {
    match parse_command(std::env::args_os().skip(1).collect()) {
        Ok(Command::Serve {
            certification,
            data_directory,
        }) => {
            if let Err(error) = workflowd::lifecycle::run(data_directory, certification).await {
                eprintln!("workflowd failed: {error}");
                std::process::exit(1);
            }
        }
        Ok(Command::Backup {
            data_directory,
            destination,
        }) => {
            if let Err(error) = workflow_store::backup_existing_database(
                data_directory.join("control-plane.db"),
                destination,
            ) {
                eprintln!("workflowd backup failed: {error}");
                std::process::exit(1);
            }
        }
        Ok(Command::WaitCertificationExit {
            pid,
            process_start_time_unix_millis,
        }) => {
            if let Err(error) = workflowd::lifecycle::wait_for_certification_instance_exit(
                pid,
                process_start_time_unix_millis,
                std::time::Duration::from_secs(15),
            )
            .await
            {
                eprintln!("workflowd certification exit verification failed: {error}");
                std::process::exit(1);
            }
        }
        Ok(Command::VerificationJobChild) => {
            std::process::exit(verification_job::run_child());
        }
        Ok(Command::VerificationJobHost) => {
            std::process::exit(verification_job::run_host());
        }
        Err(error) => {
            eprintln!("workflowd failed: {error}");
            std::process::exit(2);
        }
    }
}

fn parse_command(arguments: Vec<OsString>) -> Result<Command, &'static str> {
    match arguments.as_slice() {
        [flag, path] if flag == "--data-dir" => Ok(Command::Serve {
            certification: None,
            data_directory: absolute(path)?,
        }),
        [
            data_flag,
            data_directory,
            owner_flag,
            owner_token,
            runtime_flag,
            runtime_marker,
            exit_flag,
            exit_marker,
            run_flag,
            run_digest,
        ] if data_flag == "--data-dir"
            && owner_flag == "--certification-owner-token"
            && runtime_flag == "--certification-runtime-marker"
            && exit_flag == "--certification-exit-marker"
            && run_flag == "--certification-run-digest"
            && valid_digest(owner_token)
            && valid_digest(run_digest) =>
        {
            Ok(Command::Serve {
                certification: Some(workflowd::lifecycle::CertificationLifecycle {
                    exit_marker: absolute(exit_marker)?,
                    owner_token: owner_token.to_string_lossy().into_owned(),
                    run_digest: run_digest.to_string_lossy().into_owned(),
                    runtime_marker: absolute(runtime_marker)?,
                }),
                data_directory: absolute(data_directory)?,
            })
        }
        [data_flag, data_directory, backup_flag, destination]
            if data_flag == "--backup-data-dir" && backup_flag == "--backup-to" =>
        {
            Ok(Command::Backup {
                data_directory: absolute(data_directory)?,
                destination: absolute(destination)?,
            })
        }
        [wait_flag, pid, start_flag, process_start]
            if wait_flag == "--certification-wait-exit"
                && start_flag == "--certification-process-start" =>
        {
            Ok(Command::WaitCertificationExit {
                pid: positive_u32(pid)?,
                process_start_time_unix_millis: positive_u64(process_start)?,
            })
        }
        [flag] if flag == "--verification-job-child" => Ok(Command::VerificationJobChild),
        [flag] if flag == "--verification-job-host" => Ok(Command::VerificationJobHost),
        _ => Err(
            "expected --data-dir <absolute-path>, the fully bound certification serve form, --certification-wait-exit <pid> --certification-process-start <millis>, --verification-job-host, --verification-job-child, or --backup-data-dir <absolute-path> --backup-to <absolute-path>",
        ),
    }
}

fn positive_u32(value: &OsString) -> Result<u32, &'static str> {
    value
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .ok_or("workflowd process identifier must be a positive integer")
}

fn positive_u64(value: &OsString) -> Result<u64, &'static str> {
    value
        .to_str()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or("workflowd process start identity must be a positive integer")
}

fn valid_digest(value: &OsString) -> bool {
    let bytes = value.as_encoded_bytes();
    bytes.len() == 64
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn absolute(path: &OsString) -> Result<PathBuf, &'static str> {
    let path = PathBuf::from(path);
    path.is_absolute()
        .then_some(path)
        .ok_or("path must be absolute")
}

#[cfg(test)]
mod tests {
    use super::{Command, parse_command};
    use std::ffi::OsString;

    #[test]
    fn backup_command_requires_two_explicit_absolute_paths() {
        let data_directory = std::env::temp_dir().join("opencode-cycle-backup-source");
        let destination = std::env::temp_dir().join("opencode-cycle-backup.db");
        let command = parse_command(vec![
            OsString::from("--backup-data-dir"),
            data_directory.into_os_string(),
            OsString::from("--backup-to"),
            destination.into_os_string(),
        ])
        .unwrap();
        assert!(matches!(command, Command::Backup { .. }));
        assert!(
            parse_command(vec![
                OsString::from("--backup-data-dir"),
                OsString::from("relative")
            ])
            .is_err()
        );
    }

    #[test]
    fn serve_command_accepts_only_a_bound_certification_owner_token() {
        let data_directory = std::env::temp_dir().join("opencode-cycle-certification-runtime");
        let runtime_marker = data_directory.join("desktop-daemon-runtime.json");
        let exit_marker = data_directory.join("desktop-daemon-exit.json");
        let command = parse_command(vec![
            OsString::from("--data-dir"),
            data_directory.clone().into_os_string(),
            OsString::from("--certification-owner-token"),
            OsString::from("a".repeat(64)),
            OsString::from("--certification-runtime-marker"),
            runtime_marker.clone().into_os_string(),
            OsString::from("--certification-exit-marker"),
            exit_marker.clone().into_os_string(),
            OsString::from("--certification-run-digest"),
            OsString::from("b".repeat(64)),
        ])
        .unwrap();
        assert!(matches!(
            command,
            Command::Serve {
                certification: Some(_),
                ..
            }
        ));
        assert!(
            parse_command(vec![
                OsString::from("--data-dir"),
                data_directory.into_os_string(),
                OsString::from("--certification-owner-token"),
                OsString::from("A".repeat(64)),
                OsString::from("--certification-runtime-marker"),
                runtime_marker.into_os_string(),
                OsString::from("--certification-exit-marker"),
                exit_marker.into_os_string(),
                OsString::from("--certification-run-digest"),
                OsString::from("b".repeat(64)),
            ])
            .is_err()
        );
    }

    #[test]
    fn certification_exit_wait_requires_exact_positive_process_identity() {
        assert!(matches!(
            parse_command(vec![
                OsString::from("--certification-wait-exit"),
                OsString::from("4242"),
                OsString::from("--certification-process-start"),
                OsString::from("1700000000000"),
            ]),
            Ok(Command::WaitCertificationExit {
                pid: 4242,
                process_start_time_unix_millis: 1_700_000_000_000,
            })
        ));
        assert!(
            parse_command(vec![
                OsString::from("--certification-wait-exit"),
                OsString::from("0"),
                OsString::from("--certification-process-start"),
                OsString::from("1700000000000"),
            ])
            .is_err()
        );
    }
}
