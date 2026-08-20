use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use workflow_core::{
    CandidateDigests, CandidateFile, CandidateFileKind, CandidateId, CandidateManifest,
    ContentDigest, EvidenceId,
};
use workflow_store::CandidateFilePayload;

const MAX_CANDIDATE_PAYLOAD_BYTES: usize = 128 * 1024 * 1024;
const DELIVERY_JOURNAL_DIRECTORY: &str = "opencode-cycle-delivery";
const LEGACY_DELIVERY_JOURNAL_DIRECTORY: &str = "opencode-workflow-delivery";
const DELIVERY_TEMPORARY_PREFIX: &str = ".opencode-cycle-";

struct RepositoryFs {
    root: Dir,
    #[cfg(unix)]
    sync: fs::File,
}

impl RepositoryFs {
    fn open(repository: &Path) -> Result<Self, CandidateFreezeError> {
        #[cfg(unix)]
        let sync = OpenOptions::new().read(true).open(repository)?;
        Ok(Self {
            root: Dir::open_ambient_dir(repository, ambient_authority())?,
            #[cfg(unix)]
            sync,
        })
    }

    fn metadata(&self, path: &str) -> Result<Option<cap_std::fs::Metadata>, CandidateFreezeError> {
        match self.root.symlink_metadata(path) {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn digest(&self, path: &str) -> Result<ContentDigest, CandidateFreezeError> {
        let metadata = self
            .metadata(path)?
            .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
            .ok_or(CandidateFreezeError::PayloadMismatch)?;
        let mut file = self.root.open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        if file.metadata()?.len() != metadata.len() {
            return Err(CandidateFreezeError::GitFailed(
                "candidate destination changed during read".to_owned(),
            ));
        }
        Ok(ContentDigest::from_bytes(hasher.finalize().into()))
    }

    fn remove_file_if_exists(&self, path: &str) -> Result<(), CandidateFreezeError> {
        match self.root.remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CandidateFreezeError::GitFailed(format!(
                "candidate delivery artifact removal failed for {path:?}: {error}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrozenCandidate {
    pub exact_diff: Vec<u8>,
    pub exact_files: Vec<CandidateFilePayload>,
    pub manifest: CandidateManifest,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct VerificationEnvironment {
    architecture: String,
    git: String,
    operating_system: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeliveryJournal {
    candidate_id: CandidateId,
    files: Vec<DeliveryJournalFile>,
    nonce: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct DeliveryJournalFile {
    approved_digest: Option<ContentDigest>,
    approved_executable: bool,
    original_digest: Option<ContentDigest>,
    original_directory: bool,
    original_executable: bool,
    path: String,
}

impl VerificationEnvironment {
    pub fn detect(repository: &Path) -> Result<Self, CandidateFreezeError> {
        Ok(Self {
            architecture: std::env::consts::ARCH.to_owned(),
            git: output_text(&git(repository, ["--version"])?)?,
            operating_system: std::env::consts::OS.to_owned(),
        })
    }

    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        ContentDigest::of(
            &serde_json::to_vec(self).expect("verification environments are serializable"),
        )
    }
}

#[derive(Debug)]
pub enum CandidateFreezeError {
    Core(workflow_core::CandidateError),
    DirtyWorktree,
    GitFailed(String),
    InvalidBaseRevision,
    InvalidRepository,
    Io(std::io::Error),
    Manifest(workflow_code_intel::ManifestError),
    NonUtf8Path,
    PayloadMismatch,
    PayloadTooLarge,
    UnsupportedExecutableMode,
    Serialization(serde_json::Error),
}

impl std::fmt::Display for CandidateFreezeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Core(error) => error.fmt(formatter),
            Self::DirtyWorktree => {
                formatter.write_str("candidate worktree must be clean before freezing")
            }
            Self::GitFailed(message) => {
                write!(formatter, "Git candidate operation failed: {message}")
            }
            Self::InvalidBaseRevision => {
                formatter.write_str("candidate base revision is invalid or not an ancestor")
            }
            Self::InvalidRepository => formatter.write_str("candidate root is not a Git worktree"),
            Self::Io(error) => error.fmt(formatter),
            Self::Manifest(error) => error.fmt(formatter),
            Self::NonUtf8Path => formatter.write_str("candidate path is not valid UTF-8"),
            Self::PayloadMismatch => {
                formatter.write_str("candidate payload does not match its immutable manifest")
            }
            Self::PayloadTooLarge => formatter.write_str("candidate payload exceeds 128 MiB"),
            Self::UnsupportedExecutableMode => formatter
                .write_str("executable candidate files are not supported on this operating system"),
            Self::Serialization(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for CandidateFreezeError {}

impl From<std::io::Error> for CandidateFreezeError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<workflow_core::CandidateError> for CandidateFreezeError {
    fn from(value: workflow_core::CandidateError) -> Self {
        Self::Core(value)
    }
}

impl From<workflow_code_intel::ManifestError> for CandidateFreezeError {
    fn from(value: workflow_code_intel::ManifestError) -> Self {
        Self::Manifest(value)
    }
}

impl From<serde_json::Error> for CandidateFreezeError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value)
    }
}

pub fn freeze(
    repository: &Path,
    base_revision: &str,
    candidate_id: CandidateId,
    evidence_ids: Vec<EvidenceId>,
) -> Result<FrozenCandidate, CandidateFreezeError> {
    let repository = repository.canonicalize()?;
    let discovered = PathBuf::from(output_text(&git(
        &repository,
        ["rev-parse", "--show-toplevel"],
    )?)?)
    .canonicalize()?;
    if discovered != repository {
        return Err(CandidateFreezeError::InvalidRepository);
    }
    require_clean(&repository)?;
    let resolved_base = output_text(&git(
        &repository,
        ["rev-parse", &format!("{base_revision}^{{commit}}")],
    )?)?;
    if resolved_base != base_revision
        || !git_status(
            &repository,
            ["merge-base", "--is-ancestor", base_revision, "HEAD"],
        )?
    {
        return Err(CandidateFreezeError::InvalidBaseRevision);
    }

    let exact_diff = git_stdout_bounded(
        &repository,
        [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--full-index",
            base_revision,
            "HEAD",
            "--",
        ],
        MAX_CANDIDATE_PAYLOAD_BYTES,
    )?;
    let changes = git(
        &repository,
        [
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            base_revision,
            "HEAD",
            "--",
        ],
    )?
    .stdout;
    let (files, exact_files) = candidate_files(&repository, &changes, exact_diff.len())?;
    let tracked = nul_fields(&git(&repository, ["ls-files", "-z"])?.stdout)?;
    let dependency_state_digest = selected_files_digest(&repository, &tracked, dependency_file)?;
    let configuration_digest = selected_files_digest(&repository, &tracked, configuration_file)?;
    let environment_digest = VerificationEnvironment::detect(&repository)?.digest();
    let manifest = CandidateManifest::new(
        candidate_id,
        Some(base_revision.to_owned()),
        files,
        CandidateDigests {
            configuration: configuration_digest,
            dependency_state: dependency_state_digest,
            diff: ContentDigest::of(&exact_diff),
            environment: environment_digest,
        },
        evidence_ids,
    )?
    .with_delivery_payload_digest(Some(payload_digest(&exact_files)?));
    validate_platform_modes(&repository, &manifest)?;
    require_clean(&repository)?;
    Ok(FrozenCandidate {
        exact_diff,
        exact_files,
        manifest,
    })
}

pub fn verify_frozen(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
) -> Result<bool, CandidateFreezeError> {
    let Some(base_revision) = manifest.base_revision() else {
        return Err(CandidateFreezeError::InvalidBaseRevision);
    };
    let observed = freeze(
        repository,
        base_revision,
        manifest.candidate_id(),
        manifest.evidence_ids().to_vec(),
    )?;
    Ok(observed.manifest == *manifest
        && observed.exact_diff == exact_diff
        && observed.exact_files == exact_files)
}

pub fn promote(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
) -> Result<Vec<String>, CandidateFreezeError> {
    promote_bound(
        repository,
        manifest,
        exact_diff,
        exact_files,
        None,
        |_, _| Ok(()),
    )
    .map(|(paths, _)| paths)
}

pub fn promote_bound<F>(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
    expected_journal_digest: Option<ContentDigest>,
    bind_journal: F,
) -> Result<(Vec<String>, ContentDigest), CandidateFreezeError>
where
    F: FnOnce(Option<ContentDigest>, ContentDigest) -> Result<(), CandidateFreezeError>,
{
    let repository = repository.canonicalize()?;
    let discovered = PathBuf::from(output_text(&git(
        &repository,
        ["rev-parse", "--show-toplevel"],
    )?)?)
    .canonicalize()?;
    if discovered != repository {
        return Err(CandidateFreezeError::InvalidRepository);
    }
    let base_revision = manifest
        .base_revision()
        .ok_or(CandidateFreezeError::InvalidBaseRevision)?;
    let head = output_text(&git(&repository, ["rev-parse", "HEAD"])?)?;
    if head != base_revision {
        return Err(CandidateFreezeError::InvalidBaseRevision);
    }
    validate_platform_modes(&repository, manifest)?;
    validate_payload(manifest, exact_diff, exact_files)?;
    let journal_digest = apply_payload(
        &repository,
        manifest,
        exact_diff,
        exact_files,
        expected_journal_digest,
        bind_journal,
    )?;
    Ok((
        manifest
            .files()
            .iter()
            .map(|file| file.path.clone())
            .collect(),
        journal_digest,
    ))
}

#[cfg(test)]
fn verify_promoted(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
) -> Result<bool, CandidateFreezeError> {
    verify_promoted_fs(&RepositoryFs::open(repository)?, manifest, exact_files)
}

fn verify_promoted_fs(
    repository: &RepositoryFs,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
) -> Result<bool, CandidateFreezeError> {
    let modes: BTreeMap<_, _> = exact_files
        .iter()
        .map(|file| (file.path(), file.is_executable()))
        .collect();
    for file in manifest.files() {
        let metadata = repository.metadata(&file.path)?;
        match file.kind {
            CandidateFileKind::Deleted
                if metadata.as_ref().is_some_and(|value| value.is_dir())
                    && manifest.files().iter().any(|other| {
                        !matches!(other.kind, CandidateFileKind::Deleted)
                            && other.path.starts_with(&format!("{}/", file.path))
                    }) => {}
            CandidateFileKind::Deleted if metadata.is_some() => return Ok(false),
            CandidateFileKind::Deleted => {}
            CandidateFileKind::Added
            | CandidateFileKind::Generated
            | CandidateFileKind::Modified => {
                if !metadata.is_some_and(|metadata| metadata.file_type().is_file())
                    || repository.digest(&file.path)? != file.digest.expect("validated")
                    || !executable_matches_cap(
                        repository,
                        &file.path,
                        *modes
                            .get(file.path.as_str())
                            .ok_or(CandidateFreezeError::PayloadMismatch)?,
                    )?
                {
                    return Ok(false);
                }
            }
        }
    }
    Ok(true)
}

fn validate_payload(
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
) -> Result<(), CandidateFreezeError> {
    if !payload_size_allowed(
        std::iter::once(exact_diff.len())
            .chain(exact_files.iter().map(|file| file.content().len())),
    ) {
        return Err(CandidateFreezeError::PayloadTooLarge);
    }
    if ContentDigest::of(exact_diff) != manifest.diff_digest() {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    if manifest.delivery_payload_digest() != Some(payload_digest(exact_files)?) {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    let expected: BTreeMap<_, _> = manifest
        .files()
        .iter()
        .filter_map(|file| {
            if matches!(file.kind, CandidateFileKind::Deleted) {
                None
            } else {
                Some((
                    file.path.as_str(),
                    (file.digest.expect("validated manifest"), file.executable),
                ))
            }
        })
        .collect();
    let mut observed = BTreeMap::new();
    for file in exact_files {
        if observed
            .insert(
                file.path(),
                (ContentDigest::of(file.content()), file.is_executable()),
            )
            .is_some()
        {
            return Err(CandidateFreezeError::PayloadMismatch);
        }
    }
    if observed == expected {
        Ok(())
    } else {
        Err(CandidateFreezeError::PayloadMismatch)
    }
}

fn payload_size_allowed(lengths: impl IntoIterator<Item = usize>) -> bool {
    lengths
        .into_iter()
        .try_fold(0_usize, usize::checked_add)
        .is_some_and(|total| total <= MAX_CANDIDATE_PAYLOAD_BYTES)
}

fn payload_digest(
    exact_files: &[CandidateFilePayload],
) -> Result<ContentDigest, CandidateFreezeError> {
    let entries: Vec<_> = exact_files
        .iter()
        .map(|file| {
            (
                file.path(),
                ContentDigest::of(file.content()).to_string(),
                file.is_executable(),
            )
        })
        .collect();
    Ok(ContentDigest::of(&serde_json::to_vec(&entries)?))
}

fn apply_payload<F>(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
    expected_journal_digest: Option<ContentDigest>,
    bind_journal: F,
) -> Result<ContentDigest, CandidateFreezeError>
where
    F: FnOnce(Option<ContentDigest>, ContentDigest) -> Result<(), CandidateFreezeError>,
{
    let repository_fs = RepositoryFs::open(repository)?;
    let git_directory = PathBuf::from(output_text(&git(
        repository,
        ["rev-parse", "--absolute-git-dir"],
    )?)?);
    let journal_root = git_directory.join(DELIVERY_JOURNAL_DIRECTORY);
    fs::create_dir_all(&journal_root)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(journal_root.join("promotion.lock"))?;
    lock.lock().map_err(|error| {
        CandidateFreezeError::GitFailed(format!("candidate promotion lock failed: {error}"))
    })?;
    let journal_path = journal_root.join(format!("{}.json", manifest.candidate_id()));
    let committed_path = journal_root.join(format!("{}.committed", manifest.candidate_id()));
    recover_legacy_delivery(
        &repository_fs,
        manifest,
        exact_files,
        &git_directory,
        expected_journal_digest,
        &journal_path,
        &committed_path,
    )?;
    recover_delivery_bound(
        &repository_fs,
        manifest,
        exact_files,
        &journal_path,
        &committed_path,
        expected_journal_digest,
    )?;
    if verify_promoted_fs(&repository_fs, manifest, exact_files)? {
        let journal_digest = expected_journal_digest
            .or_else(|| manifest.delivery_payload_digest())
            .ok_or(CandidateFreezeError::PayloadMismatch)?;
        bind_journal(expected_journal_digest, journal_digest)?;
        return Ok(journal_digest);
    }
    git_apply_check(repository, exact_diff)?;
    validate_preimage(repository, &repository_fs, manifest)?;
    let journal = capture_journal(repository, &repository_fs, manifest)?;
    let journal_digest = delivery_journal_digest(&journal)?;
    bind_journal(expected_journal_digest, journal_digest)?;
    write_journal(&journal_path, &journal)?;
    git_apply_check(repository, exact_diff)?;
    let result = apply_payload_staged(
        &repository_fs,
        manifest,
        exact_files,
        &journal,
        &journal_path,
        &committed_path,
    );
    if result.is_ok() {
        if let Err(error) = write_committed_marker(&committed_path) {
            rollback_payload(&repository_fs, &journal, &journal_path, &committed_path)?;
            return Err(error);
        }
        cleanup_delivery(&repository_fs, &journal, &journal_path, &committed_path)?;
    }
    result.map(|()| journal_digest)
}

fn validate_preimage(
    repository: &Path,
    repository_fs: &RepositoryFs,
    manifest: &CandidateManifest,
) -> Result<(), CandidateFreezeError> {
    let base = manifest
        .base_revision()
        .ok_or(CandidateFreezeError::InvalidBaseRevision)?;
    for file in manifest.files() {
        match file.kind {
            CandidateFileKind::Modified | CandidateFileKind::Deleted => {
                let (executable, object_id) = git_tree_entry_at(repository, base, &file.path)?;
                let metadata = repository_fs.metadata(&file.path)?;
                if !metadata.is_some_and(|value| value.is_file())
                    || !git_preimage_matches(
                        repository,
                        base,
                        &file.path,
                        &object_id,
                        repository_fs.digest(&file.path)?,
                    )?
                    || !executable_matches_cap(repository_fs, &file.path, executable)?
                {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination does not match its approved base".to_owned(),
                    ));
                }
            }
            CandidateFileKind::Added | CandidateFileKind::Generated => {
                if let Some(metadata) = repository_fs.metadata(&file.path)?
                    && !(metadata.is_dir()
                        && manifest.files().iter().any(|other| {
                            matches!(other.kind, CandidateFileKind::Deleted)
                                && other.path.starts_with(&format!("{}/", file.path))
                        }))
                {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination already exists".to_owned(),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn apply_payload_staged(
    repository_fs: &RepositoryFs,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
    journal: &DeliveryJournal,
    journal_path: &Path,
    committed_path: &Path,
) -> Result<(), CandidateFreezeError> {
    let payload: BTreeMap<_, _> = exact_files
        .iter()
        .map(|file| (file.path(), file.content()))
        .collect();

    for (index, file) in manifest.files().iter().enumerate() {
        validate_destination(repository_fs, manifest, &file.path)?;
        if let Some(content) = payload.get(file.path.as_str()) {
            let incoming = adjacent_delivery_path(journal, "incoming", index);
            write_new_file(repository_fs, &incoming, content)?;
            let exact = exact_files
                .iter()
                .find(|exact| exact.path() == file.path)
                .ok_or(CandidateFreezeError::PayloadMismatch)?;
            set_executable_cap(repository_fs, &incoming, exact.is_executable())?;
        }
    }

    let applied = (|| {
        let mut indices: Vec<_> = (0..manifest.files().len()).collect();
        indices.sort_unstable_by_key(|index| {
            std::cmp::Reverse(manifest.files()[*index].path.matches('/').count())
        });
        for index in indices {
            let file = &manifest.files()[index];
            validate_destination(repository_fs, manifest, &file.path)?;
            let metadata = repository_fs.metadata(&file.path)?;
            if metadata.as_ref().is_some_and(|value| value.is_file()) {
                let backup = adjacent_delivery_path(journal, "backup", index);
                if repository_fs.metadata(&backup)?.is_some() {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate delivery backup collision".to_owned(),
                    ));
                }
                repository_fs
                    .root
                    .rename(&file.path, &repository_fs.root, &backup)?;
                if !matches_snapshot_cap(repository_fs, &backup, &journal.files[index])? {
                    if repository_fs.metadata(&file.path)?.is_none() {
                        repository_fs
                            .root
                            .rename(&backup, &repository_fs.root, &file.path)?;
                    }
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination changed during promotion".to_owned(),
                    ));
                }
                sync_repository(repository_fs)?;
            } else if metadata.as_ref().is_some_and(|value| value.is_dir()) {
                if !journal.files[index].original_directory {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination was concurrently recreated as a directory"
                            .to_owned(),
                    ));
                }
                let opened = repository_fs.root.open_dir(&file.path)?;
                if opened.entries()?.next().is_some() {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination directory changed during promotion".to_owned(),
                    ));
                }
                opened.remove_open_dir()?;
                sync_repository(repository_fs)?;
            }
        }
        let deleted_paths: std::collections::BTreeSet<_> = manifest
            .files()
            .iter()
            .filter(|file| matches!(file.kind, CandidateFileKind::Deleted))
            .map(|file| file.path.as_str())
            .collect();
        for file in manifest.files() {
            if matches!(file.kind, CandidateFileKind::Deleted) {
                continue;
            }
            let mut parent = Path::new(&file.path).parent().map(Path::to_path_buf);
            while let Some(directory) = parent {
                if directory.as_os_str().is_empty() {
                    break;
                }
                let relative = directory.to_string_lossy().replace('\\', "/");
                if deleted_paths.contains(relative.as_str()) {
                    parent = directory.parent().map(Path::to_path_buf);
                    continue;
                }
                if repository_fs.metadata(&relative)?.is_none() {
                    repository_fs.root.create_dir(&relative)?;
                }
                parent = directory.parent().map(Path::to_path_buf);
            }
        }
        for (index, file) in manifest.files().iter().enumerate() {
            if !matches!(file.kind, CandidateFileKind::Deleted) {
                if let Some(parent) = Path::new(&file.path).parent()
                    && !parent.as_os_str().is_empty()
                {
                    repository_fs.root.create_dir_all(parent)?;
                }
                validate_destination(repository_fs, manifest, &file.path)?;
                let incoming = adjacent_delivery_path(journal, "incoming", index);
                match repository_fs
                    .root
                    .hard_link(&incoming, &repository_fs.root, &file.path)
                {
                    Ok(()) => repository_fs.root.remove_file(&incoming).map_err(|error| {
                        CandidateFreezeError::GitFailed(format!(
                            "candidate incoming cleanup failed for {:?}: {error}",
                            file.path
                        ))
                    })?,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        return Err(CandidateFreezeError::GitFailed(
                            "candidate destination was concurrently recreated".to_owned(),
                        ));
                    }
                    Err(error) => {
                        return Err(CandidateFreezeError::GitFailed(format!(
                            "candidate no-clobber install failed for {:?}: {error}",
                            file.path
                        )));
                    }
                }
                sync_repository(repository_fs)?;
            }
        }
        if verify_promoted_fs(repository_fs, manifest, exact_files)? {
            Ok(())
        } else {
            Err(CandidateFreezeError::PayloadMismatch)
        }
    })();
    if let Err(error) = applied {
        rollback_payload(repository_fs, journal, journal_path, committed_path).map_err(
            |rollback| {
                CandidateFreezeError::GitFailed(format!(
                    "candidate delivery failed ({error}); rollback failed ({rollback})"
                ))
            },
        )?;
        return Err(error);
    }
    Ok(())
}

fn rollback_payload(
    repository_fs: &RepositoryFs,
    journal: &DeliveryJournal,
    journal_path: &Path,
    committed_path: &Path,
) -> Result<(), CandidateFreezeError> {
    let mut indices: Vec<_> = (0..journal.files.len()).collect();
    indices.sort_unstable_by_key(|index| journal.files[*index].path.matches('/').count());
    for index in indices.iter().copied() {
        let file = &journal.files[index];
        let incoming = adjacent_delivery_path(journal, "incoming", index);
        if let Some(metadata) = repository_fs.metadata(&file.path)? {
            if metadata.is_file() {
                if matches_snapshot_cap(repository_fs, &file.path, file)? {
                } else if matches_approved_cap(repository_fs, &file.path, file)? {
                    repository_fs.root.remove_file(&file.path)?;
                } else {
                    preserve_concurrent(repository_fs, journal, index, &file.path)?;
                }
            } else if metadata.is_dir() && !file.original_directory {
                let approved_descendants = journal.files.iter().any(|other| {
                    other.approved_digest.is_some()
                        && other.path.starts_with(&format!("{}/", file.path))
                });
                if approved_descendants {
                    match repository_fs.root.remove_dir(&file.path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    return Err(CandidateFreezeError::GitFailed(
                        "concurrent candidate directory was preserved".to_owned(),
                    ));
                }
            }
        }
        repository_fs.remove_file_if_exists(&incoming)?;
    }
    indices.sort_unstable_by_key(|index| journal.files[*index].path.matches('/').count());
    for index in indices.iter().copied().rev() {
        let file = &journal.files[index];
        if !file.original_directory {
            let approved_descendants = journal.files.iter().any(|other| {
                other.approved_digest.is_some()
                    && other.path.starts_with(&format!("{}/", file.path))
            });
            if approved_descendants
                && repository_fs
                    .metadata(&file.path)?
                    .is_some_and(|metadata| metadata.is_dir())
            {
                repository_fs.root.remove_dir(&file.path)?;
            }
        }
    }
    for index in indices {
        let file = &journal.files[index];
        let backup = adjacent_delivery_path(journal, "backup", index);
        if file.original_directory {
            if repository_fs.metadata(&file.path)?.is_none() {
                repository_fs.root.create_dir_all(&file.path)?;
            }
        } else if repository_fs.metadata(&backup)?.is_some() {
            if !matches_snapshot_cap(repository_fs, &backup, file)? {
                if repository_fs.metadata(&file.path)?.is_none() {
                    if let Some(parent) = Path::new(&file.path).parent()
                        && !parent.as_os_str().is_empty()
                    {
                        repository_fs.root.create_dir_all(parent)?;
                    }
                    repository_fs
                        .root
                        .hard_link(&backup, &repository_fs.root, &file.path)?;
                    sync_repository(repository_fs)?;
                }
                return Err(CandidateFreezeError::GitFailed(
                    "candidate delivery backup no longer matches its journal".to_owned(),
                ));
            }
            if repository_fs.metadata(&file.path)?.is_none() {
                if let Some(parent) = Path::new(&file.path).parent()
                    && !parent.as_os_str().is_empty()
                {
                    repository_fs.root.create_dir_all(parent)?;
                }
                repository_fs
                    .root
                    .hard_link(&backup, &repository_fs.root, &file.path)?;
            } else if !matches_snapshot_cap(repository_fs, &file.path, file)? {
                return Err(CandidateFreezeError::GitFailed(
                    "candidate destination was concurrently recreated during rollback".to_owned(),
                ));
            }
            repository_fs.root.remove_file(&backup)?;
        }
    }
    sync_repository(repository_fs)?;
    remove_if_exists(journal_path)?;
    remove_if_exists(committed_path)?;
    Ok(())
}

fn capture_journal(
    repository_path: &Path,
    repository: &RepositoryFs,
    manifest: &CandidateManifest,
) -> Result<DeliveryJournal, CandidateFreezeError> {
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| {
        CandidateFreezeError::GitFailed("operating-system entropy is unavailable".to_owned())
    })?;
    let mut files = Vec::with_capacity(manifest.files().len());
    let base = manifest
        .base_revision()
        .ok_or(CandidateFreezeError::InvalidBaseRevision)?;
    for file in manifest.files() {
        validate_destination(repository, manifest, &file.path)?;
        let original = match file.kind {
            CandidateFileKind::Modified | CandidateFileKind::Deleted => {
                let (executable, object_id) = git_tree_entry_at(repository_path, base, &file.path)?;
                let digest = repository.digest(&file.path)?;
                if !git_preimage_matches(repository_path, base, &file.path, &object_id, digest)? {
                    return Err(CandidateFreezeError::GitFailed(
                        "candidate destination does not match its approved base".to_owned(),
                    ));
                }
                Some((digest, executable))
            }
            CandidateFileKind::Added | CandidateFileKind::Generated => None,
        };
        files.push(DeliveryJournalFile {
            approved_digest: file.digest,
            approved_executable: file.executable,
            original_digest: original.map(|value| value.0),
            original_directory: original.is_none()
                && manifest.files().iter().any(|other| {
                    matches!(other.kind, CandidateFileKind::Deleted)
                        && other.path.starts_with(&format!("{}/", file.path))
                }),
            original_executable: original.is_some_and(|value| value.1),
            path: file.path.clone(),
        });
    }
    Ok(DeliveryJournal {
        candidate_id: manifest.candidate_id(),
        files,
        nonce: nonce.iter().map(|byte| format!("{byte:02x}")).collect(),
    })
}

fn write_journal(path: &Path, journal: &DeliveryJournal) -> Result<(), CandidateFreezeError> {
    let encoded = serde_json::to_vec(journal)?;
    let temporary = path.with_extension("json.tmp");
    remove_if_exists(&temporary)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        drop(file);
        fs::hard_link(&temporary, path).map_err(|error| {
            CandidateFreezeError::GitFailed(format!(
                "candidate delivery journal publication failed: {error}"
            ))
        })?;
        sync_parent(path)?;
        fs::remove_file(&temporary).map_err(|error| {
            CandidateFreezeError::GitFailed(format!(
                "candidate journal temporary cleanup failed: {error}"
            ))
        })?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = remove_if_exists(&temporary);
    }
    result
}

fn delivery_journal_digest(
    journal: &DeliveryJournal,
) -> Result<ContentDigest, CandidateFreezeError> {
    Ok(ContentDigest::of(&serde_json::to_vec(journal)?))
}

fn write_committed_marker(path: &Path) -> Result<(), CandidateFreezeError> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            CandidateFreezeError::GitFailed(format!("candidate committed marker failed: {error}"))
        })?;
    file.sync_all()?;
    sync_parent(path)
}

fn journal_matches_manifest(journal: &DeliveryJournal, manifest: &CandidateManifest) -> bool {
    journal.candidate_id == manifest.candidate_id()
        && journal.nonce.len() == 32
        && journal
            .nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && journal.files.len() == manifest.files().len()
        && journal
            .files
            .iter()
            .zip(manifest.files())
            .all(|(saved, approved)| {
                safe_relative_path(&saved.path)
                    && saved.path == approved.path
                    && saved.approved_digest == approved.digest
                    && saved.approved_executable == approved.executable
            })
}

fn safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn recover_delivery_bound(
    repository_fs: &RepositoryFs,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
    journal_path: &Path,
    committed_path: &Path,
    expected_journal_digest: Option<ContentDigest>,
) -> Result<(), CandidateFreezeError> {
    if !journal_path.exists() {
        if committed_path.exists() {
            if !verify_promoted_fs(repository_fs, manifest, exact_files)? {
                return Err(CandidateFreezeError::GitFailed(
                    "committed candidate delivery no longer verifies".to_owned(),
                ));
            }
            remove_if_exists(committed_path)?;
        }
        return Ok(());
    }
    let encoded = fs::read(journal_path)?;
    if expected_journal_digest != Some(ContentDigest::of(&encoded)) {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    let journal: DeliveryJournal = serde_json::from_slice(&encoded)?;
    if !journal_matches_manifest(&journal, manifest) {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    if committed_path.exists() {
        if !verify_promoted_fs(repository_fs, manifest, exact_files)? {
            return Err(CandidateFreezeError::GitFailed(
                "committed candidate delivery no longer verifies".to_owned(),
            ));
        }
        cleanup_delivery(repository_fs, &journal, journal_path, committed_path)
    } else {
        rollback_payload(repository_fs, &journal, journal_path, committed_path)
    }
}

fn recover_legacy_delivery(
    repository_fs: &RepositoryFs,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
    git_directory: &Path,
    expected_journal_digest: Option<ContentDigest>,
    current_journal_path: &Path,
    current_committed_path: &Path,
) -> Result<(), CandidateFreezeError> {
    let legacy_root = git_directory.join(LEGACY_DELIVERY_JOURNAL_DIRECTORY);
    let legacy_journal_path = legacy_root.join(format!("{}.json", manifest.candidate_id()));
    let legacy_committed_path = legacy_root.join(format!("{}.committed", manifest.candidate_id()));
    if !legacy_journal_path.exists() && !legacy_committed_path.exists() {
        return Ok(());
    }
    if current_journal_path.exists() || current_committed_path.exists() {
        return Err(CandidateFreezeError::GitFailed(
            "legacy and current candidate delivery journals coexist".to_owned(),
        ));
    }
    recover_delivery_bound(
        repository_fs,
        manifest,
        exact_files,
        &legacy_journal_path,
        &legacy_committed_path,
        expected_journal_digest,
    )
}

#[cfg(test)]
fn recover_delivery(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_files: &[CandidateFilePayload],
    journal_path: &Path,
    committed_path: &Path,
) -> Result<(), CandidateFreezeError> {
    let expected = journal_path
        .exists()
        .then(|| fs::read(journal_path).map(|bytes| ContentDigest::of(&bytes)))
        .transpose()?;
    recover_delivery_bound(
        &RepositoryFs::open(repository)?,
        manifest,
        exact_files,
        journal_path,
        committed_path,
        expected,
    )
}

fn cleanup_delivery(
    repository: &RepositoryFs,
    journal: &DeliveryJournal,
    journal_path: &Path,
    committed_path: &Path,
) -> Result<(), CandidateFreezeError> {
    for (index, file) in journal.files.iter().enumerate() {
        let _ = file;
        repository.remove_file_if_exists(&adjacent_delivery_path(journal, "backup", index))?;
        repository.remove_file_if_exists(&adjacent_delivery_path(journal, "incoming", index))?;
    }
    remove_if_exists(journal_path)?;
    sync_parent(journal_path)?;
    remove_if_exists(committed_path)?;
    sync_parent(committed_path)?;
    Ok(())
}

fn adjacent_delivery_path(journal: &DeliveryJournal, kind: &str, index: usize) -> String {
    format!(
        "{DELIVERY_TEMPORARY_PREFIX}{}-{}-{kind}-{index}",
        journal.candidate_id, journal.nonce,
    )
}

fn write_new_file(
    repository: &RepositoryFs,
    path: &str,
    content: &[u8],
) -> Result<(), CandidateFreezeError> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    let mut file = repository.root.open_with(path, &options).map_err(|error| {
        CandidateFreezeError::GitFailed(format!(
            "candidate staging open failed for {path:?}: {error}"
        ))
    })?;
    file.write_all(content).map_err(|error| {
        CandidateFreezeError::GitFailed(format!(
            "candidate staging write failed for {path:?}: {error}"
        ))
    })?;
    file.sync_all().map_err(|error| {
        CandidateFreezeError::GitFailed(format!(
            "candidate staging sync failed for {path:?}: {error}"
        ))
    })?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), CandidateFreezeError> {
    OpenOptions::new()
        .read(true)
        .open(path.parent().expect("durable file has a parent"))?
        .sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> Result<(), CandidateFreezeError> {
    Ok(())
}

fn matches_snapshot_cap(
    repository: &RepositoryFs,
    path: &str,
    snapshot: &DeliveryJournalFile,
) -> Result<bool, CandidateFreezeError> {
    Ok(snapshot
        .original_digest
        .is_some_and(|digest| repository.digest(path).is_ok_and(|value| value == digest))
        && executable_matches_cap(repository, path, snapshot.original_executable)?)
}

fn matches_approved_cap(
    repository: &RepositoryFs,
    path: &str,
    snapshot: &DeliveryJournalFile,
) -> Result<bool, CandidateFreezeError> {
    let Some(digest) = snapshot.approved_digest else {
        return Ok(false);
    };
    Ok(repository
        .metadata(path)?
        .is_some_and(|metadata| metadata.is_file())
        && repository.digest(path)? == digest
        && executable_matches_cap(repository, path, snapshot.approved_executable)?)
}

fn preserve_concurrent(
    repository: &RepositoryFs,
    journal: &DeliveryJournal,
    index: usize,
    target: &str,
) -> Result<(), CandidateFreezeError> {
    let preserved = adjacent_delivery_path(journal, "concurrent", index);
    repository
        .root
        .hard_link(target, &repository.root, &preserved)
        .map_err(|error| {
            CandidateFreezeError::GitFailed(format!(
                "concurrent candidate destination could not be preserved: {error}"
            ))
        })?;
    repository.root.remove_file(target)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), CandidateFreezeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(Into::into)
        }
        Ok(_) => Err(CandidateFreezeError::GitFailed(
            "candidate delivery artifact is not a regular file".to_owned(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_destination(
    repository: &RepositoryFs,
    manifest: &CandidateManifest,
    relative: &str,
) -> Result<(), CandidateFreezeError> {
    let mut components = relative.split('/').peekable();
    let mut prefix = String::new();
    while let Some(component) = components.next() {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        let metadata = match repository.metadata(&prefix)? {
            Some(metadata) => metadata,
            None => continue,
        };
        if metadata.file_type().is_symlink()
            || components.peek().is_some()
                && !metadata.file_type().is_dir()
                && !manifest.files().iter().any(|file| {
                    file.path == prefix && matches!(file.kind, CandidateFileKind::Deleted)
                })
            || components.peek().is_none()
                && !metadata.file_type().is_file()
                && !metadata.file_type().is_dir()
        {
            return Err(CandidateFreezeError::PayloadMismatch);
        }
    }
    Ok(())
}

fn git_apply_check(repository: &Path, exact_diff: &[u8]) -> Result<(), CandidateFreezeError> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repository)
        .args(["apply", "--binary", "--whitespace=nowarn"]);
    command.arg("--check");
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| CandidateFreezeError::GitFailed("Git stdin is unavailable".to_owned()))?
        .write_all(exact_diff)?;
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CandidateFreezeError::GitFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

fn candidate_files(
    repository: &Path,
    encoded: &[u8],
    exact_diff_bytes: usize,
) -> Result<(Vec<CandidateFile>, Vec<CandidateFilePayload>), CandidateFreezeError> {
    let fields = nul_fields(encoded)?;
    if fields.len() % 2 != 0 {
        return Err(CandidateFreezeError::GitFailed(
            "Git returned a malformed change list".to_owned(),
        ));
    }
    let mut payload_bytes = exact_diff_bytes;
    let mut tree_entries = BTreeMap::new();
    for pair in fields.chunks_exact(2) {
        if pair[0] != "D" {
            let entry = git_tree_entry(repository, &pair[1])?;
            let size = output_text(&git(repository, ["cat-file", "-s", &entry.1])?)?
                .parse::<u64>()
                .map_err(|_| CandidateFreezeError::PayloadMismatch)?;
            payload_bytes = payload_bytes
                .checked_add(
                    usize::try_from(size).map_err(|_| CandidateFreezeError::PayloadTooLarge)?,
                )
                .ok_or(CandidateFreezeError::PayloadTooLarge)?;
            if payload_bytes > MAX_CANDIDATE_PAYLOAD_BYTES {
                return Err(CandidateFreezeError::PayloadTooLarge);
            }
            tree_entries.insert(pair[1].clone(), entry);
        }
    }
    let mut files = Vec::with_capacity(fields.len() / 2);
    let mut exact_files = Vec::with_capacity(fields.len() / 2);
    let mut remaining = MAX_CANDIDATE_PAYLOAD_BYTES - exact_diff_bytes;
    for pair in fields.chunks_exact(2) {
        let kind = match pair[0].as_str() {
            "A" if generated_path(&pair[1]) => CandidateFileKind::Generated,
            "A" => CandidateFileKind::Added,
            "D" => CandidateFileKind::Deleted,
            _ => CandidateFileKind::Modified,
        };
        let (digest, executable) = if matches!(kind, CandidateFileKind::Deleted) {
            (None, false)
        } else {
            let (executable, object_id) = tree_entries
                .get(&pair[1])
                .ok_or(CandidateFreezeError::PayloadMismatch)?;
            let content = git_stdout_bounded(
                repository,
                ["cat-file", "blob", object_id.as_str()],
                remaining,
            )?;
            remaining = remaining
                .checked_sub(content.len())
                .ok_or(CandidateFreezeError::PayloadTooLarge)?;
            let digest = ContentDigest::of(&content);
            let executable = *executable;
            exact_files.push(CandidateFilePayload::with_executable(
                pair[1].clone(),
                content,
                executable,
            ));
            (Some(digest), executable)
        };
        files.push(CandidateFile::new(pair[1].clone(), digest, kind)?.with_executable(executable));
    }
    exact_files.sort_unstable_by(|left, right| left.path().cmp(right.path()));
    Ok((files, exact_files))
}

fn git_tree_entry(repository: &Path, path: &str) -> Result<(bool, String), CandidateFreezeError> {
    git_tree_entry_at(repository, "HEAD", path)
}

fn git_tree_entry_at(
    repository: &Path,
    revision: &str,
    path: &str,
) -> Result<(bool, String), CandidateFreezeError> {
    let output = git(repository, ["ls-tree", "-z", revision, "--", path])?.stdout;
    let entry = output
        .strip_suffix(&[0])
        .ok_or(CandidateFreezeError::PayloadMismatch)?;
    let tab = entry
        .iter()
        .position(|byte| *byte == b'\t')
        .ok_or(CandidateFreezeError::PayloadMismatch)?;
    let (metadata, observed_path) = (&entry[..tab], &entry[tab + 1..]);
    if observed_path != path.as_bytes() {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    let fields: Vec<_> = metadata.split(|byte| *byte == b' ').collect();
    if fields.len() != 3 || fields[1] != b"blob" {
        return Err(CandidateFreezeError::PayloadMismatch);
    }
    let executable = match fields[0] {
        b"100644" => false,
        b"100755" => true,
        _ => return Err(CandidateFreezeError::PayloadMismatch),
    };
    let object_id = std::str::from_utf8(fields[2])
        .map_err(|_| CandidateFreezeError::PayloadMismatch)?
        .to_owned();
    Ok((executable, object_id))
}

#[cfg(windows)]
fn validate_platform_modes(
    repository: &Path,
    manifest: &CandidateManifest,
) -> Result<(), CandidateFreezeError> {
    let base = manifest
        .base_revision()
        .ok_or(CandidateFreezeError::InvalidBaseRevision)?;
    for file in manifest.files() {
        match file.kind {
            CandidateFileKind::Added | CandidateFileKind::Generated if file.executable => {
                return Err(CandidateFreezeError::UnsupportedExecutableMode);
            }
            CandidateFileKind::Modified => {
                let (base_executable, _) = git_tree_entry_at(repository, base, &file.path)?;
                if base_executable != file.executable {
                    return Err(CandidateFreezeError::UnsupportedExecutableMode);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn validate_platform_modes(
    _repository: &Path,
    _manifest: &CandidateManifest,
) -> Result<(), CandidateFreezeError> {
    Ok(())
}

#[cfg(unix)]
fn set_executable_cap(
    repository: &RepositoryFs,
    path: &str,
    executable: bool,
) -> Result<(), CandidateFreezeError> {
    use cap_std::fs::PermissionsExt;

    let file = repository.root.open(path)?;
    let mut permissions = file.metadata()?.permissions();
    permissions.set_mode(if executable { 0o755 } else { 0o644 });
    file.set_permissions(permissions)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable_cap(
    _repository: &RepositoryFs,
    _path: &str,
    _executable: bool,
) -> Result<(), CandidateFreezeError> {
    Ok(())
}

pub fn delivery_recovery_required(
    repository: &Path,
    candidate_id: CandidateId,
) -> Result<bool, CandidateFreezeError> {
    let git_directory = PathBuf::from(output_text(&git(
        repository,
        ["rev-parse", "--absolute-git-dir"],
    )?)?);
    for directory in [
        DELIVERY_JOURNAL_DIRECTORY,
        LEGACY_DELIVERY_JOURNAL_DIRECTORY,
    ] {
        let root = git_directory.join(directory);
        if root.join(format!("{candidate_id}.json")).try_exists()?
            || root
                .join(format!("{candidate_id}.committed"))
                .try_exists()?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(unix)]
fn executable_matches_cap(
    repository: &RepositoryFs,
    path: &str,
    expected: bool,
) -> Result<bool, CandidateFreezeError> {
    use cap_std::fs::PermissionsExt;

    Ok((repository.root.open(path)?.metadata()?.permissions().mode() & 0o111 != 0) == expected)
}

#[cfg(not(unix))]
fn executable_matches_cap(
    _repository: &RepositoryFs,
    _path: &str,
    _expected: bool,
) -> Result<bool, CandidateFreezeError> {
    Ok(true)
}

#[cfg(unix)]
fn sync_repository(repository: &RepositoryFs) -> Result<(), CandidateFreezeError> {
    repository.sync.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_repository(_repository: &RepositoryFs) -> Result<(), CandidateFreezeError> {
    Ok(())
}

fn selected_files_digest(
    repository: &Path,
    tracked: &[String],
    selected: fn(&str) -> bool,
) -> Result<ContentDigest, CandidateFreezeError> {
    let mut entries = Vec::new();
    for path in tracked.iter().filter(|path| selected(path)) {
        let full_path = repository.join(path);
        if full_path.is_file() {
            entries.push((
                path,
                workflow_code_intel::hash_file(&full_path)?.1.to_string(),
            ));
        }
    }
    Ok(ContentDigest::of(&serde_json::to_vec(&entries)?))
}

fn dependency_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "Cargo.lock"
            | "Gemfile.lock"
            | "Pipfile.lock"
            | "bun.lock"
            | "bun.lockb"
            | "composer.lock"
            | "go.sum"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "poetry.lock"
            | "uv.lock"
            | "yarn.lock"
    ) || name.starts_with("requirements") && name.ends_with(".txt")
}

fn configuration_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    matches!(
        name,
        "Cargo.toml"
            | "Dockerfile"
            | "biome.json"
            | "biome.jsonc"
            | "composer.json"
            | "deno.json"
            | "deno.jsonc"
            | "go.mod"
            | "package.json"
            | "pyproject.toml"
    ) || name.starts_with("tsconfig") && name.ends_with(".json")
        || name.starts_with("eslint.config.")
        || name.starts_with("vite.config.")
        || name.starts_with("next.config.")
        || name.starts_with("compose.") && matches!(name.rsplit('.').next(), Some("yaml" | "yml"))
}

fn generated_path(path: &str) -> bool {
    path.split('/')
        .any(|component| matches!(component, "build" | "dist" | "generated" | "out"))
}

fn require_clean(repository: &Path) -> Result<(), CandidateFreezeError> {
    if git(
        repository,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?
    .stdout
    .is_empty()
    {
        Ok(())
    } else {
        Err(CandidateFreezeError::DirtyWorktree)
    }
}

fn nul_fields(encoded: &[u8]) -> Result<Vec<String>, CandidateFreezeError> {
    encoded
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| {
            std::str::from_utf8(value)
                .map(str::to_owned)
                .map_err(|_| CandidateFreezeError::NonUtf8Path)
        })
        .collect()
}

fn git<'a>(
    directory: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<Output, CandidateFreezeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(command_path(directory))
        .args(arguments)
        .output()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(CandidateFreezeError::GitFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

fn git_stdout_bounded<'a>(
    directory: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
    limit: usize,
) -> Result<Vec<u8>, CandidateFreezeError> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(command_path(directory))
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| CandidateFreezeError::GitFailed("Git stdout is unavailable".to_owned()))?;
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if bytes
            .len()
            .checked_add(read)
            .is_none_or(|size| size > limit)
        {
            child.kill()?;
            let _ = child.wait();
            return Err(CandidateFreezeError::PayloadTooLarge);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(bytes)
    } else {
        Err(CandidateFreezeError::GitFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

fn git_preimage_matches(
    directory: &Path,
    revision: &str,
    path: &str,
    object_id: &str,
    actual: ContentDigest,
) -> Result<bool, CandidateFreezeError> {
    if actual == git_blob_digest(directory, object_id)? {
        return Ok(true);
    }
    Ok(actual == git_worktree_digest_at(directory, revision, path)?)
}

fn git_blob_digest(
    directory: &Path,
    object_id: &str,
) -> Result<ContentDigest, CandidateFreezeError> {
    let bytes = git_stdout_bounded(
        directory,
        ["cat-file", "blob", object_id],
        MAX_CANDIDATE_PAYLOAD_BYTES,
    )?;
    Ok(ContentDigest::of(&bytes))
}

fn git_worktree_digest_at(
    directory: &Path,
    revision: &str,
    path: &str,
) -> Result<ContentDigest, CandidateFreezeError> {
    let object = format!("{revision}:{path}");
    let path_argument = format!("--path={path}");
    let mut child = Command::new("git")
        .arg("-C")
        .arg(command_path(directory))
        .args(["cat-file", "--filters", &path_argument, &object])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| CandidateFreezeError::GitFailed("Git stdout is unavailable".to_owned()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = stdout.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(ContentDigest::from_bytes(hasher.finalize().into()))
    } else {
        Err(CandidateFreezeError::GitFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ))
    }
}

fn git_status<'a>(
    directory: &Path,
    arguments: impl IntoIterator<Item = &'a str>,
) -> Result<bool, CandidateFreezeError> {
    Ok(Command::new("git")
        .arg("-C")
        .arg(command_path(directory))
        .args(arguments)
        .status()?
        .success())
}

fn output_text(output: &Output) -> Result<String, CandidateFreezeError> {
    let value = std::str::from_utf8(&output.stdout)
        .map_err(|_| CandidateFreezeError::GitFailed("Git returned non-UTF-8 output".to_owned()))?
        .trim();
    if value.is_empty() {
        Err(CandidateFreezeError::GitFailed(
            "Git returned empty output".to_owned(),
        ))
    } else {
        Ok(value.to_owned())
    }
}

fn command_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{value}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn repository_directory_handle_is_syncable() {
        let directory = tempfile::tempdir().unwrap();
        let repository = RepositoryFs::open(directory.path()).unwrap();

        sync_repository(&repository).unwrap();
    }

    fn delivery_fixture() -> (
        tempfile::TempDir,
        CandidateManifest,
        Vec<CandidateFilePayload>,
        DeliveryJournal,
        PathBuf,
        PathBuf,
    ) {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("target.txt"), b"original\n").unwrap();
        let candidate_id = CandidateId::new();
        let exact_files = vec![CandidateFilePayload::new(
            "target.txt",
            b"approved\r\n".to_vec(),
        )];
        let manifest = CandidateManifest::new(
            candidate_id,
            Some("base".to_owned()),
            vec![
                CandidateFile::new(
                    "target.txt",
                    Some(ContentDigest::of(b"approved\r\n")),
                    CandidateFileKind::Modified,
                )
                .unwrap(),
            ],
            CandidateDigests {
                configuration: ContentDigest::of(b"configuration"),
                dependency_state: ContentDigest::of(b"dependencies"),
                diff: ContentDigest::of(b"diff"),
                environment: ContentDigest::of(b"environment"),
            },
            Vec::new(),
        )
        .unwrap()
        .with_delivery_payload_digest(Some(payload_digest(&exact_files).unwrap()));
        let journal = DeliveryJournal {
            candidate_id,
            files: vec![DeliveryJournalFile {
                approved_digest: Some(ContentDigest::of(b"approved\r\n")),
                approved_executable: false,
                original_digest: Some(ContentDigest::of(b"original\n")),
                original_directory: false,
                original_executable: false,
                path: "target.txt".to_owned(),
            }],
            nonce: "00112233445566778899aabbccddeeff".to_owned(),
        };
        let journal_path = directory.path().join("pending.json");
        let committed_path = directory.path().join("committed");
        write_journal(&journal_path, &journal).unwrap();
        (
            directory,
            manifest,
            exact_files,
            journal,
            journal_path,
            committed_path,
        )
    }

    fn interrupt_after_install(repository: &Path, journal: &DeliveryJournal, content: &[u8]) {
        let target = repository.join("target.txt");
        let backup = repository.join(adjacent_delivery_path(journal, "backup", 0));
        fs::hard_link(&target, &backup).unwrap();
        fs::remove_file(&target).unwrap();
        fs::write(target, content).unwrap();
    }

    #[test]
    fn pending_journal_recovers_original_bytes() {
        let (directory, manifest, exact_files, journal, journal_path, committed_path) =
            delivery_fixture();
        interrupt_after_install(directory.path(), &journal, b"approved\r\n");

        recover_delivery(
            directory.path(),
            &manifest,
            &exact_files,
            &journal_path,
            &committed_path,
        )
        .unwrap();

        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"original\n"
        );
        assert!(!journal_path.exists());
    }

    #[test]
    fn committed_journal_finishes_cleanup_without_rollback() {
        let (directory, manifest, exact_files, journal, journal_path, committed_path) =
            delivery_fixture();
        interrupt_after_install(directory.path(), &journal, b"approved\r\n");
        write_committed_marker(&committed_path).unwrap();

        recover_delivery(
            directory.path(),
            &manifest,
            &exact_files,
            &journal_path,
            &committed_path,
        )
        .unwrap();

        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"approved\r\n"
        );
        assert!(!journal_path.exists());
        assert!(!committed_path.exists());
    }

    #[test]
    fn legacy_committed_journal_finishes_in_place_without_current_clobber() {
        let (directory, manifest, exact_files, journal, journal_path, committed_path) =
            delivery_fixture();
        remove_if_exists(&journal_path).unwrap();
        let legacy_root = directory.path().join(LEGACY_DELIVERY_JOURNAL_DIRECTORY);
        fs::create_dir(&legacy_root).unwrap();
        let legacy_journal_path = legacy_root.join(format!("{}.json", manifest.candidate_id()));
        let legacy_committed_path =
            legacy_root.join(format!("{}.committed", manifest.candidate_id()));
        write_journal(&legacy_journal_path, &journal).unwrap();
        interrupt_after_install(directory.path(), &journal, b"approved\r\n");
        write_committed_marker(&legacy_committed_path).unwrap();
        let expected = ContentDigest::of(&fs::read(&legacy_journal_path).unwrap());
        let current_root = directory.path().join(DELIVERY_JOURNAL_DIRECTORY);
        let current_journal_path = current_root.join(format!("{}.json", manifest.candidate_id()));
        let current_committed_path =
            current_root.join(format!("{}.committed", manifest.candidate_id()));

        recover_legacy_delivery(
            &RepositoryFs::open(directory.path()).unwrap(),
            &manifest,
            &exact_files,
            directory.path(),
            Some(expected),
            &current_journal_path,
            &current_committed_path,
        )
        .unwrap();

        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"approved\r\n"
        );
        assert!(!legacy_journal_path.exists());
        assert!(!legacy_committed_path.exists());
        assert!(!current_root.exists());
        assert!(!committed_path.exists());
    }

    #[test]
    fn legacy_and_current_journals_fail_without_clobbering_either() {
        let (directory, manifest, exact_files, journal, journal_path, _committed_path) =
            delivery_fixture();
        remove_if_exists(&journal_path).unwrap();
        let legacy_root = directory.path().join(LEGACY_DELIVERY_JOURNAL_DIRECTORY);
        fs::create_dir(&legacy_root).unwrap();
        let legacy_journal_path = legacy_root.join(format!("{}.json", manifest.candidate_id()));
        write_journal(&legacy_journal_path, &journal).unwrap();
        let current_root = directory.path().join(DELIVERY_JOURNAL_DIRECTORY);
        fs::create_dir(&current_root).unwrap();
        let current_journal_path = current_root.join(format!("{}.json", manifest.candidate_id()));
        fs::write(&current_journal_path, b"current").unwrap();

        assert!(
            recover_legacy_delivery(
                &RepositoryFs::open(directory.path()).unwrap(),
                &manifest,
                &exact_files,
                directory.path(),
                Some(ContentDigest::of(&fs::read(&legacy_journal_path).unwrap())),
                &current_journal_path,
                &current_root.join(format!("{}.committed", manifest.candidate_id())),
            )
            .is_err()
        );

        assert!(legacy_journal_path.exists());
        assert_eq!(fs::read(&current_journal_path).unwrap(), b"current");
        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"original\n"
        );
    }

    #[test]
    fn rollback_preserves_concurrent_recreation() {
        let (directory, manifest, exact_files, journal, journal_path, committed_path) =
            delivery_fixture();
        interrupt_after_install(directory.path(), &journal, b"concurrent\n");

        recover_delivery(
            directory.path(),
            &manifest,
            &exact_files,
            &journal_path,
            &committed_path,
        )
        .unwrap();

        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"original\n"
        );
        assert_eq!(
            fs::read(
                directory
                    .path()
                    .join(adjacent_delivery_path(&journal, "concurrent", 0))
            )
            .unwrap(),
            b"concurrent\n"
        );
    }

    #[test]
    fn snapshot_detects_change_after_conflict_check() {
        let (directory, _manifest, _exact_files, journal, journal_path, committed_path) =
            delivery_fixture();
        fs::write(
            directory.path().join("target.txt"),
            b"changed after check\n",
        )
        .unwrap();
        let repository = RepositoryFs::open(directory.path()).unwrap();
        let backup = adjacent_delivery_path(&journal, "backup", 0);
        repository
            .root
            .hard_link("target.txt", &repository.root, &backup)
            .unwrap();
        assert!(!matches_snapshot_cap(&repository, &backup, &journal.files[0]).unwrap());
        repository.remove_file_if_exists(&backup).unwrap();
        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"changed after check\n"
        );
        assert!(!directory.path().join(&backup).exists());
        let _ = (journal_path, committed_path);
    }

    #[test]
    fn pending_file_to_directory_transition_restores_original_file() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("shape")).unwrap();
        fs::write(directory.path().join("shape/child.txt"), b"child\n").unwrap();
        let journal = DeliveryJournal {
            candidate_id: CandidateId::new(),
            nonce: "00112233445566778899aabbccddeeff".to_owned(),
            files: vec![
                DeliveryJournalFile {
                    approved_digest: None,
                    approved_executable: false,
                    original_digest: Some(ContentDigest::of(b"file\n")),
                    original_directory: false,
                    original_executable: false,
                    path: "shape".to_owned(),
                },
                DeliveryJournalFile {
                    approved_digest: Some(ContentDigest::of(b"child\n")),
                    approved_executable: false,
                    original_digest: None,
                    original_directory: false,
                    original_executable: false,
                    path: "shape/child.txt".to_owned(),
                },
            ],
        };
        fs::write(
            directory
                .path()
                .join(adjacent_delivery_path(&journal, "backup", 0)),
            b"file\n",
        )
        .unwrap();
        rollback_payload(
            &RepositoryFs::open(directory.path()).unwrap(),
            &journal,
            &directory.path().join("journal"),
            &directory.path().join("committed"),
        )
        .unwrap();
        assert_eq!(fs::read(directory.path().join("shape")).unwrap(), b"file\n");
    }

    #[test]
    fn pending_directory_to_file_transition_restores_original_tree() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("shape"), b"file\n").unwrap();
        let journal = DeliveryJournal {
            candidate_id: CandidateId::new(),
            nonce: "00112233445566778899aabbccddeeff".to_owned(),
            files: vec![
                DeliveryJournalFile {
                    approved_digest: Some(ContentDigest::of(b"file\n")),
                    approved_executable: false,
                    original_digest: None,
                    original_directory: true,
                    original_executable: false,
                    path: "shape".to_owned(),
                },
                DeliveryJournalFile {
                    approved_digest: None,
                    approved_executable: false,
                    original_digest: Some(ContentDigest::of(b"child\n")),
                    original_directory: false,
                    original_executable: false,
                    path: "shape/child.txt".to_owned(),
                },
            ],
        };
        fs::write(
            directory
                .path()
                .join(adjacent_delivery_path(&journal, "backup", 1)),
            b"child\n",
        )
        .unwrap();
        rollback_payload(
            &RepositoryFs::open(directory.path()).unwrap(),
            &journal,
            &directory.path().join("journal"),
            &directory.path().join("committed"),
        )
        .unwrap();
        assert_eq!(
            fs::read(directory.path().join("shape/child.txt")).unwrap(),
            b"child\n"
        );
    }

    #[test]
    fn legacy_pending_journal_recovers_then_rebinds_current_delivery() {
        use std::num::NonZeroUsize;
        use workflow_core::{WorkflowCommand, WorkflowMode, WorkflowState, WorkflowTimestamp};
        use workflow_store::{Store, StoreError};

        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, ["init"]).unwrap();
        git(&source, ["config", "user.email", "test@example.invalid"]).unwrap();
        git(&source, ["config", "user.name", "Test User"]).unwrap();
        git(&source, ["config", "core.hooksPath", ".git/hooks"]).unwrap();
        git(&source, ["config", "core.autocrlf", "false"]).unwrap();
        fs::write(source.join("target.txt"), b"original\n").unwrap();
        git(&source, ["add", "."]).unwrap();
        git(&source, ["commit", "-m", "base"]).unwrap();
        let base = output_text(&git(&source, ["rev-parse", "HEAD"]).unwrap()).unwrap();
        let candidate = directory.path().join("candidate");
        assert!(
            Command::new("git")
                .args(["clone", "--no-hardlinks"])
                .arg(&source)
                .arg(&candidate)
                .status()
                .unwrap()
                .success()
        );
        git(&candidate, ["config", "user.email", "test@example.invalid"]).unwrap();
        git(&candidate, ["config", "user.name", "Test User"]).unwrap();
        git(&candidate, ["config", "core.hooksPath", ".git/hooks"]).unwrap();
        git(&candidate, ["config", "core.autocrlf", "false"]).unwrap();
        fs::write(candidate.join("target.txt"), b"approved\n").unwrap();
        git(&candidate, ["add", "target.txt"]).unwrap();
        git(&candidate, ["commit", "-m", "candidate"]).unwrap();
        let candidate_id = CandidateId::new();
        let frozen = freeze(&candidate, &base, candidate_id, Vec::new()).unwrap();
        let workflow_id = workflow_core::WorkflowId::new();
        let database = directory.path().join("workflow.db");
        let mut store = Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();
        for (key, command) in [
            ("retry-intake", WorkflowCommand::CompleteIntake),
            ("retry-route", WorkflowCommand::Route(WorkflowMode::Quick)),
            (
                "retry-candidate",
                WorkflowCommand::CandidateReady(candidate_id),
            ),
            ("retry-verify", WorkflowCommand::VerificationPassed),
            (
                "retry-approve",
                WorkflowCommand::Approve {
                    mandatory_gates_passed: true,
                },
            ),
        ] {
            store
                .apply_workflow_command(workflow_id, key, command, WorkflowTimestamp::now())
                .unwrap();
        }
        store
            .save_candidate_once(
                workflow_id,
                &frozen.manifest,
                &frozen.exact_diff,
                &frozen.exact_files,
                WorkflowTimestamp::now(),
            )
            .unwrap();
        let candidate_digest = frozen.manifest.digest();
        store
            .reserve_candidate_delivery(
                workflow_id,
                candidate_id,
                candidate_digest,
                WorkflowTimestamp::now(),
            )
            .unwrap();
        let repository = RepositoryFs::open(&source).unwrap();
        let pending = capture_journal(&source, &repository, &frozen.manifest).unwrap();
        let pending_digest = delivery_journal_digest(&pending).unwrap();
        store
            .bind_candidate_delivery_journal(
                workflow_id,
                candidate_id,
                candidate_digest,
                None,
                pending_digest,
            )
            .unwrap();
        let git_directory = PathBuf::from(
            output_text(&git(&source, ["rev-parse", "--absolute-git-dir"]).unwrap()).unwrap(),
        );
        let legacy_journal_root = git_directory.join(LEGACY_DELIVERY_JOURNAL_DIRECTORY);
        fs::create_dir_all(&legacy_journal_root).unwrap();
        let legacy_journal_path = legacy_journal_root.join(format!("{candidate_id}.json"));
        write_journal(&legacy_journal_path, &pending).unwrap();
        drop(store);
        let binding_database = database.clone();
        let (_, rebound_digest) = promote_bound(
            &source,
            &frozen.manifest,
            &frozen.exact_diff,
            &frozen.exact_files,
            Some(pending_digest),
            |expected, rebound| {
                Store::open(&binding_database, NonZeroUsize::new(1).unwrap())
                    .and_then(|mut store| {
                        store.bind_candidate_delivery_journal(
                            workflow_id,
                            candidate_id,
                            candidate_digest,
                            expected,
                            rebound,
                        )
                    })
                    .map_err(|error| CandidateFreezeError::GitFailed(error.to_string()))
            },
        )
        .unwrap();
        assert_ne!(rebound_digest, pending_digest);
        let mut store = Store::open(&database, NonZeroUsize::new(1).unwrap()).unwrap();
        assert_eq!(
            store
                .candidate_delivery_journal_digest(workflow_id, candidate_id)
                .unwrap(),
            Some(rebound_digest)
        );
        assert!(matches!(
            store.bind_candidate_delivery_journal(
                workflow_id,
                candidate_id,
                candidate_digest,
                Some(pending_digest),
                ContentDigest::of(b"stale")
            ),
            Err(StoreError::AggregateConflict)
        ));
        let delivered = store
            .deliver_reserved_candidate(
                workflow_id,
                candidate_id,
                candidate_digest,
                rebound_digest,
                "retry-deliver",
                WorkflowTimestamp::now(),
            )
            .unwrap();
        assert_eq!(delivered.state.state(), WorkflowState::Completed);
        assert!(matches!(
            store.deliver_reserved_candidate(
                workflow_id,
                candidate_id,
                candidate_digest,
                pending_digest,
                "retry-stale-deliver",
                WorkflowTimestamp::now()
            ),
            Err(StoreError::AggregateConflict)
        ));
        assert_eq!(fs::read(source.join("target.txt")).unwrap(), b"approved\n");
        assert!(!legacy_journal_path.exists());
        assert!(git_directory.join(DELIVERY_JOURNAL_DIRECTORY).exists());
    }

    #[test]
    fn candidate_payload_limit_is_bounded() {
        assert!(payload_size_allowed([MAX_CANDIDATE_PAYLOAD_BYTES]));
        assert!(!payload_size_allowed([MAX_CANDIDATE_PAYLOAD_BYTES, 1]));
        assert!(!payload_size_allowed([usize::MAX, 1]));
    }

    #[test]
    fn truncated_journal_fails_without_mutating_repository() {
        let (directory, manifest, exact_files, _journal, journal_path, committed_path) =
            delivery_fixture();
        remove_if_exists(&journal_path).unwrap();
        fs::write(&journal_path, b"{").unwrap();

        assert!(
            recover_delivery(
                directory.path(),
                &manifest,
                &exact_files,
                &journal_path,
                &committed_path,
            )
            .is_err()
        );
        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"original\n"
        );
    }

    #[test]
    fn journal_publication_never_overwrites_existing_final() {
        let (_directory, _manifest, _exact_files, journal, journal_path, _committed_path) =
            delivery_fixture();
        fs::write(&journal_path, b"existing").unwrap();

        assert!(write_journal(&journal_path, &journal).is_err());
        assert_eq!(fs::read(&journal_path).unwrap(), b"existing");
        assert!(!journal_path.with_extension("json.tmp").exists());
    }

    #[test]
    fn tampered_journal_fails_without_mutating_repository() {
        let (directory, manifest, exact_files, mut journal, journal_path, committed_path) =
            delivery_fixture();
        journal.files[0].path = "../outside".to_owned();
        remove_if_exists(&journal_path).unwrap();
        write_journal(&journal_path, &journal).unwrap();

        assert!(matches!(
            recover_delivery(
                directory.path(),
                &manifest,
                &exact_files,
                &journal_path,
                &committed_path,
            ),
            Err(CandidateFreezeError::PayloadMismatch)
        ));
        assert_eq!(
            fs::read(directory.path().join("target.txt")).unwrap(),
            b"original\n"
        );
    }

    #[test]
    fn deleted_path_is_not_delivered_when_recreated_as_directory() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("deleted")).unwrap();
        let manifest = CandidateManifest::new(
            CandidateId::new(),
            Some("base".to_owned()),
            vec![CandidateFile::new("deleted", None, CandidateFileKind::Deleted).unwrap()],
            CandidateDigests {
                configuration: ContentDigest::of(b"configuration"),
                dependency_state: ContentDigest::of(b"dependencies"),
                diff: ContentDigest::of(b"diff"),
                environment: ContentDigest::of(b"environment"),
            },
            Vec::new(),
        )
        .unwrap()
        .with_delivery_payload_digest(Some(payload_digest(&[]).unwrap()));

        assert!(!verify_promoted(directory.path(), &manifest, &[]).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_point_is_rejected_as_delivery_boundary() {
        let repository = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(repository.path().join("link")).unwrap();
        fs::write(outside.path().join("sentinel.txt"), b"outside\n").unwrap();
        let (_, manifest, _, _, _, _) = delivery_fixture();
        let repository_fs = RepositoryFs::open(repository.path()).unwrap();
        validate_destination(&repository_fs, &manifest, "link/file.txt").unwrap();
        fs::remove_dir(repository.path().join("link")).unwrap();
        let status = Command::new("cmd")
            .current_dir(repository.path())
            .args([
                "/c",
                "mklink",
                "/J",
                "link",
                outside.path().to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        assert!(matches!(
            write_new_file(&repository_fs, "link/file.txt", b"candidate\n"),
            Err(CandidateFreezeError::Io(_)) | Err(CandidateFreezeError::GitFailed(_))
        ));
        assert_eq!(
            fs::read(outside.path().join("sentinel.txt")).unwrap(),
            b"outside\n"
        );
        assert!(!outside.path().join("file.txt").exists());
    }
}
