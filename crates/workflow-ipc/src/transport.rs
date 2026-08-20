#[cfg(unix)]
pub use crate::unix::{LocalListener, LocalStream, connect};
#[cfg(windows)]
pub use crate::windows::{LocalListener, LocalStream, connect, named_pipe_path};
