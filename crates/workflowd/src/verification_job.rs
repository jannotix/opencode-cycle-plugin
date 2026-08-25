use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::{Command, Stdio},
};

use serde::Deserialize;

const REQUEST_ENV: &str = "CYCLE_VERIFICATION_JOB_REQUEST";
const INTERNAL_FAILURE_EXIT: i32 = 125;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerificationJobRequest {
    args: Vec<String>,
    cwd: PathBuf,
    environment: BTreeMap<String, String>,
    program: String,
}

pub fn run_child() -> i32 {
    let Ok(request) = read_request() else {
        return INTERNAL_FAILURE_EXIT;
    };
    let Ok(status) = Command::new(&request.program)
        .args(&request.args)
        .current_dir(&request.cwd)
        .env_clear()
        .envs(&request.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .and_then(|mut child| child.wait())
    else {
        return INTERNAL_FAILURE_EXIT;
    };
    status.code().unwrap_or(INTERNAL_FAILURE_EXIT)
}

fn read_request() -> Result<VerificationJobRequest, ()> {
    let encoded = std::env::var(REQUEST_ENV).map_err(|_| ())?;
    if encoded.is_empty() || encoded.len() > 64 * 1024 {
        return Err(());
    }
    let request: VerificationJobRequest = serde_json::from_str(&encoded).map_err(|_| ())?;
    if request.program.is_empty()
        || request.program.len() > 4_096
        || request.program.contains('\0')
        || !request.cwd.is_absolute()
        || request.args.len() > 256
        || request
            .args
            .iter()
            .any(|argument| argument.len() > 4_096 || argument.contains('\0'))
        || request.environment.len() > 128
        || request.environment.iter().any(|(name, value)| {
            name.is_empty()
                || name.len() > 128
                || value.len() > 32 * 1024
                || name.contains(['\0', '='])
                || value.contains('\0')
        })
    {
        return Err(());
    }
    Ok(request)
}

#[cfg(not(windows))]
pub fn run_host() -> i32 {
    INTERNAL_FAILURE_EXIT
}

#[cfg(windows)]
pub fn run_host() -> i32 {
    windows::run_host().unwrap_or(INTERNAL_FAILURE_EXIT)
}

#[cfg(windows)]
mod windows {
    #![allow(unsafe_code)]

    use std::{
        ffi::c_void,
        io::BufRead,
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
        thread,
    };

    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, INVALID_HANDLE_VALUE,
            WAIT_OBJECT_0,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ,
            FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                CREATE_SUSPENDED, CreateEventW, CreateProcessW, GetCurrentProcess,
                GetExitCodeProcess, INFINITE, PROCESS_INFORMATION, ResumeThread,
                STARTF_USESTDHANDLES, STARTUPINFOW, SetEvent, TerminateProcess,
                WaitForMultipleObjects, WaitForSingleObject,
            },
        },
    };

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Result<Self, ()> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(())
            } else {
                Ok(Self(handle))
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn run_host() -> Result<i32, ()> {
        super::read_request()?;
        let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(());
        }

        let stdout = duplicate_standard_handle(unsafe { GetStdHandle(STD_OUTPUT_HANDLE) })?;
        let stderr = duplicate_standard_handle(unsafe { GetStdHandle(STD_ERROR_HANDLE) })?;
        let nul_security = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let nul = OwnedHandle::new(unsafe {
            CreateFileW(
                wide("NUL").as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &raw const nul_security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        })?;
        let event = OwnedHandle::new(unsafe { CreateEventW(null(), 1, 0, null()) })?;

        let executable = std::env::current_exe().map_err(|_| ())?;
        let application = wide(executable.as_os_str());
        let mut command_line = wide(format!(
            "\"{}\" --verification-job-child",
            executable.to_string_lossy().replace('"', "\\\"")
        ));
        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = nul.0;
        startup.hStdOutput = stdout.0;
        startup.hStdError = stderr.0;
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED,
                null(),
                null(),
                &raw const startup,
                &raw mut process,
            )
        } == 0
        {
            return Err(());
        }
        let child_process = OwnedHandle::new(process.hProcess)?;
        let child_thread = OwnedHandle::new(process.hThread)?;
        #[cfg(debug_assertions)]
        if let Some(pid_path) = std::env::var_os("CYCLE_VERIFICATION_JOB_TEST_ASSIGNMENT_FAILURE") {
            let recorded = std::fs::write(pid_path, process.dwProcessId.to_string());
            let cleaned = terminate_and_wait(child_process.0);
            recorded.map_err(|_| ())?;
            cleaned?;
            return Err(());
        }
        if unsafe { AssignProcessToJobObject(job.0, child_process.0) } == 0 {
            terminate_and_wait(child_process.0)?;
            return Err(());
        }
        if unsafe { ResumeThread(child_thread.0) } == u32::MAX {
            terminate_and_wait(child_process.0)?;
            return Err(());
        }

        let control_event = event.0 as usize;
        let control = thread::spawn(move || {
            let mut line = String::new();
            let _ = std::io::stdin().lock().read_line(&mut line);
            unsafe {
                SetEvent(control_event as HANDLE);
            }
        });
        let handles = [child_process.0, event.0];
        let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        let controlled = waited == WAIT_OBJECT_0 + 1;
        if waited != WAIT_OBJECT_0 && !controlled {
            return Err(());
        }
        if controlled && unsafe { TerminateJobObject(job.0, 1) } == 0 {
            return Err(());
        }
        if unsafe { WaitForSingleObject(child_process.0, INFINITE) } != WAIT_OBJECT_0 {
            return Err(());
        }
        let mut exit_code = 1_u32;
        if unsafe { GetExitCodeProcess(child_process.0, &raw mut exit_code) } == 0 {
            return Err(());
        }
        if !controlled && unsafe { TerminateJobObject(job.0, 1) } == 0 {
            return Err(());
        }
        drop(job);
        if control.is_finished() {
            let _ = control.join();
        }
        if controlled {
            Ok(1)
        } else {
            Ok(i32::try_from(exit_code).unwrap_or(1))
        }
    }

    fn terminate_and_wait(process: HANDLE) -> Result<(), ()> {
        let terminated = unsafe { TerminateProcess(process, 1) } != 0;
        let waited = unsafe { WaitForSingleObject(process, INFINITE) } == WAIT_OBJECT_0;
        if terminated && waited {
            Ok(())
        } else {
            Err(())
        }
    }

    fn duplicate_standard_handle(source: HANDLE) -> Result<OwnedHandle, ()> {
        if source.is_null() || source == INVALID_HANDLE_VALUE {
            return Err(());
        }
        let mut duplicate = null_mut();
        if unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                source,
                GetCurrentProcess(),
                &raw mut duplicate,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        } == 0
        {
            return Err(());
        }
        OwnedHandle::new(duplicate)
    }

    fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
        value.as_ref().encode_wide().chain(Some(0)).collect()
    }
}
