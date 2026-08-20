use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    time::Duration,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};
use workflow_core::{
    CandidateManifest, ContentDigest, EvidenceId, EvidenceRecord, EvidenceStatus, WorkflowTimestamp,
};
use workflow_ipc::ManagedBrowserAttestation;
use workflow_ledger::Redactor;
use workflow_store::CandidateFilePayload;

use super::{VerificationExecutor, VerificationGate, VerificationPlan};

const RETAINED_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_PIPE_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
// Immutable protocol-v1 compatibility identifier for persisted verification output digests.
const LEGACY_PROTOCOL_V1_VERIFICATION_OUTPUT_DOMAIN: &[u8] =
    b"opencode-workflow/verification-output/v1";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationRun {
    pub infrastructure_blocked: bool,
    pub mandatory_passed: bool,
    pub outputs: BTreeMap<EvidenceId, String>,
    pub records: Vec<EvidenceRecord>,
}

#[derive(Debug)]
pub enum VerificationRunError {
    CandidateChanged,
    EvidenceMismatch,
    Io(std::io::Error),
    Join(tokio::task::JoinError),
}

impl std::fmt::Display for VerificationRunError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CandidateChanged => {
                formatter.write_str("candidate bytes changed after the manifest was frozen")
            }
            Self::EvidenceMismatch => {
                formatter.write_str("candidate evidence identifiers do not match the plan")
            }
            Self::Io(error) => error.fmt(formatter),
            Self::Join(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for VerificationRunError {}

impl From<std::io::Error> for VerificationRunError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<tokio::task::JoinError> for VerificationRunError {
    fn from(value: tokio::task::JoinError) -> Self {
        Self::Join(value)
    }
}

pub async fn run(
    repository: &Path,
    plan: &VerificationPlan,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
) -> Result<VerificationRun, VerificationRunError> {
    run_with_attestations(repository, plan, manifest, exact_diff, exact_files, &[]).await
}

pub async fn run_with_attestations(
    repository: &Path,
    plan: &VerificationPlan,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
    attestations: &[ManagedBrowserAttestation],
) -> Result<VerificationRun, VerificationRunError> {
    let planned: BTreeSet<_> = plan.evidence_ids().into_iter().collect();
    let frozen: BTreeSet<_> = manifest.evidence_ids().iter().copied().collect();
    if planned != frozen {
        return Err(VerificationRunError::EvidenceMismatch);
    }
    if !crate::candidate::verify_frozen(repository, manifest, exact_diff, exact_files)
        .map_err(|_| VerificationRunError::CandidateChanged)?
    {
        return Err(VerificationRunError::CandidateChanged);
    }
    let mut records = Vec::with_capacity(plan.gates.len());
    let mut outputs = BTreeMap::new();
    let mut mandatory_passed = true;
    let mut infrastructure_blocked = false;
    for gate in &plan.gates {
        let result = if let Some(result) = managed_browser_gate(gate, manifest, attestations) {
            result
        } else {
            run_gate(repository, gate, manifest, exact_diff, exact_files).await?
        };
        if gate.mandatory && result.record.status != EvidenceStatus::Passed {
            mandatory_passed = false;
            infrastructure_blocked |= result.record.status == EvidenceStatus::Skipped;
        }
        outputs.insert(gate.id, result.output);
        records.push(result.record);
    }
    Ok(VerificationRun {
        infrastructure_blocked,
        mandatory_passed,
        outputs,
        records,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserReceipt {
    actions: Vec<BrowserAction>,
    logs: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserAction {
    digest: String,
    operation: String,
    timestamp: String,
    url: String,
}

fn managed_browser_gate(
    gate: &VerificationGate,
    manifest: &CandidateManifest,
    attestations: &[ManagedBrowserAttestation],
) -> Option<GateResult> {
    let required = match (&gate.executor, gate.name.as_str()) {
        (VerificationExecutor::Unavailable { .. }, "browser:affected-user-flow") => {
            &["open", "check", "screenshot", "logs", "close"][..]
        }
        (VerificationExecutor::Unavailable { .. }, "accessibility:affected-user-flow") => {
            &["open", "snapshot", "close"][..]
        }
        _ => return None,
    };
    let valid = attestations.iter().find_map(|attestation| {
        validate_browser_attestation(attestation, manifest.digest(), required)
    });
    let (session_id, operations, receipt_digest) = valid?;
    let started_at = WorkflowTimestamp::now();
    let output = format!(
        "Managed browser receipt {receipt_digest} from session {session_id} passed operations: {}.",
        operations.join(", ")
    );
    let record = EvidenceRecord {
        id: gate.id,
        candidate_digest: manifest.digest(),
        kind: gate.kind,
        invocation: invocation(gate),
        tool: "opencode-cycle-managed-browser".to_owned(),
        tool_version: env!("CARGO_PKG_VERSION").to_owned(),
        started_at,
        finished_at: WorkflowTimestamp::now(),
        exit_code: Some(0),
        output_digest: ContentDigest::of(output.as_bytes()),
        status: EvidenceStatus::Passed,
        skip_reason: None,
    };
    record.validate().ok()?;
    Some(GateResult {
        output: Redactor::default().value(output),
        record,
    })
}

fn validate_browser_attestation(
    attestation: &ManagedBrowserAttestation,
    candidate_digest: ContentDigest,
    required: &[&str],
) -> Option<(String, Vec<String>, ContentDigest)> {
    if attestation.candidate_digest != candidate_digest
        || attestation.session_id.trim().is_empty()
        || attestation.session_id.len() > 256
        || attestation.session_id.chars().any(char::is_control)
        || attestation.receipt_json.len() > 2 * 1024 * 1024
        || ContentDigest::of(attestation.receipt_json.as_bytes()) != attestation.receipt_digest
    {
        return None;
    }
    let receipt: BrowserReceipt = serde_json::from_str(&attestation.receipt_json).ok()?;
    if receipt.actions.is_empty() || receipt.actions.len() > 1_024 || receipt.logs.len() > 200 {
        return None;
    }
    let allowed = [
        "open",
        "snapshot",
        "click",
        "fill",
        "press",
        "upload",
        "check",
        "screenshot",
        "logs",
        "close",
    ];
    let mut operations = Vec::with_capacity(receipt.actions.len());
    for action in receipt.actions {
        if !allowed.contains(&action.operation.as_str())
            || action.digest.len() != 64
            || !action.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            || action.timestamp.trim().is_empty()
            || action.timestamp.len() > 64
            || action.url.len() > 4_096
            || !(action.url.starts_with("http://") || action.url.starts_with("https://"))
            || action.url.chars().any(|character| character.is_control())
        {
            return None;
        }
        operations.push(action.operation);
    }
    if operations.last().map(String::as_str) != Some("close")
        || operations
            .iter()
            .filter(|operation| operation.as_str() == "close")
            .count()
            != 1
    {
        return None;
    }
    let mut position = 0;
    for operation in &operations {
        if position < required.len() && operation == required[position] {
            position += 1;
        }
    }
    (position == required.len()).then(|| {
        (
            attestation.session_id.clone(),
            operations,
            attestation.receipt_digest,
        )
    })
}

struct GateResult {
    output: String,
    record: EvidenceRecord,
}

async fn run_gate(
    repository: &Path,
    gate: &VerificationGate,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
    exact_files: &[CandidateFilePayload],
) -> Result<GateResult, VerificationRunError> {
    let started_at = WorkflowTimestamp::now();
    let candidate_digest = manifest.digest();
    let (exit_code, output, output_digest, status, skip_reason, tool, tool_version) =
        match &gate.executor {
            VerificationExecutor::CandidateIntegrity => {
                let matches =
                    crate::candidate::verify_frozen(repository, manifest, exact_diff, exact_files)
                        .map_err(|_| VerificationRunError::CandidateChanged)?;
                let output = if matches {
                    "Frozen candidate bytes match the manifest."
                } else {
                    "Frozen candidate bytes no longer match the manifest."
                };
                (
                    Some(i32::from(!matches)),
                    output.to_owned(),
                    ContentDigest::of(output.as_bytes()),
                    if matches {
                        EvidenceStatus::Passed
                    } else {
                        EvidenceStatus::Failed
                    },
                    None,
                    "workflow-candidate-integrity".to_owned(),
                    env!("CARGO_PKG_VERSION").to_owned(),
                )
            }
            VerificationExecutor::SecretScan => {
                let result = super::secrets::scan(repository, manifest, exact_diff);
                let (exit_code, output, status) = match result {
                    Ok(()) => (
                        Some(0),
                        "No credential-like content was detected in changed files.".to_owned(),
                        EvidenceStatus::Passed,
                    ),
                    Err(message) => (Some(1), message, EvidenceStatus::Failed),
                };
                (
                    exit_code,
                    output.clone(),
                    ContentDigest::of(output.as_bytes()),
                    status,
                    None,
                    "workflow-secret-scan".to_owned(),
                    env!("CARGO_PKG_VERSION").to_owned(),
                )
            }
            VerificationExecutor::Unavailable { reason } => (
                None,
                reason.clone(),
                ContentDigest::of(reason.as_bytes()),
                EvidenceStatus::Skipped,
                Some(reason.clone()),
                "unavailable".to_owned(),
                "unavailable".to_owned(),
            ),
            VerificationExecutor::Command { arguments, program } => {
                let tool_version = probe_tool_version(repository, program).await;
                let command = execute_command(
                    repository,
                    program,
                    arguments,
                    Duration::from_secs(gate.timeout_seconds),
                )
                .await?;
                (
                    Some(command.exit_code),
                    command.output,
                    command.output_digest,
                    if command.exit_code == 0 {
                        EvidenceStatus::Passed
                    } else {
                        EvidenceStatus::Failed
                    },
                    None,
                    program.clone(),
                    tool_version,
                )
            }
        };
    let record = EvidenceRecord {
        id: gate.id,
        candidate_digest,
        kind: gate.kind,
        invocation: invocation(gate),
        tool,
        tool_version,
        started_at,
        finished_at: WorkflowTimestamp::now(),
        exit_code,
        output_digest,
        status,
        skip_reason,
    };
    record
        .validate()
        .map_err(|_| VerificationRunError::EvidenceMismatch)?;
    Ok(GateResult {
        output: Redactor::default().value(output),
        record,
    })
}

async fn probe_tool_version(directory: &Path, program: &str) -> String {
    let arguments = ["--version".to_owned()];
    match execute_command(directory, program, &arguments, Duration::from_secs(10)).await {
        Ok(result) if result.exit_code == 0 => result
            .output
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| {
                let end = line
                    .char_indices()
                    .nth(512)
                    .map_or(line.len(), |(index, _)| index);
                Redactor::default().value(line[..end].to_owned())
            })
            .filter(|line| !line.is_empty())
            .unwrap_or_else(|| "version output unavailable".to_owned()),
        Ok(_) | Err(_) => "version command unavailable".to_owned(),
    }
}

struct CommandResult {
    exit_code: i32,
    output: String,
    output_digest: ContentDigest,
}

async fn execute_command(
    directory: &Path,
    program: &str,
    arguments: &[String],
    timeout: Duration,
) -> Result<CommandResult, VerificationRunError> {
    let mut command = tokio::process::Command::new(command_program(program));
    command
        .args(arguments)
        .current_dir(directory)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in [
        "COMSPEC",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("CI", "true");
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout is available");
    let stderr = child.stderr.take().expect("piped stderr is available");
    let stdout = tokio::spawn(capture(stdout));
    let stderr = tokio::spawn(capture(stderr));
    let exit_code = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => status?.code().unwrap_or(-1),
        Err(_) => {
            child.kill().await?;
            let _ = child.wait().await?;
            -1
        }
    };
    let Some(captures) = finish_captures(stdout, stderr, OUTPUT_PIPE_CLOSE_TIMEOUT).await else {
        let output = "Verification process output pipes did not close after the process exited.";
        return Ok(CommandResult {
            exit_code: -1,
            output: output.to_owned(),
            output_digest: ContentDigest::of(output.as_bytes()),
        });
    };
    let (stdout, stderr) = captures?;
    let output_digest = combined_digest(&stdout, &stderr);
    let mut output = String::from_utf8_lossy(&stdout.retained).into_owned();
    if !stderr.retained.is_empty() {
        output.push_str("\n[stderr]\n");
        output.push_str(&String::from_utf8_lossy(&stderr.retained));
    }
    if stdout.truncated || stderr.truncated {
        output.push_str("\n[output truncated; full output digest retained]");
    }
    Ok(CommandResult {
        exit_code,
        output,
        output_digest,
    })
}

fn command_program(program: &str) -> String {
    #[cfg(windows)]
    {
        let executable = program
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or(program)
            .to_ascii_lowercase();
        if !program.contains(['/', '\\'])
            && !program.contains('.')
            && matches!(executable.as_str(), "npm" | "npx" | "pnpm" | "yarn")
        {
            return format!("{program}.cmd");
        }
    }
    program.to_owned()
}

async fn finish_captures(
    mut stdout: tokio::task::JoinHandle<Result<StreamCapture, std::io::Error>>,
    mut stderr: tokio::task::JoinHandle<Result<StreamCapture, std::io::Error>>,
    timeout: Duration,
) -> Option<Result<(StreamCapture, StreamCapture), VerificationRunError>> {
    match tokio::time::timeout(timeout, async {
        let stdout = (&mut stdout).await??;
        let stderr = (&mut stderr).await??;
        Ok((stdout, stderr))
    })
    .await
    {
        Ok(result) => Some(result),
        Err(_) => {
            stdout.abort();
            stderr.abort();
            None
        }
    }
}

struct StreamCapture {
    bytes: u64,
    digest: [u8; 32],
    retained: Vec<u8>,
    truncated: bool,
}

async fn capture(mut stream: impl AsyncRead + Unpin) -> Result<StreamCapture, std::io::Error> {
    let mut hasher = Sha256::new();
    let mut retained = Vec::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(u64::try_from(read).expect("buffer lengths fit in u64"));
        let remaining = RETAINED_OUTPUT_BYTES.saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(StreamCapture {
        bytes,
        digest: hasher.finalize().into(),
        truncated: bytes > u64::try_from(RETAINED_OUTPUT_BYTES).expect("limit fits in u64"),
        retained,
    })
}

fn combined_digest(stdout: &StreamCapture, stderr: &StreamCapture) -> ContentDigest {
    let mut hasher = Sha256::new();
    hasher.update(LEGACY_PROTOCOL_V1_VERIFICATION_OUTPUT_DOMAIN);
    hasher.update(stdout.bytes.to_be_bytes());
    hasher.update(stdout.digest);
    hasher.update(stderr.bytes.to_be_bytes());
    hasher.update(stderr.digest);
    ContentDigest::from_bytes(hasher.finalize().into())
}

fn invocation(gate: &VerificationGate) -> String {
    match &gate.executor {
        VerificationExecutor::CandidateIntegrity => "candidate-integrity".to_owned(),
        VerificationExecutor::Command { arguments, program } => std::iter::once(program.as_str())
            .chain(arguments.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        VerificationExecutor::SecretScan => "changed-content-secret-scan".to_owned(),
        VerificationExecutor::Unavailable { .. } => gate.name.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_command_shims_use_cmd_suffix() {
        assert_eq!(command_program("npm"), "npm.cmd");
        assert_eq!(command_program("npx"), "npx.cmd");
        assert_eq!(command_program("pnpm"), "pnpm.cmd");
        assert_eq!(command_program("yarn"), "yarn.cmd");
        assert_eq!(command_program("bun"), "bun");
        assert_eq!(command_program("C:\\tools\\npm.cmd"), "C:\\tools\\npm.cmd");
    }

    #[tokio::test]
    async fn output_capture_timeout_aborts_unclosed_pipes() {
        let (stdout_reader, _stdout_writer) = tokio::io::duplex(64);
        let (stderr_reader, _stderr_writer) = tokio::io::duplex(64);
        let stdout = tokio::spawn(capture(stdout_reader));
        let stderr = tokio::spawn(capture(stderr_reader));

        let result = finish_captures(stdout, stderr, Duration::from_millis(10)).await;

        assert!(result.is_none());
    }

    #[test]
    fn protocol_v1_verification_output_digest_has_a_fixed_vector() {
        let stdout = StreamCapture {
            bytes: 6,
            digest: *ContentDigest::of(b"stdout").as_bytes(),
            retained: Vec::new(),
            truncated: false,
        };
        let stderr = StreamCapture {
            bytes: 6,
            digest: *ContentDigest::of(b"stderr").as_bytes(),
            retained: Vec::new(),
            truncated: false,
        };
        assert_eq!(
            combined_digest(&stdout, &stderr).to_string(),
            "260b33b63d2801b900d6f3fbb8c9cf7cbf406b50a6bae972c03d20520c18804f"
        );
    }
}
