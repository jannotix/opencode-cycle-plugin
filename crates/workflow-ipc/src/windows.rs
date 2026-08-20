use std::{ffi::c_void, io, mem::size_of, ptr, time::Duration};

use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

pub type LocalStream = NamedPipeClient;

struct PipeSecurity {
    attributes: SECURITY_ATTRIBUTES,
    descriptor: *mut c_void,
}

// SAFETY: the descriptor pointer is exclusively owned and only used on the listener thread.
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            // SAFETY: descriptor is an exclusive LocalAlloc pointer from SDDL conversion.
            unsafe {
                LocalFree(self.descriptor);
            }
        }
    }
}

impl PipeSecurity {
    fn for_current_user() -> io::Result<Self> {
        let sid = current_user_sid_string()?;
        // Same-user clients, including OpenCode Desktop's Node utility process and
        // AppContainer packages of this user, may reconnect to a leftover daemon.
        let sddl = format!("D:(A;;GA;;;SY)(A;;GA;;;{sid})(A;;GRGW;;;AC)");
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: wide is a NUL-terminated SDDL string; descriptor receives a LocalAlloc pointer.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 || descriptor.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            attributes: SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
            descriptor,
        })
    }

    fn attributes_ptr(&self) -> *mut c_void {
        (&self.attributes as *const SECURITY_ATTRIBUTES)
            .cast_mut()
            .cast()
    }
}

fn current_user_sid_string() -> io::Result<String> {
    // SAFETY: token and SID APIs are called with buffers sized from the first GetTokenInformation query.
    unsafe {
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut needed = 0_u32;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0_u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let user = buffer.as_ptr().cast::<TOKEN_USER>().read();
        let mut sid_string: *mut u16 = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut sid_string) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut length = 0_usize;
        while *sid_string.add(length) != 0 {
            length += 1;
        }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(sid_string, length));
        LocalFree(sid_string.cast());
        Ok(value)
    }
}

pub struct LocalListener {
    path: String,
    pending: Option<NamedPipeServer>,
    security: PipeSecurity,
}

impl LocalListener {
    pub fn bind(endpoint_id: &str) -> io::Result<Self> {
        let path = named_pipe_path(endpoint_id)?;
        let security = PipeSecurity::for_current_user()?;
        Ok(Self {
            pending: Some(create_server(&path, true, &security)?),
            path,
            security,
        })
    }

    pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
        let server = match self.pending.take() {
            Some(server) => server,
            None => create_server(&self.path, false, &self.security)?,
        };
        self.pending = Some(create_server(&self.path, false, &self.security)?);
        server.connect().await?;
        Ok(server)
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.path
    }
}

fn create_server(
    path: &str,
    first_instance: bool,
    security: &PipeSecurity,
) -> io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.reject_remote_clients(true);
    if first_instance {
        options.first_pipe_instance(true);
    }
    // SAFETY: attributes_ptr remains valid for the duration of CreateNamedPipeW.
    unsafe { options.create_with_security_attributes_raw(path, security.attributes_ptr()) }
}

pub async fn connect(endpoint_id: &str) -> io::Result<LocalStream> {
    let path = named_pipe_path(endpoint_id)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match ClientOptions::new().open(&path) {
            Ok(client) => return Ok(client),
            Err(error)
                if matches!(error.raw_os_error(), Some(2 | 231))
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

pub fn named_pipe_path(endpoint_id: &str) -> io::Result<String> {
    if endpoint_id.len() != 32
        || endpoint_id
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid IPC endpoint identifier",
        ));
    }
    Ok(format!(r"\\.\pipe\opencode-cycle-{endpoint_id}"))
}

#[cfg(test)]
mod tests {
    use super::named_pipe_path;

    #[test]
    fn names_pipe_in_opencode_cycle_namespace() {
        assert_eq!(
            named_pipe_path("0123456789abcdef0123456789abcdef").unwrap(),
            r"\\.\pipe\opencode-cycle-0123456789abcdef0123456789abcdef"
        );
    }
}
