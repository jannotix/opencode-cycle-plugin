#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitChangeKind {
    Added,
    Copied,
    Deleted,
    Modified,
    Renamed,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChange {
    pub kind: GitChangeKind,
    pub path: String,
    pub previous_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitParseError {
    InvalidEncoding,
    MissingPath,
}

impl std::fmt::Display for GitParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidEncoding => "Git change output is not valid UTF-8",
            Self::MissingPath => "Git change output is missing a path",
        })
    }
}

impl std::error::Error for GitParseError {}

pub fn parse_name_status_z(input: &[u8]) -> Result<Vec<GitChange>, GitParseError> {
    let fields: Vec<_> = input
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(|field| std::str::from_utf8(field).map_err(|_| GitParseError::InvalidEncoding))
        .collect::<Result<_, _>>()?;
    let mut index = 0;
    let mut changes = Vec::new();
    while index < fields.len() {
        let status = fields[index];
        index += 1;
        let kind = match status.as_bytes().first().copied() {
            Some(b'A') => GitChangeKind::Added,
            Some(b'C') => GitChangeKind::Copied,
            Some(b'D') => GitChangeKind::Deleted,
            Some(b'M') => GitChangeKind::Modified,
            Some(b'R') => GitChangeKind::Renamed,
            Some(b'T') => GitChangeKind::TypeChanged,
            Some(b'U') => GitChangeKind::Unmerged,
            _ => GitChangeKind::Unknown,
        };
        if matches!(kind, GitChangeKind::Copied | GitChangeKind::Renamed) {
            let previous_path = fields.get(index).ok_or(GitParseError::MissingPath)?;
            let path = fields.get(index + 1).ok_or(GitParseError::MissingPath)?;
            changes.push(GitChange {
                kind,
                path: normalize(path),
                previous_path: Some(normalize(previous_path)),
            });
            index += 2;
        } else {
            let path = fields.get(index).ok_or(GitParseError::MissingPath)?;
            changes.push(GitChange {
                kind,
                path: normalize(path),
                previous_path: None,
            });
            index += 1;
        }
    }
    Ok(changes)
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}
