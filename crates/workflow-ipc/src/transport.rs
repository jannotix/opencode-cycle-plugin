#[cfg(unix)]
pub use crate::unix::{
    LocalListener, LocalStream, MAX_UNIX_SOCKET_PATH_BYTES, connect, validate_socket_path,
};
#[cfg(windows)]
pub use crate::windows::{LocalListener, LocalStream, connect, named_pipe_path};
