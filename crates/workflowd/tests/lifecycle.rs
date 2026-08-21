use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

#[cfg(unix)]
use std::io::ErrorKind;

use tempfile::TempDir;
use workflow_ipc::{
    client::query_health,
    secret::{IpcSecret, load},
    transport::connect,
};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn start(data_directory: &Path) -> ChildGuard {
    ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_workflowd"))
            .arg("--data-dir")
            .arg(data_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

async fn wait_for_secret(data_directory: &Path) -> IpcSecret {
    let path = data_directory.join("runtime").join("ipc.secret");
    for _ in 0..250 {
        if let Ok(secret) = load(&path) {
            return secret;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("workflowd did not create its IPC credential");
}

fn wait_for_pid_file(data_directory: &Path) -> String {
    let path = data_directory.join("runtime").join("workflowd.pid");
    for _ in 0..250 {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            let pid = contents.trim();
            if !pid.is_empty() {
                return pid.to_owned();
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("workflowd did not write its pid file");
}

#[cfg(windows)]
async fn health(_data_directory: &Path, secret: &IpcSecret) -> workflow_ipc::HealthReport {
    let stream = connect(&secret.endpoint_id()).await.unwrap();
    query_health(stream, secret, 1).await.unwrap()
}

#[cfg(unix)]
async fn health(data_directory: &Path, secret: &IpcSecret) -> workflow_ipc::HealthReport {
    let endpoint = data_directory.join("runtime").join("workflow.sock");
    for _ in 0..250 {
        match connect(&endpoint).await {
            Ok(stream) => return query_health(stream, secret, 1).await.unwrap(),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::NotFound | ErrorKind::ConnectionRefused
                ) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("workflowd IPC connection failed: {error}"),
        }
    }
    panic!("workflowd did not create its IPC endpoint");
}

#[tokio::test]
async fn daemon_starts_reports_health_and_preserves_state_across_restart() {
    let temporary = TempDir::new().unwrap();
    let mut daemon = start(temporary.path());
    let secret = wait_for_secret(temporary.path()).await;
    let pid = wait_for_pid_file(temporary.path());
    assert_eq!(pid, daemon.0.id().to_string());
    let first = health(temporary.path(), &secret).await;
    assert_eq!(first.protocol_version, workflow_core::PROTOCOL_VERSION);
    assert_eq!(first.schema_version, workflow_store::CURRENT_SCHEMA_VERSION);
    assert_eq!(first.schema_mode, "read_write");
    daemon.0.kill().unwrap();
    daemon.0.wait().unwrap();

    let _restarted_daemon = start(temporary.path());
    let restarted = health(temporary.path(), &secret).await;
    assert_eq!(restarted, first);
    assert!(temporary.path().join("control-plane.db").is_file());
}

#[tokio::test]
async fn concurrent_daemon_start_converges_on_one_process() {
    let temporary = TempDir::new().unwrap();
    let _daemon = start(temporary.path());
    let secret = wait_for_secret(temporary.path()).await;
    health(temporary.path(), &secret).await;
    let mut duplicate = start(temporary.path());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = duplicate.0.try_wait().unwrap() {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("duplicate daemon did not exit");
    assert!(!status.success());
    health(temporary.path(), &secret).await;
}
