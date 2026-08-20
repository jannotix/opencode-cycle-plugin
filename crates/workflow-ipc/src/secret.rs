use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use workflow_core::ContentDigest;
use zeroize::ZeroizeOnDrop;

#[derive(ZeroizeOnDrop)]
pub struct IpcSecret([u8; 32]);

impl IpcSecret {
    pub fn generate() -> Result<Self, SecretError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| SecretError::Entropy)?;
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    #[must_use]
    pub fn endpoint_id(&self) -> String {
        ContentDigest::of(&self.0).to_string()[..32].to_owned()
    }
}

impl std::fmt::Debug for IpcSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("IpcSecret([REDACTED])")
    }
}

#[derive(Debug)]
pub enum SecretError {
    Entropy,
    InsecurePermissions,
    InvalidLength,
    Io(std::io::Error),
    NotRegularFile,
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Entropy => formatter.write_str("operating-system entropy is unavailable"),
            Self::InsecurePermissions => {
                formatter.write_str("IPC credential permissions are not restricted")
            }
            Self::InvalidLength => formatter.write_str("IPC credential has an invalid length"),
            Self::Io(error) => error.fmt(formatter),
            Self::NotRegularFile => {
                formatter.write_str("IPC credential path is not a regular file")
            }
        }
    }
}

impl std::error::Error for SecretError {}

impl From<std::io::Error> for SecretError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn load_or_create(path: impl AsRef<Path>) -> Result<IpcSecret, SecretError> {
    let path = path.as_ref();
    if path.exists() {
        return load(path);
    }
    let parent = path.parent().ok_or_else(|| {
        SecretError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "IPC credential path has no parent",
        ))
    })?;
    std::fs::create_dir_all(parent)?;
    restrict_directory(parent)?;

    let secret = IpcSecret::generate()?;
    let temporary = temporary_path(path, &secret.endpoint_id());
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    restrict_new_file(&mut options);
    let mut file = options.open(&temporary)?;
    file.write_all(secret.as_bytes())?;
    file.sync_all()?;
    drop(file);

    match std::fs::hard_link(&temporary, path) {
        Ok(()) => {
            std::fs::remove_file(&temporary)?;
            validate_metadata(path)?;
            Ok(secret)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(&temporary)?;
            load(path)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(SecretError::Io(error))
        }
    }
}

pub fn load(path: impl AsRef<Path>) -> Result<IpcSecret, SecretError> {
    let path = path.as_ref();
    validate_metadata(path)?;
    let mut secret = IpcSecret([0_u8; 32]);
    OpenOptions::new()
        .read(true)
        .open(path)?
        .read_exact(&mut secret.0)?;
    Ok(secret)
}

fn validate_metadata(path: &Path) -> Result<(), SecretError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(SecretError::NotRegularFile);
    }
    if metadata.len() != 32 {
        return Err(SecretError::InvalidLength);
    }
    validate_permissions(&metadata)
}

fn temporary_path(path: &Path, endpoint_id: &str) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.{}.new", &endpoint_id[..16]))
}

#[cfg(unix)]
fn restrict_new_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(windows)]
fn restrict_new_file(_: &mut OpenOptions) {}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
fn restrict_directory(_: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn validate_permissions(metadata: &std::fs::Metadata) -> Result<(), SecretError> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(SecretError::InsecurePermissions)
    }
}

#[cfg(windows)]
fn validate_permissions(_: &std::fs::Metadata) -> Result<(), SecretError> {
    Ok(())
}
