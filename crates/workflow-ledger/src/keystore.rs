use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use zeroize::Zeroize;

pub struct CheckpointKey(SigningKey);

impl CheckpointKey {
    pub fn generate() -> Result<Self, KeyError> {
        let mut seed = [0_u8; 32];
        getrandom::fill(&mut seed).map_err(|_| KeyError::Entropy)?;
        let key = Self(SigningKey::from_bytes(&seed));
        seed.zeroize();
        Ok(key)
    }

    #[must_use]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(SigningKey::from_bytes(seed))
    }

    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        self.0.verifying_key()
    }

    pub(crate) fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.0.sign(message).to_bytes()
    }
}

impl std::fmt::Debug for CheckpointKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CheckpointKey([REDACTED])")
    }
}

#[derive(Debug)]
pub enum KeyError {
    Entropy,
    InsecurePermissions,
    InvalidLength,
    Io(std::io::Error),
    NotRegularFile,
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Entropy => formatter.write_str("operating-system entropy is unavailable"),
            Self::InsecurePermissions => {
                formatter.write_str("checkpoint key permissions are not restricted")
            }
            Self::InvalidLength => formatter.write_str("checkpoint key has an invalid length"),
            Self::Io(error) => error.fmt(formatter),
            Self::NotRegularFile => {
                formatter.write_str("checkpoint key path is not a regular file")
            }
        }
    }
}

impl std::error::Error for KeyError {}

impl From<std::io::Error> for KeyError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub fn load_or_create(path: impl AsRef<Path>) -> Result<CheckpointKey, KeyError> {
    let path = path.as_ref();
    if path.exists() {
        return load(path);
    }
    let parent = path.parent().ok_or_else(|| {
        KeyError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "checkpoint key path has no parent",
        ))
    })?;
    std::fs::create_dir_all(parent)?;
    restrict_directory(parent)?;

    let key = CheckpointKey::generate()?;
    let temporary = temporary_path(path, &key.verifying_key().to_bytes());
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    restrict_new_file(&mut options);
    let mut file = options.open(&temporary)?;
    file.write_all(&key.0.to_bytes())?;
    file.sync_all()?;
    drop(file);

    match std::fs::hard_link(&temporary, path) {
        Ok(()) => {
            std::fs::remove_file(&temporary)?;
            validate_metadata(path)?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(&temporary)?;
            load(path)
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            Err(KeyError::Io(error))
        }
    }
}

pub fn load(path: impl AsRef<Path>) -> Result<CheckpointKey, KeyError> {
    let path = path.as_ref();
    validate_metadata(path)?;
    let mut seed = [0_u8; 32];
    OpenOptions::new()
        .read(true)
        .open(path)?
        .read_exact(&mut seed)?;
    let key = CheckpointKey::from_seed(&seed);
    seed.zeroize();
    Ok(key)
}

fn validate_metadata(path: &Path) -> Result<(), KeyError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(KeyError::NotRegularFile);
    }
    if metadata.len() != 32 {
        return Err(KeyError::InvalidLength);
    }
    validate_permissions(&metadata)
}

fn temporary_path(path: &Path, public_key: &[u8; 32]) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let suffix = workflow_core::ContentDigest::of(public_key).to_string();
    path.with_file_name(format!(".{name}.{}.new", &suffix[..16]))
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
fn validate_permissions(metadata: &std::fs::Metadata) -> Result<(), KeyError> {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(KeyError::InsecurePermissions)
    }
}

#[cfg(windows)]
fn validate_permissions(_: &std::fs::Metadata) -> Result<(), KeyError> {
    Ok(())
}
