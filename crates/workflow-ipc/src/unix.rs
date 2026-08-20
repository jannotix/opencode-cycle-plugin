use std::{
    io,
    os::unix::fs::FileTypeExt,
    path::{Path, PathBuf},
};

use nix::unistd::Uid;
use tokio::net::{UnixListener, UnixStream};

pub type LocalStream = UnixStream;

pub struct LocalListener {
    listener: UnixListener,
    path: PathBuf,
    uid: u32,
}

impl LocalListener {
    pub fn bind(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "socket path has no parent")
        })?;
        std::fs::create_dir_all(parent)?;
        set_mode(parent, 0o700)?;

        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if !metadata.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "IPC endpoint is not a socket",
                ));
            }
            match std::os::unix::net::UnixStream::connect(path) {
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "IPC server is already running",
                    ));
                }
                Err(_) => std::fs::remove_file(path)?,
            }
        }

        let listener = UnixListener::bind(path)?;
        set_mode(path, 0o600)?;
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            uid: Uid::current().as_raw(),
        })
    }

    pub async fn accept(&self) -> io::Result<LocalStream> {
        let (stream, _) = self.listener.accept().await?;
        if stream.peer_cred()?.uid() != self.uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "IPC peer user does not match server user",
            ));
        }
        Ok(stream)
    }
}

impl Drop for LocalListener {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.path)
            .is_ok_and(|metadata| metadata.file_type().is_socket())
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub async fn connect(path: impl AsRef<Path>) -> io::Result<LocalStream> {
    UnixStream::connect(path).await
}

fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}
