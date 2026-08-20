use std::{collections::BTreeMap, path::PathBuf};

use workflow_core::ContentDigest;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Platform {
    Windows,
    MacOs,
    Linux,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectIdentity(String);

impl ProjectIdentity {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub runtime: PathBuf,
    pub project: ProjectIdentity,
}

#[derive(Debug)]
pub enum PathError {
    MissingEnvironment(&'static str),
    NotAbsolute(PathBuf),
    Io(std::io::Error),
    InsideOpenCodeInstallation(PathBuf),
}

impl std::fmt::Display for PathError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingEnvironment(name) => {
                write!(formatter, "required environment variable {name} is missing")
            }
            Self::NotAbsolute(path) => {
                write!(formatter, "path must be absolute: {}", path.display())
            }
            Self::Io(error) => error.fmt(formatter),
            Self::InsideOpenCodeInstallation(path) => write!(
                formatter,
                "durable state cannot be stored inside an OpenCode installation: {}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for PathError {}

impl From<std::io::Error> for PathError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl DataPaths {
    pub fn resolve(
        platform: Platform,
        environment: &BTreeMap<String, String>,
        project_root: &std::path::Path,
        opencode_installations: &[PathBuf],
    ) -> Result<Self, PathError> {
        let root = data_root(platform, environment)?;
        require_absolute(&root)?;
        require_absolute(project_root)?;

        let physical_root = physical_path(&root)?;
        for installation in opencode_installations {
            require_absolute(installation)?;
            let physical_installation = physical_path(installation)?;
            if physical_root.starts_with(&physical_installation) {
                return Err(PathError::InsideOpenCodeInstallation(root));
            }
        }

        let canonical_project = std::fs::canonicalize(project_root)?;
        let project = project_identity(platform, &canonical_project);
        Ok(Self {
            database: root
                .join("projects")
                .join(project.as_str())
                .join("workflow.db"),
            runtime: root.join("runtime"),
            root,
            project,
        })
    }
}

fn data_root(
    platform: Platform,
    environment: &BTreeMap<String, String>,
) -> Result<PathBuf, PathError> {
    let value = |name: &'static str| {
        environment
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .ok_or(PathError::MissingEnvironment(name))
    };
    match platform {
        Platform::Windows => Ok(value("LOCALAPPDATA")?.join("OpenCode Cycle")),
        Platform::MacOs => Ok(value("HOME")?
            .join("Library")
            .join("Application Support")
            .join("OpenCode Cycle")),
        Platform::Linux => Ok(environment
            .get("XDG_DATA_HOME")
            .filter(|value| !value.trim().is_empty())
            .map_or_else(
                || value("HOME").map(|home| home.join(".local").join("share")),
                |path| Ok(PathBuf::from(path)),
            )?
            .join("opencode-cycle")),
    }
}

fn require_absolute(path: &std::path::Path) -> Result<(), PathError> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(PathError::NotAbsolute(path.to_path_buf()))
    }
}

fn physical_path(path: &std::path::Path) -> Result<PathBuf, std::io::Error> {
    let mut existing = path;
    let mut suffix = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "path has no existing ancestor",
            )
        })?;
        suffix.push(name.to_owned());
        existing = existing.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "path has no existing ancestor",
            )
        })?;
    }
    let mut resolved = std::fs::canonicalize(existing)?;
    for part in suffix.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

fn project_identity(platform: Platform, canonical_project: &std::path::Path) -> ProjectIdentity {
    let mut normalized = canonical_project.to_string_lossy().replace('\\', "/");
    if platform == Platform::Windows {
        normalized.make_ascii_lowercase();
    }
    ProjectIdentity(ContentDigest::of(normalized.as_bytes()).to_string())
}
