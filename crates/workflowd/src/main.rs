use std::{ffi::OsString, path::PathBuf};

enum Command {
    Backup {
        data_directory: PathBuf,
        destination: PathBuf,
    },
    Serve {
        _certification_owner_token: Option<String>,
        data_directory: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    match parse_command(std::env::args_os().skip(1).collect()) {
        Ok(Command::Serve { data_directory, .. }) => {
            if let Err(error) = workflowd::lifecycle::run(data_directory).await {
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
        Err(error) => {
            eprintln!("workflowd failed: {error}");
            std::process::exit(2);
        }
    }
}

fn parse_command(arguments: Vec<OsString>) -> Result<Command, &'static str> {
    match arguments.as_slice() {
        [flag, path] if flag == "--data-dir" => Ok(Command::Serve {
            _certification_owner_token: None,
            data_directory: absolute(path)?,
        }),
        [data_flag, data_directory, owner_flag, owner_token]
            if data_flag == "--data-dir"
                && owner_flag == "--certification-owner-token"
                && valid_owner_token(owner_token) =>
        {
            Ok(Command::Serve {
                _certification_owner_token: Some(owner_token.to_string_lossy().into_owned()),
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
        _ => Err(
            "expected --data-dir <absolute-path> [--certification-owner-token <64-lower-hex>] or --backup-data-dir <absolute-path> --backup-to <absolute-path>",
        ),
    }
}

fn valid_owner_token(value: &OsString) -> bool {
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
        let command = parse_command(vec![
            OsString::from("--data-dir"),
            data_directory.clone().into_os_string(),
            OsString::from("--certification-owner-token"),
            OsString::from("a".repeat(64)),
        ])
        .unwrap();
        assert!(matches!(
            command,
            Command::Serve {
                _certification_owner_token: Some(token),
                ..
            } if token == "a".repeat(64)
        ));
        assert!(
            parse_command(vec![
                OsString::from("--data-dir"),
                data_directory.into_os_string(),
                OsString::from("--certification-owner-token"),
                OsString::from("A".repeat(64)),
            ])
            .is_err()
        );
    }
}
