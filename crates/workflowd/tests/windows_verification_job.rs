#![cfg(windows)]

use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use sysinfo::{Pid, System};
use tempfile::tempdir;

const REQUEST_ENV: &str = "CYCLE_VERIFICATION_JOB_REQUEST";

#[test]
fn job_host_contains_a_lasting_descendant_after_the_requested_root_exits() {
    let temporary = tempdir().unwrap();
    let pid_file = temporary.path().join("descendant.pid");
    let source = [
        "const{spawn}=require('node:child_process')",
        "const{writeFileSync}=require('node:fs')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
        "child.unref()",
        "writeFileSync(process.argv[1],String(child.pid))",
        "process.stdout.write('job-out')",
        "process.stderr.write('job-err')",
        "process.exit(7)",
    ]
    .join(";");
    let request = request(
        "node",
        &["-e", &source, pid_file.to_str().unwrap()],
        temporary.path(),
    );
    let mut host = Command::new(env!("CARGO_BIN_EXE_workflowd"))
        .arg("--verification-job-host")
        .env(REQUEST_ENV, request.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let control = host.stdin.take().unwrap();
    let mut stdout = host.stdout.take().unwrap();
    let mut stderr = host.stderr.take().unwrap();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let status = host.wait().unwrap();
    drop(control);
    let stdout = stdout_reader.join().unwrap();
    let stderr = stderr_reader.join().unwrap();

    assert_eq!(status.code(), Some(7));
    assert_eq!(stdout, b"job-out");
    assert_eq!(stderr, b"job-err");
    let descendant = std::fs::read_to_string(pid_file)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_process_absent(descendant);
}

#[test]
fn job_host_control_channel_terminates_the_root_and_descendant() {
    let temporary = tempdir().unwrap();
    let pid_file = temporary.path().join("tree.json");
    let source = [
        "const{spawn}=require('node:child_process')",
        "const{writeFileSync}=require('node:fs')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
        "child.unref()",
        "writeFileSync(process.argv[1],JSON.stringify({root:process.pid,descendant:child.pid}))",
        "setInterval(()=>{},1000)",
    ]
    .join(";");
    let request = request(
        "node",
        &["-e", &source, pid_file.to_str().unwrap()],
        temporary.path(),
    );
    let mut host = Command::new(env!("CARGO_BIN_EXE_workflowd"))
        .arg("--verification-job-host")
        .env(REQUEST_ENV, request.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_file.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let tree: serde_json::Value =
        serde_json::from_slice(&std::fs::read(pid_file).unwrap()).unwrap();
    host.stdin
        .take()
        .unwrap()
        .write_all(b"terminate\n")
        .unwrap();
    let output = host.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    assert_process_absent(tree["root"].as_u64().unwrap() as u32);
    assert_process_absent(tree["descendant"].as_u64().unwrap() as u32);
}

fn request(program: &str, arguments: &[&str], directory: &std::path::Path) -> serde_json::Value {
    json!({
        "args": arguments,
        "cwd": directory,
        "environment": {
            "CI": "true",
            "PATH": std::env::var("PATH").unwrap(),
            "PATHEXT": std::env::var("PATHEXT").unwrap_or_default(),
            "SystemRoot": std::env::var("SystemRoot").unwrap(),
            "TEMP": std::env::temp_dir(),
        },
        "program": program,
    })
}

fn assert_process_absent(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if System::new_all().process(Pid::from_u32(pid)).is_none() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "process {pid} survived the Job boundary"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
