#![cfg(windows)]
#![allow(unsafe_code)]

use std::{
    io::{Read, Write},
    os::windows::io::AsRawHandle,
    process::{Command, Stdio},
    ptr::null,
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use sysinfo::{Pid, System};
use tempfile::tempdir;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob},
        Threading::GetCurrentProcess,
    },
};

const REQUEST_ENV: &str = "CYCLE_VERIFICATION_JOB_REQUEST";
const TEST_ASSIGNMENT_FAILURE_ENV: &str = "CYCLE_VERIFICATION_JOB_TEST_ASSIGNMENT_FAILURE";
const TEST_NESTED_JOB_ENV: &str = "CYCLE_VERIFICATION_JOB_TEST_NESTED_JOB";

#[test]
fn assignment_failure_terminates_and_waits_for_the_exact_suspended_child() {
    let temporary = tempdir().unwrap();
    let marker = temporary.path().join("child-ran");
    let child_pid = temporary.path().join("suspended-child.pid");
    let source = "require('node:fs').writeFileSync(process.argv[1], 'ran')";
    let request = request(
        "node",
        &["-e", source, marker.to_str().unwrap()],
        temporary.path(),
    );
    let status = Command::new(env!("CARGO_BIN_EXE_workflowd"))
        .arg("--verification-job-host")
        .env(REQUEST_ENV, request.to_string())
        .env(TEST_ASSIGNMENT_FAILURE_ENV, &child_pid)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();

    assert_eq!(status.code(), Some(125));
    assert!(!marker.exists(), "the suspended command must never resume");
    let pid = std::fs::read_to_string(child_pid)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_process_absent(pid);
}

#[test]
fn job_host_contains_children_when_the_host_already_belongs_to_a_job() {
    if std::env::var_os(TEST_NESTED_JOB_ENV).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "job_host_contains_children_when_the_host_already_belongs_to_a_job",
                "--nocapture",
            ])
            .env(TEST_NESTED_JOB_ENV, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "nested-Job helper failed: stdout={:?}, stderr={:?}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        return;
    }

    let outer_job = unsafe { CreateJobObjectW(null(), null()) };
    assert!(!outer_job.is_null());
    assert_ne!(
        unsafe { AssignProcessToJobObject(outer_job, GetCurrentProcess()) },
        0
    );

    let temporary = tempdir().unwrap();
    let pid_file = temporary.path().join("nested-descendant.pid");
    let source = [
        "const{spawn}=require('node:child_process')",
        "const{writeFileSync}=require('node:fs')",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
        "child.unref()",
        "writeFileSync(process.argv[1],String(child.pid))",
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
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut belongs = 0;
    assert_ne!(
        unsafe { IsProcessInJob(host.as_raw_handle() as HANDLE, outer_job, &raw mut belongs,) },
        0,
    );
    assert_ne!(belongs, 0, "the host must inherit the outer Job");
    let control = host.stdin.take().unwrap();
    let status = host.wait().unwrap();
    drop(control);
    assert_eq!(status.code(), Some(7));
    let descendant = std::fs::read_to_string(pid_file)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert_process_absent(descendant);
    unsafe { CloseHandle(outer_job) };
}

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
