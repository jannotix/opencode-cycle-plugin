use std::{
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::io::{AsyncRead, AsyncWrite};
use workflow_ipc::{
    ClientMessage, IpcRequest, IpcResponse, ServerMessage, auth::Authenticator,
    channel::JsonChannel, secret::load_or_create, transport::LocalListener,
};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

use crate::health::health_report;

type DaemonError = Box<dyn std::error::Error + Send + Sync>;

struct SharedRuntime {
    admission: Arc<tokio::sync::Mutex<crate::admission::RuntimeAdmission>>,
    checkpoint_key: Arc<CheckpointKey>,
    database: Arc<PathBuf>,
    delivery_gate: Arc<tokio::sync::Mutex<()>>,
    index_gate: Arc<tokio::sync::Mutex<()>>,
    store: Arc<tokio::sync::Mutex<Store>>,
    worktrees: Arc<PathBuf>,
}

pub async fn run(data_directory: impl AsRef<Path>) -> Result<(), DaemonError> {
    let paths = RuntimePaths::new(data_directory.as_ref());
    std::fs::create_dir_all(&paths.runtime)?;
    let secret = load_or_create(&paths.secret)?;
    let store = Store::open(
        &paths.database,
        NonZeroUsize::new(4).expect("four is non-zero"),
    )?;
    let report = health_report(store.mode());
    let checkpoint_key = Arc::new(workflow_ledger::load_or_create(&paths.checkpoint_key)?);
    crate::history::verify_store(&store, &checkpoint_key)?;
    let shared = Arc::new(SharedRuntime {
        admission: Arc::new(tokio::sync::Mutex::new(
            crate::admission::RuntimeAdmission::default(),
        )),
        checkpoint_key,
        database: Arc::new(paths.database.clone()),
        delivery_gate: Arc::new(tokio::sync::Mutex::new(())),
        index_gate: Arc::new(tokio::sync::Mutex::new(())),
        store: Arc::new(tokio::sync::Mutex::new(store)),
        worktrees: Arc::new(paths.worktrees.clone()),
    });
    let authenticator = Arc::new(tokio::sync::Mutex::new(Authenticator::new(
        *secret.as_bytes(),
    )));

    #[cfg(windows)]
    let mut listener = LocalListener::bind(&secret.endpoint_id())?;
    #[cfg(unix)]
    let listener = LocalListener::bind(&paths.socket)?;
    std::fs::write(
        paths.runtime.join("workflowd.pid"),
        format!("{}\n", std::process::id()),
    )?;

    loop {
        let stream = listener.accept().await?;
        let authenticator = Arc::clone(&authenticator);
        let report = report.clone();
        let shared = Arc::clone(&shared);
        tokio::spawn(async move {
            let _ = serve_connection(stream, authenticator, report, shared).await;
        });
    }
}

async fn serve_connection<S>(
    stream: S,
    authenticator: Arc<tokio::sync::Mutex<Authenticator>>,
    report: workflow_ipc::HealthReport,
    shared: Arc<SharedRuntime>,
) -> Result<(), DaemonError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let admission = Arc::clone(&shared.admission);
    let checkpoint_key = Arc::clone(&shared.checkpoint_key);
    let database = Arc::clone(&shared.database);
    let delivery_gate = Arc::clone(&shared.delivery_gate);
    let index_gate = Arc::clone(&shared.index_gate);
    let store = Arc::clone(&shared.store);
    let worktrees = Arc::clone(&shared.worktrees);
    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| "operating-system entropy is unavailable")?;
    let lifetime =
        i64::try_from(Duration::from_secs(5).as_millis()).expect("challenge lifetime fits in i64");
    let expires = now_unix_millis()?.saturating_add(lifetime);
    let challenge = Authenticator::challenge(nonce, expires);
    let mut channel = JsonChannel::new(stream);
    channel
        .send(&ServerMessage::Challenge(challenge.clone()))
        .await?;
    let response = match channel.receive::<ClientMessage>().await? {
        ClientMessage::Authenticate(response) => response,
        _ => return Err("client did not authenticate before sending requests".into()),
    };
    authenticator
        .lock()
        .await
        .verify(&challenge, &response, now_unix_millis()?)?;

    loop {
        match channel.receive::<ClientMessage>().await? {
            ClientMessage::Admission {
                operation,
                project_key,
                request_id,
                workflow_id,
                workspace,
            } => {
                let project_id = workflow_core::ProjectId::from_stable_key(&project_key);
                let valid_fields = !project_key.is_empty()
                    && project_key.len() <= 32_768
                    && !project_key.contains('\0')
                    && !workspace.is_empty()
                    && workspace.len() <= 32_768
                    && !workspace.contains('\0');
                let eligibility = if valid_fields {
                    let store = store.lock().await;
                    let request_matches = store
                        .load_request(workflow_id)
                        .map_err(|error| error.to_string())?
                        .is_some_and(|(stored, _)| stored == project_id);
                    if request_matches {
                        store
                            .load_workflow(workflow_id)
                            .map(|workflow| workflow.map(|workflow| workflow.state()))
                    } else {
                        Ok(None)
                    }
                } else {
                    Ok(None)
                };
                match eligibility {
                    Ok(Some(state)) if admission_allowed(operation, state) => {
                        let sample = crate::resources::sample(Path::new(&workspace));
                        let now = u64::try_from(now_unix_millis()?)
                            .expect("current timestamp is non-negative");
                        let result = admission.lock().await.execute(
                            operation,
                            project_id,
                            workflow_id,
                            sample,
                            now,
                        );
                        channel
                            .send(&ServerMessage::Admission {
                                request_id,
                                result: serde_json::to_value(result)?,
                            })
                            .await?;
                    }
                    Ok(Some(_)) => {
                        admission.lock().await.release(workflow_id);
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "admission_rejected".to_owned(),
                                message: "workflow is not runnable from its current state"
                                    .to_owned(),
                            })
                            .await?;
                    }
                    Ok(None) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "admission_rejected".to_owned(),
                                message: "admission request does not match a durable workflow"
                                    .to_owned(),
                            })
                            .await?;
                    }
                    Err(error) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "admission_failed".to_owned(),
                                message: error.to_string(),
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Audit {
                request_id,
                observation,
            } => {
                let mut store = store.lock().await;
                let result = crate::audit::record(&mut store, &checkpoint_key, observation);
                drop(store);
                match result {
                    Ok(entry) => {
                        channel
                            .send(&ServerMessage::AuditRecorded {
                                entry_hash: entry.hash.to_string(),
                                request_id,
                                sequence: entry.sequence,
                            })
                            .await?;
                    }
                    Err(error) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "audit_rejected".to_owned(),
                                message: error.to_string(),
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::CodeIndex {
                project_directory,
                project_key,
                request_id,
                workflow_id,
            } => {
                let project_id = workflow_core::ProjectId::from_stable_key(&project_key);
                let request = if project_key.is_empty()
                    || project_key.len() > 32_768
                    || project_key.contains('\0')
                    || project_directory.is_empty()
                    || project_directory.len() > 32_768
                    || project_directory.contains('\0')
                {
                    None
                } else {
                    store
                        .lock()
                        .await
                        .load_request(workflow_id)?
                        .and_then(|(stored, request)| (stored == project_id).then_some(request))
                };
                let result = if let Some(request) = request {
                    let _index_guard = index_gate.lock().await;
                    let database = Arc::clone(&database);
                    tokio::task::spawn_blocking(move || {
                        crate::code_intelligence::index_and_context(
                            &database,
                            Path::new(&project_directory),
                            project_id,
                            &request,
                        )
                    })
                    .await
                    .map_err(|error| error.to_string())?
                } else {
                    Err("code index request does not match a durable workflow".to_owned())
                };
                match result {
                    Ok(result) => {
                        channel
                            .send(&ServerMessage::CodeIndex { request_id, result })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "code_index_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Control {
                operation,
                operation_id,
                project_key,
                request_id,
                workflow_id,
            } => {
                let result = crate::control::execute(
                    &mut *store.lock().await,
                    &checkpoint_key,
                    &worktrees,
                    &project_key,
                    workflow_id,
                    operation,
                    operation_id,
                );
                if result.is_ok()
                    && operation == workflow_ipc::ControlOperation::Cancel
                    && let Some(workflow_id) = workflow_id
                {
                    admission.lock().await.release(workflow_id);
                }
                match result {
                    Ok(result) => {
                        channel
                            .send(&ServerMessage::Control { request_id, result })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "control_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Goal {
                operation,
                project_key,
                request_id,
            } => {
                let result = crate::goal::execute(
                    &mut *store.lock().await,
                    &checkpoint_key,
                    &project_key,
                    operation,
                );
                match result {
                    Ok(result) => {
                        channel
                            .send(&ServerMessage::Goal { request_id, result })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "goal_rejected".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::SubmitArbitration {
                candidate_id,
                project_key,
                request_id,
                verdict,
                workflow_id,
            } => {
                let result = submit_arbitration(
                    &mut *store.lock().await,
                    &checkpoint_key,
                    &project_key,
                    workflow_id,
                    candidate_id,
                    &verdict,
                );
                match result {
                    Ok((receipt, workflow_state)) => {
                        channel
                            .send(&ServerMessage::ArbitrationRecorded {
                                decision: verdict.decision,
                                receipt_digest: receipt.digest(),
                                receipt: Box::new(receipt),
                                request_id,
                                workflow_id,
                                workflow_state,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "arbitration_rejected".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Health { request_id } => {
                channel
                    .send(&ServerMessage::Health {
                        request_id,
                        report: report.clone(),
                    })
                    .await?;
            }
            ClientMessage::FreezeCandidate {
                base_revision,
                candidate_id,
                evidence_ids,
                plan_id,
                project_key,
                request_id,
                workflow_id,
            } => {
                let result = freeze_candidate(
                    Arc::clone(&store),
                    Arc::clone(&checkpoint_key),
                    Arc::clone(&worktrees),
                    CandidateFreezeRequest {
                        base_revision,
                        candidate_id,
                        evidence_ids,
                        plan_id,
                        project_key,
                        workflow_id,
                    },
                )
                .await;
                match result {
                    Ok(manifest) => {
                        channel
                            .send(&ServerMessage::CandidateFrozen {
                                candidate_digest: manifest.digest(),
                                candidate_id,
                                manifest: Box::new(manifest),
                                request_id,
                                workflow_id,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "candidate_freeze_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::History {
                operation,
                project_key,
                request_id,
            } => {
                let result = {
                    let store = store.lock().await;
                    crate::history::execute(&store, &project_key, operation, &checkpoint_key)
                };
                match result {
                    Ok(result) => {
                        channel
                            .send(&ServerMessage::History { request_id, result })
                            .await?;
                    }
                    Err(error) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "history_failed".to_owned(),
                                message: error.to_string(),
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Memory {
                operation,
                project_key,
                request_id,
            } => match crate::memory::execute(&database, &project_key, operation) {
                Ok(result) => {
                    channel
                        .send(&ServerMessage::Memory { request_id, result })
                        .await?;
                }
                Err(error) => {
                    channel
                        .send(&ServerMessage::Error {
                            request_id: Some(request_id),
                            code: "memory_failed".to_owned(),
                            message: error.to_string(),
                        })
                        .await?;
                }
            },
            ClientMessage::PlanVerification {
                plan_id,
                project_key,
                request_id,
                workflow_id,
            } => {
                let result = plan_verification(
                    Arc::clone(&store),
                    Arc::clone(&worktrees),
                    plan_id,
                    project_key,
                    workflow_id,
                )
                .await;
                match result {
                    Ok(plan) => {
                        channel
                            .send(&ServerMessage::VerificationPlanned {
                                evidence_ids: plan.evidence_ids(),
                                plan_id,
                                request_id,
                                workflow_id,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "verification_plan_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::PromoteCandidate {
                candidate_id,
                project_directory,
                project_key,
                request_id,
                workflow_id,
            } => {
                let _delivery_guard = delivery_gate.lock().await;
                let project_id = workflow_core::ProjectId::from_stable_key(&project_key);
                let result = async {
                    if project_key.is_empty()
                        || project_key.len() > 32_768
                        || project_key.contains('\0')
                        || project_directory.is_empty()
                        || project_directory.len() > 32_768
                        || project_directory.contains('\0')
                    {
                        return Err("candidate promotion request is invalid".to_owned());
                    }
                    let repository = std::fs::canonicalize(&project_directory)
                        .map_err(|error| error.to_string())?;
                    let indexed_repository =
                        workflow_code_intel::graph::GraphStore::open(&*database)
                            .map_err(|error| error.to_string())?
                            .load_index_state(project_id)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "project repository identity is unavailable".to_owned())?
                            .0;
                    if repository.to_string_lossy() != indexed_repository {
                        return Err(
                            "candidate promotion repository does not match the indexed project"
                                .to_owned(),
                        );
                    }
                    let (candidate, exact_files, journal_digest) = {
                        let mut store = store.lock().await;
                        let state = store
                            .load_workflow(workflow_id)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "workflow state does not exist".to_owned())?;
                        if !matches!(
                            state.state(),
                            workflow_core::WorkflowState::Delivery
                                | workflow_core::WorkflowState::Completed
                        ) || state.current_candidate() != Some(candidate_id)
                        {
                            return Err(
                                "workflow is not awaiting delivery of this candidate".to_owned()
                            );
                        }
                        let candidate = store
                            .load_candidate(candidate_id)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "candidate does not exist".to_owned())?;
                        let (arbitration_owner, verdict, _) = store
                            .load_arbitration(candidate_id)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "approved arbitration does not exist".to_owned())?;
                        if candidate.workflow_id != workflow_id
                            || arbitration_owner != workflow_id
                            || verdict.decision != workflow_core::ArbiterDecision::Approved
                        {
                            return Err("candidate is not bound to an approved workflow".to_owned());
                        }
                        let exact_files = candidate
                            .require_exact_files()
                            .map_err(|error| error.to_string())?
                            .to_vec();
                        store
                            .reserve_candidate_delivery(
                                workflow_id,
                                candidate_id,
                                candidate.manifest.digest(),
                                workflow_core::WorkflowTimestamp::now(),
                            )
                            .map_err(|error| error.to_string())?;
                        let journal_digest = store
                            .candidate_delivery_journal_digest(workflow_id, candidate_id)
                            .map_err(|error| error.to_string())?;
                        (candidate, exact_files, journal_digest)
                    };
                    let candidate_digest = candidate.manifest.digest();
                    let database = Arc::clone(&database);
                    let promotion = tokio::task::spawn_blocking(move || {
                        let result = crate::candidate::promote_bound(
                            &repository,
                            &candidate.manifest,
                            &candidate.exact_diff,
                            &exact_files,
                            journal_digest,
                            |expected_digest, digest| {
                                let mut store = Store::open(
                                    &*database,
                                    NonZeroUsize::new(1).expect("one is non-zero"),
                                )
                                .map_err(|error| {
                                    crate::candidate::CandidateFreezeError::GitFailed(format!(
                                        "candidate delivery reservation binding failed: {error}"
                                    ))
                                })?;
                                store
                                    .bind_candidate_delivery_journal(
                                        workflow_id,
                                        candidate_id,
                                        candidate_digest,
                                        expected_digest,
                                        digest,
                                    )
                                    .map_err(|error| {
                                        crate::candidate::CandidateFreezeError::GitFailed(format!(
                                            "candidate delivery reservation binding failed: {error}"
                                        ))
                                    })
                            },
                        );
                        result.map_err(|error| {
                            let recovery_required = crate::candidate::delivery_recovery_required(
                                &repository,
                                candidate_id,
                            )
                            .unwrap_or(true);
                            (error.to_string(), recovery_required)
                        })
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                    let (changed_paths, journal_digest) = match promotion {
                        Ok(delivered) => delivered,
                        Err((message, false)) => {
                            store
                                .lock()
                                .await
                                .release_candidate_delivery(
                                    workflow_id,
                                    candidate_id,
                                    candidate_digest,
                                )
                                .map_err(|error| error.to_string())?;
                            return Err(message);
                        }
                        Err((message, true)) => return Err(message),
                    };
                    let mut store = store.lock().await;
                    let state = store
                        .load_workflow(workflow_id)
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| "workflow state does not exist".to_owned())?;
                    let current = store
                        .load_candidate(candidate_id)
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| "candidate does not exist".to_owned())?;
                    if !matches!(
                        state.state(),
                        workflow_core::WorkflowState::Delivery
                            | workflow_core::WorkflowState::Completed
                    ) || state.current_candidate() != Some(candidate_id)
                        || current.workflow_id != workflow_id
                        || current.manifest.digest() != candidate_digest
                    {
                        return Err("candidate state changed during promotion".to_owned());
                    }
                    let delivered_state = if state.state()
                        == workflow_core::WorkflowState::Completed
                    {
                        store
                            .release_candidate_delivery(workflow_id, candidate_id, candidate_digest)
                            .map_err(|error| error.to_string())?;
                        state.state()
                    } else {
                        store
                            .deliver_reserved_candidate(
                                workflow_id,
                                candidate_id,
                                candidate_digest,
                                journal_digest,
                                &format!("delivery:{candidate_id}"),
                                workflow_core::WorkflowTimestamp::now(),
                            )
                            .map_err(|error| error.to_string())?
                            .state
                            .state()
                    };
                    Ok((changed_paths, workflow_state(delivered_state)?))
                }
                .await;
                match result {
                    Ok((changed_paths, workflow_state)) => {
                        channel
                            .send(&ServerMessage::CandidatePromoted {
                                changed_paths,
                                request_id,
                                workflow_id,
                                workflow_state,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "candidate_promotion_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::ReportExecution {
                outcome,
                project_key,
                report_id,
                request_id,
                workflow_id,
            } => {
                let result = report_execution(
                    &mut *store.lock().await,
                    &project_key,
                    workflow_id,
                    outcome,
                    report_id,
                );
                match result {
                    Ok(workflow_state) => {
                        channel
                            .send(&ServerMessage::ExecutionReported {
                                request_id,
                                workflow_id,
                                workflow_state,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "execution_report_rejected".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Authenticate(_) => {
                return Err("connection attempted to authenticate more than once".into());
            }
            ClientMessage::Request(request) => {
                let mut store = store.lock().await;
                let response = handle_protocol_request(&mut store, &checkpoint_key, request);
                drop(store);
                channel.send(&ServerMessage::Response(response)).await?;
            }
            ClientMessage::SubmitReview {
                candidate_id,
                project_key,
                request_id,
                verdict,
                workflow_id,
            } => {
                let result = submit_review(
                    &mut *store.lock().await,
                    &checkpoint_key,
                    &project_key,
                    workflow_id,
                    candidate_id,
                    &verdict,
                );
                match result {
                    Ok(reviews_ready) => {
                        channel
                            .send(&ServerMessage::ReviewRecorded {
                                candidate_id,
                                request_id,
                                reviews_ready,
                                workflow_id,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "review_rejected".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::VerifyCandidate {
                attestations,
                candidate_id,
                plan_id,
                project_key,
                request_id,
                workflow_id,
            } => {
                let result = verify_candidate(
                    Arc::clone(&store),
                    Arc::clone(&checkpoint_key),
                    Arc::clone(&worktrees),
                    VerificationRequest {
                        attestations,
                        candidate_id,
                        plan_id,
                        project_key,
                        workflow_id,
                    },
                )
                .await;
                match result {
                    Ok((run, workflow_state)) => {
                        channel
                            .send(&ServerMessage::VerificationCompleted {
                                candidate_id,
                                evidence: run
                                    .records
                                    .iter()
                                    .map(|record| workflow_ipc::VerificationEvidence {
                                        output: run
                                            .outputs
                                            .get(&record.id)
                                            .cloned()
                                            .unwrap_or_default(),
                                        record: record.clone(),
                                    })
                                    .collect(),
                                mandatory_passed: run.mandatory_passed,
                                request_id,
                                workflow_id,
                                workflow_state,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "verification_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
            ClientMessage::Worktree {
                project_directory,
                project_key,
                request_id,
                workflow_id,
            } => {
                let project_id = {
                    let store = store.lock().await;
                    validate_worktree_request(&store, &project_key, workflow_id)
                };
                let result = match project_id {
                    Ok(project_id) => {
                        let worktrees = Arc::clone(&worktrees);
                        tokio::task::spawn_blocking(move || {
                            if project_directory.is_empty()
                                || project_directory.len() > 32_768
                                || project_directory.contains('\0')
                            {
                                return Err("project directory is invalid".to_owned());
                            }
                            crate::worktree::WorktreeManager::new(
                                Path::new(&project_directory),
                                &worktrees,
                            )
                            .and_then(|manager| manager.create(project_id, workflow_id))
                            .map_err(|error| error.to_string())
                        })
                        .await
                        .map_err(|error| format!("worktree task failed: {error}"))?
                    }
                    Err(error) => Err(error),
                };
                match result {
                    Ok(worktree) => {
                        let path = worktree
                            .path
                            .to_str()
                            .ok_or_else(|| "managed worktree path is not valid UTF-8".to_owned())?;
                        channel
                            .send(&ServerMessage::Worktree {
                                base_revision: worktree.base_revision,
                                path: path.to_owned(),
                                request_id,
                                workflow_id,
                            })
                            .await?;
                    }
                    Err(message) => {
                        channel
                            .send(&ServerMessage::Error {
                                request_id: Some(request_id),
                                code: "worktree_failed".to_owned(),
                                message,
                            })
                            .await?;
                    }
                }
            }
        }
    }
}

fn report_execution(
    store: &mut Store,
    project_key: &str,
    workflow_id: workflow_core::WorkflowId,
    outcome: workflow_ipc::ExecutionOutcome,
    report_id: workflow_core::ReceiptId,
) -> Result<String, String> {
    validate_project(
        store,
        workflow_core::ProjectId::from_stable_key(project_key),
        workflow_id,
    )?;
    let current = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    let command = match outcome {
        workflow_ipc::ExecutionOutcome::Blocked => {
            if matches!(
                current.state(),
                workflow_core::WorkflowState::Blocked
                    | workflow_core::WorkflowState::Cancelled
                    | workflow_core::WorkflowState::Completed
                    | workflow_core::WorkflowState::Paused
            ) {
                return Err("workflow cannot be blocked from its current state".to_owned());
            }
            workflow_core::WorkflowCommand::BlockInfrastructure
        }
        workflow_ipc::ExecutionOutcome::PlanDefect => {
            workflow_core::WorkflowCommand::ReplanExecution
        }
    };
    let state = store
        .apply_workflow_command(
            workflow_id,
            &format!("{workflow_id}:execution-report:{report_id}"),
            command,
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?
        .state;
    workflow_state(state.state())
}

fn submit_arbitration(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    project_key: &str,
    workflow_id: workflow_core::WorkflowId,
    candidate_id: workflow_core::CandidateId,
    verdict: &workflow_core::ArbiterVerdict,
) -> Result<(workflow_core::ArbitrationReceipt, String), String> {
    validate_project(
        store,
        workflow_core::ProjectId::from_stable_key(project_key),
        workflow_id,
    )?;
    if let Some((owner, existing_verdict, receipt)) = store
        .load_arbitration(candidate_id)
        .map_err(|error| error.to_string())?
    {
        if owner != workflow_id || existing_verdict != *verdict {
            return Err("candidate already has another arbitration verdict".to_owned());
        }
        let state = store
            .load_workflow(workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow state does not exist".to_owned())?;
        return Ok((receipt, workflow_state(state.state())?));
    }
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    if state.state() != workflow_core::WorkflowState::Arbitration
        || state.current_candidate() != Some(candidate_id)
    {
        return Err("workflow is not ready to arbitrate this candidate".to_owned());
    }
    let (_, request) = store
        .load_request(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "immutable workflow request does not exist".to_owned())?;
    let architecture = store
        .load_architecture(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow architecture does not exist".to_owned())?;
    let candidate = store
        .load_candidate(candidate_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "candidate does not exist".to_owned())?;
    if verdict.candidate_digest != candidate.manifest.digest() {
        return Err("arbiter verdict does not bind to the frozen candidate".to_owned());
    }
    let evidence = store
        .load_candidate_evidence(candidate_id)
        .map_err(|error| error.to_string())?;
    let evidence_ids: std::collections::BTreeSet<_> =
        evidence.iter().map(|(record, _, _)| record.id).collect();
    let requirements: std::collections::BTreeSet<_> = architecture
        .requirements
        .iter()
        .map(|requirement| requirement.id.clone())
        .collect();
    verdict
        .validate(&requirements, &evidence_ids)
        .map_err(|error| format!("arbiter verdict is invalid: {error:?}"))?;
    let reviews = store
        .load_reviews(candidate_id)
        .map_err(|error| error.to_string())?;
    let (functional_review_digest, security_review_digest, reviews_approved) = match state.mode() {
        Some(workflow_core::WorkflowMode::Full) => {
            if reviews.len() != 2
                || reviews
                    .iter()
                    .any(|review| review.candidate_digest != candidate.manifest.digest())
            {
                return Err("both independent candidate reviews are required".to_owned());
            }
            let functional = reviews
                .iter()
                .find(|review| review.role == workflow_core::WorkflowRole::FunctionalReviewer)
                .ok_or_else(|| "functional review is missing".to_owned())?;
            let security = reviews
                .iter()
                .find(|review| {
                    review.role == workflow_core::WorkflowRole::SecurityArchitectureReviewer
                })
                .ok_or_else(|| "security and architecture review is missing".to_owned())?;
            (
                Some(functional.digest()),
                Some(security.digest()),
                functional.decision == workflow_core::ReviewDecision::Approved
                    && security.decision == workflow_core::ReviewDecision::Approved,
            )
        }
        Some(workflow_core::WorkflowMode::Quick) => {
            if !reviews.is_empty() {
                return Err("quick workflows cannot include independent reviews".to_owned());
            }
            (None, None, true)
        }
        None => return Err("workflow does not have a routing mode".to_owned()),
    };
    if verdict.decision == workflow_core::ArbiterDecision::Approved
        && (!reviews_approved
            || evidence.iter().any(|(record, _, mandatory)| {
                *mandatory && record.status != workflow_core::EvidenceStatus::Passed
            }))
    {
        return Err("approval requirements have not passed".to_owned());
    }
    let timestamp = workflow_core::WorkflowTimestamp::now();
    let receipt = workflow_core::ArbitrationReceipt {
        arbiter_verdict_digest: verdict.digest(),
        candidate_digest: candidate.manifest.digest(),
        candidate_id,
        evidence_ids,
        finalized_at: timestamp,
        functional_review_digest,
        id: workflow_core::ReceiptId::new(),
        request_digest: request.digest(),
        security_review_digest,
        workflow_id,
    };
    store
        .save_arbitration_once(workflow_id, candidate_id, verdict, &receipt, timestamp)
        .map_err(|error| error.to_string())?;
    let next_state = match verdict.decision {
        workflow_core::ArbiterDecision::Approved => store
            .apply_workflow_command(
                workflow_id,
                &format!("{workflow_id}:{candidate_id}:approved"),
                workflow_core::WorkflowCommand::Approve {
                    mandatory_gates_passed: true,
                },
                timestamp,
            )
            .map_err(|error| error.to_string())?
            .state
            .state(),
        workflow_core::ArbiterDecision::Rejected => {
            crate::repair::route(
                store,
                workflow_id,
                candidate_id,
                match verdict.repair_target {
                    Some(workflow_core::RepairTarget::Architecture) => {
                        crate::repair::RepairCause::PlanDefect
                    }
                    Some(workflow_core::RepairTarget::Execution) => {
                        crate::repair::RepairCause::ImplementationFinding
                    }
                    None => return Err("rejected verdict lacks a repair target".to_owned()),
                },
                timestamp,
            )
            .map_err(|error| error.to_string())?
            .state
        }
    };
    crate::audit::record(
        store,
        checkpoint_key,
        workflow_ipc::audit::AuditObservation {
            actor_id: "workflowd".to_owned(),
            candidate_id: Some(candidate_id),
            data: workflow_ipc::audit::AuditData::Workflow {
                action: match verdict.decision {
                    workflow_core::ArbiterDecision::Approved => "arbitration_approved",
                    workflow_core::ArbiterDecision::Rejected => "arbitration_rejected",
                }
                .to_owned(),
            },
            evidence_ids: receipt.evidence_ids.clone(),
            files: candidate
                .manifest
                .files()
                .iter()
                .map(|file| file.path.clone())
                .collect(),
            metadata: std::collections::BTreeMap::from([(
                "receipt_digest".to_owned(),
                receipt.digest().to_string(),
            )]),
            model: None,
            project_key: project_key.to_owned(),
            role: Some(workflow_core::WorkflowRole::Arbiter),
            session_id: None,
            task_id: None,
            timestamp_unix_millis: now_unix_millis().map_err(|error| error.to_string())?,
            workflow_id: Some(workflow_id),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok((receipt, workflow_state(next_state)?))
}

fn submit_review(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    project_key: &str,
    workflow_id: workflow_core::WorkflowId,
    candidate_id: workflow_core::CandidateId,
    verdict: &workflow_core::ReviewVerdict,
) -> Result<bool, String> {
    validate_project(
        store,
        workflow_core::ProjectId::from_stable_key(project_key),
        workflow_id,
    )?;
    let duplicate = store
        .save_review_once(
            workflow_id,
            candidate_id,
            verdict,
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?;
    if !duplicate {
        crate::audit::record(
            store,
            checkpoint_key,
            workflow_ipc::audit::AuditObservation {
                actor_id: "workflowd".to_owned(),
                candidate_id: Some(candidate_id),
                data: workflow_ipc::audit::AuditData::Workflow {
                    action: "independent_review_finalized".to_owned(),
                },
                evidence_ids: verdict
                    .requirements
                    .iter()
                    .flat_map(|requirement| requirement.evidence_ids.iter().copied())
                    .chain(
                        verdict
                            .findings
                            .iter()
                            .flat_map(|finding| finding.evidence_ids.iter().copied()),
                    )
                    .collect(),
                files: Default::default(),
                metadata: std::collections::BTreeMap::from([(
                    "review_role".to_owned(),
                    review_role_name(verdict.role)?.to_owned(),
                )]),
                model: None,
                project_key: project_key.to_owned(),
                role: Some(verdict.role),
                session_id: None,
                task_id: None,
                timestamp_unix_millis: now_unix_millis().map_err(|error| error.to_string())?,
                workflow_id: Some(workflow_id),
            },
        )
        .map_err(|error| error.to_string())?;
    }
    let reviews_ready = store
        .load_reviews(candidate_id)
        .map_err(|error| error.to_string())?
        .len()
        == 2;
    if reviews_ready {
        let state = store
            .load_workflow(workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow state does not exist".to_owned())?;
        if state.state() == workflow_core::WorkflowState::IndependentReviews {
            store
                .apply_workflow_command(
                    workflow_id,
                    &format!("{workflow_id}:{candidate_id}:reviews-ready"),
                    workflow_core::WorkflowCommand::ReviewsReady,
                    workflow_core::WorkflowTimestamp::now(),
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(reviews_ready)
}

fn review_role_name(role: workflow_core::WorkflowRole) -> Result<&'static str, String> {
    match role {
        workflow_core::WorkflowRole::FunctionalReviewer => Ok("functional_reviewer"),
        workflow_core::WorkflowRole::SecurityArchitectureReviewer => {
            Ok("security_architecture_reviewer")
        }
        workflow_core::WorkflowRole::Architect
        | workflow_core::WorkflowRole::Executor
        | workflow_core::WorkflowRole::Arbiter => {
            Err("role is not an independent reviewer".to_owned())
        }
    }
}

async fn plan_verification(
    store: Arc<tokio::sync::Mutex<Store>>,
    worktrees: Arc<PathBuf>,
    plan_id: workflow_core::VerificationPlanId,
    project_key: String,
    workflow_id: workflow_core::WorkflowId,
) -> Result<crate::verification::VerificationPlan, String> {
    let project_id = workflow_core::ProjectId::from_stable_key(&project_key);
    let architecture = {
        let store = store.lock().await;
        validate_project(&store, project_id, workflow_id)?;
        if let Some((owner, value)) = store
            .load_verification_plan(plan_id)
            .map_err(|error| error.to_string())?
        {
            if owner != workflow_id {
                return Err("verification plan belongs to another workflow".to_owned());
            }
            return serde_json::from_value(value).map_err(|error| error.to_string());
        }
        let state = store
            .load_workflow(workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow state does not exist".to_owned())?;
        if !matches!(
            state.state(),
            workflow_core::WorkflowState::Execution | workflow_core::WorkflowState::QuickExecution
        ) {
            return Err("workflow is not ready to plan verification".to_owned());
        }
        store
            .load_architecture(workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow architecture does not exist".to_owned())?
    };
    let path = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    let plan = tokio::task::spawn_blocking(move || {
        crate::verification::discover_for(&path, &architecture, plan_id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("verification planning task failed: {error}"))??;
    let value = serde_json::to_value(&plan).map_err(|error| error.to_string())?;
    let mut store = store.lock().await;
    validate_project(&store, project_id, workflow_id)?;
    store
        .save_verification_plan_once(
            plan_id,
            workflow_id,
            &value,
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?;
    Ok(plan)
}

struct VerificationRequest {
    attestations: Vec<workflow_ipc::ManagedBrowserAttestation>,
    candidate_id: workflow_core::CandidateId,
    plan_id: workflow_core::VerificationPlanId,
    project_key: String,
    workflow_id: workflow_core::WorkflowId,
}

async fn verify_candidate(
    store: Arc<tokio::sync::Mutex<Store>>,
    checkpoint_key: Arc<CheckpointKey>,
    worktrees: Arc<PathBuf>,
    request: VerificationRequest,
) -> Result<(crate::verification::VerificationRun, String), String> {
    let project_id = workflow_core::ProjectId::from_stable_key(&request.project_key);
    let (plan, manifest, exact_diff, exact_files) = {
        let store = store.lock().await;
        validate_project(&store, project_id, request.workflow_id)?;
        let state = store
            .load_workflow(request.workflow_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "workflow state does not exist".to_owned())?;
        if state.state() != workflow_core::WorkflowState::Verification
            || state.current_candidate() != Some(request.candidate_id)
        {
            return Err("workflow is not ready to verify this candidate".to_owned());
        }
        let (plan_owner, plan) = store
            .load_verification_plan(request.plan_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "verification plan does not exist".to_owned())?;
        let candidate = store
            .load_candidate(request.candidate_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "candidate does not exist".to_owned())?;
        if plan_owner != request.workflow_id || candidate.workflow_id != request.workflow_id {
            return Err("verification inputs belong to another workflow".to_owned());
        }
        let exact_files = candidate
            .require_exact_files()
            .map_err(|error| error.to_string())?
            .to_vec();
        (
            serde_json::from_value::<crate::verification::VerificationPlan>(plan)
                .map_err(|error| error.to_string())?,
            candidate.manifest,
            candidate.exact_diff,
            exact_files,
        )
    };
    let path = worktrees
        .join(project_id.to_string())
        .join(request.workflow_id.to_string());
    let run = crate::verification::run_with_attestations(
        &path,
        &plan,
        &manifest,
        &exact_diff,
        &exact_files,
        &request.attestations,
    )
    .await
    .map_err(|error| error.to_string())?;
    let mut store = store.lock().await;
    validate_project(&store, project_id, request.workflow_id)?;
    for (gate, record) in plan.gates.iter().zip(&run.records) {
        let output = run
            .outputs
            .get(&record.id)
            .ok_or_else(|| "verification output is missing".to_owned())?;
        store
            .save_evidence_once(
                request.plan_id,
                request.workflow_id,
                request.candidate_id,
                record,
                output,
                gate.mandatory,
                workflow_core::WorkflowTimestamp::now(),
            )
            .map_err(|error| error.to_string())?;
        crate::audit::record(
            &mut store,
            &checkpoint_key,
            workflow_ipc::audit::AuditObservation {
                actor_id: "workflowd".to_owned(),
                candidate_id: Some(request.candidate_id),
                data: workflow_ipc::audit::AuditData::Verification {
                    gate: gate.name.clone(),
                    status: serde_json::to_value(record.status)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_owned))
                        .unwrap_or_else(|| "unknown".to_owned()),
                },
                evidence_ids: [record.id].into_iter().collect(),
                files: manifest
                    .files()
                    .iter()
                    .map(|file| file.path.clone())
                    .collect(),
                metadata: std::collections::BTreeMap::from([(
                    "output_digest".to_owned(),
                    record.output_digest.to_string(),
                )]),
                model: None,
                project_key: request.project_key.clone(),
                role: None,
                session_id: None,
                task_id: None,
                timestamp_unix_millis: now_unix_millis().map_err(|error| error.to_string())?,
                workflow_id: Some(request.workflow_id),
            },
        )
        .map_err(|error| error.to_string())?;
    }
    let state = if run.mandatory_passed {
        store
            .apply_workflow_command(
                request.workflow_id,
                &format!(
                    "{}:{}:verification-passed",
                    request.workflow_id, request.candidate_id
                ),
                workflow_core::WorkflowCommand::VerificationPassed,
                workflow_core::WorkflowTimestamp::now(),
            )
            .map_err(|error| error.to_string())?
            .state
    } else if run.infrastructure_blocked {
        store
            .apply_workflow_command(
                request.workflow_id,
                &format!(
                    "{}:{}:verification-blocked",
                    request.workflow_id, request.candidate_id
                ),
                workflow_core::WorkflowCommand::BlockInfrastructure,
                workflow_core::WorkflowTimestamp::now(),
            )
            .map_err(|error| error.to_string())?
            .state
    } else {
        let outcome = crate::repair::route(
            &mut store,
            request.workflow_id,
            request.candidate_id,
            crate::repair::RepairCause::ImplementationFinding,
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?;
        return Ok((run, workflow_state(outcome.state)?));
    };
    Ok((run, workflow_state(state.state())?))
}

fn workflow_state(state: workflow_core::WorkflowState) -> Result<String, String> {
    serde_json::to_value(state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| "workflow state could not be serialized".to_owned())
}

struct CandidateFreezeRequest {
    base_revision: String,
    candidate_id: workflow_core::CandidateId,
    evidence_ids: Vec<workflow_core::EvidenceId>,
    plan_id: workflow_core::VerificationPlanId,
    project_key: String,
    workflow_id: workflow_core::WorkflowId,
}

async fn freeze_candidate(
    store: Arc<tokio::sync::Mutex<Store>>,
    checkpoint_key: Arc<CheckpointKey>,
    worktrees: Arc<PathBuf>,
    request: CandidateFreezeRequest,
) -> Result<workflow_core::CandidateManifest, String> {
    let project_id = workflow_core::ProjectId::from_stable_key(&request.project_key);
    {
        let mut store = store.lock().await;
        validate_project(&store, project_id, request.workflow_id)?;
        let (plan_owner, plan) = store
            .load_verification_plan(request.plan_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "verification plan does not exist".to_owned())?;
        if plan_owner != request.workflow_id {
            return Err("verification plan belongs to another workflow".to_owned());
        }
        let plan: crate::verification::VerificationPlan =
            serde_json::from_value(plan).map_err(|error| error.to_string())?;
        let planned: std::collections::BTreeSet<_> = plan.evidence_ids().into_iter().collect();
        let supplied: std::collections::BTreeSet<_> =
            request.evidence_ids.iter().copied().collect();
        if planned != supplied || planned.len() != request.evidence_ids.len() {
            return Err(
                "candidate evidence identifiers do not match the verification plan".to_owned(),
            );
        }
        if let Some(candidate) = store
            .load_candidate(request.candidate_id)
            .map_err(|error| error.to_string())?
        {
            if candidate.workflow_id != request.workflow_id {
                return Err("candidate belongs to another workflow".to_owned());
            }
            candidate
                .require_exact_files()
                .map_err(|error| error.to_string())?;
            let state = store
                .load_workflow(request.workflow_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "workflow state does not exist".to_owned())?;
            if matches!(
                state.state(),
                workflow_core::WorkflowState::Execution
                    | workflow_core::WorkflowState::QuickExecution
            ) {
                store
                    .apply_workflow_command(
                        request.workflow_id,
                        &format!("{}:candidate:{}", request.workflow_id, request.candidate_id),
                        workflow_core::WorkflowCommand::CandidateReady(request.candidate_id),
                        workflow_core::WorkflowTimestamp::now(),
                    )
                    .map_err(|error| error.to_string())?;
            } else if state.state() != workflow_core::WorkflowState::Verification
                || state.current_candidate() != Some(request.candidate_id)
            {
                return Err("workflow no longer accepts this candidate".to_owned());
            }
            return Ok(candidate.manifest);
        }
        validate_candidate_state(&store, request.workflow_id, request.candidate_id)?;
    }
    let path = worktrees
        .join(project_id.to_string())
        .join(request.workflow_id.to_string());
    let base_revision = request.base_revision.clone();
    let evidence_ids = request.evidence_ids.clone();
    let candidate_id = request.candidate_id;
    let frozen = tokio::task::spawn_blocking(move || {
        crate::candidate::freeze(&path, &base_revision, candidate_id, evidence_ids)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("candidate freeze task failed: {error}"))??;

    let mut store = store.lock().await;
    validate_project(&store, project_id, request.workflow_id)?;
    validate_candidate_state(&store, request.workflow_id, request.candidate_id)?;
    store
        .save_candidate_once(
            request.workflow_id,
            &frozen.manifest,
            &frozen.exact_diff,
            &frozen.exact_files,
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?;
    store
        .apply_workflow_command(
            request.workflow_id,
            &format!("{}:candidate:{}", request.workflow_id, request.candidate_id),
            workflow_core::WorkflowCommand::CandidateReady(request.candidate_id),
            workflow_core::WorkflowTimestamp::now(),
        )
        .map_err(|error| error.to_string())?;
    crate::audit::record(
        &mut store,
        &checkpoint_key,
        workflow_ipc::audit::AuditObservation {
            actor_id: "workflowd".to_owned(),
            candidate_id: Some(request.candidate_id),
            data: workflow_ipc::audit::AuditData::Workflow {
                action: "candidate_frozen".to_owned(),
            },
            evidence_ids: frozen.manifest.evidence_ids().iter().copied().collect(),
            files: frozen
                .manifest
                .files()
                .iter()
                .map(|file| file.path.clone())
                .collect(),
            metadata: std::collections::BTreeMap::from([(
                "candidate_digest".to_owned(),
                frozen.manifest.digest().to_string(),
            )]),
            model: None,
            project_key: request.project_key,
            role: None,
            session_id: None,
            task_id: None,
            timestamp_unix_millis: now_unix_millis().map_err(|error| error.to_string())?,
            workflow_id: Some(request.workflow_id),
        },
    )
    .map_err(|error| error.to_string())?;
    Ok(frozen.manifest)
}

fn validate_project(
    store: &Store,
    project_id: workflow_core::ProjectId,
    workflow_id: workflow_core::WorkflowId,
) -> Result<(), String> {
    let (stored_project, _) = store
        .load_request(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow request does not exist".to_owned())?;
    if project_id == stored_project {
        Ok(())
    } else {
        Err("workflow belongs to another project".to_owned())
    }
}

fn validate_candidate_state(
    store: &Store,
    workflow_id: workflow_core::WorkflowId,
    candidate_id: workflow_core::CandidateId,
) -> Result<(), String> {
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    if state.state() == workflow_core::WorkflowState::Execution
        || state.state() == workflow_core::WorkflowState::QuickExecution
        || state.state() == workflow_core::WorkflowState::Verification
            && state.current_candidate() == Some(candidate_id)
    {
        Ok(())
    } else {
        Err("workflow is not ready to freeze this candidate".to_owned())
    }
}

fn validate_worktree_request(
    store: &Store,
    project_key: &str,
    workflow_id: workflow_core::WorkflowId,
) -> Result<workflow_core::ProjectId, String> {
    let project_id = workflow_core::ProjectId::from_stable_key(project_key);
    let (stored_project, _) = store
        .load_request(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow request does not exist".to_owned())?;
    if project_id != stored_project {
        return Err("workflow belongs to another project".to_owned());
    }
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    if !matches!(
        state.state(),
        workflow_core::WorkflowState::Execution | workflow_core::WorkflowState::QuickExecution
    ) || store
        .load_architecture(workflow_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("workflow is not ready for isolated execution".to_owned());
    }
    Ok(project_id)
}

fn handle_protocol_request(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    request: IpcRequest,
) -> IpcResponse {
    let request_id = request.request_id;
    match process_protocol_request(store, checkpoint_key, request) {
        Ok((workflow_id, mode, envelope)) => {
            let request_digest = match &envelope.payload {
                workflow_core::ProtocolPayload::Request(request) => request.digest(),
                workflow_core::ProtocolPayload::Architecture(plan) => plan.request_digest,
                workflow_core::ProtocolPayload::Candidate(candidate) => candidate.digest(),
                workflow_core::ProtocolPayload::Evidence(evidence) => evidence.candidate_digest,
                workflow_core::ProtocolPayload::Verdict(verdict) => verdict.candidate_digest,
            };
            IpcResponse::Accepted {
                mode,
                request_digest,
                request_id,
                workflow_id,
                envelope: Box::new(envelope),
            }
        }
        Err((code, message)) => IpcResponse::Rejected {
            request_id,
            code: code.to_owned(),
            message,
        },
    }
}

fn process_protocol_request(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    request: IpcRequest,
) -> Result<
    (
        workflow_core::WorkflowId,
        workflow_core::WorkflowMode,
        workflow_core::ProtocolEnvelope,
    ),
    (&'static str, String),
> {
    match &request.envelope.payload {
        workflow_core::ProtocolPayload::Request(_) => {
            start_workflow(store, checkpoint_key, request)
        }
        workflow_core::ProtocolPayload::Architecture(_) => {
            accept_architecture(store, checkpoint_key, request)
        }
        _ => Err((
            "operation_unavailable",
            "the protocol payload is not accepted in the current implementation stage".to_owned(),
        )),
    }
}

fn start_workflow(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    request: IpcRequest,
) -> Result<
    (
        workflow_core::WorkflowId,
        workflow_core::WorkflowMode,
        workflow_core::ProtocolEnvelope,
    ),
    (&'static str, String),
> {
    if request.project_key.trim().is_empty() || request.project_key.len() > 1_024 {
        return Err(("invalid_project", "project key is invalid".to_owned()));
    }
    if request.affected_paths.len() > 10_000
        || request
            .affected_paths
            .iter()
            .any(|path| !safe_relative(path))
    {
        return Err((
            "invalid_path",
            "affected paths must be bounded project-relative paths".to_owned(),
        ));
    }
    let workflow_id = request.workflow_id.unwrap_or_default();
    let record = match &request.envelope.payload {
        workflow_core::ProtocolPayload::Request(record) => record,
        _ => {
            return Err((
                "invalid_payload",
                "a new workflow requires an immutable request payload".to_owned(),
            ));
        }
    };
    let timestamp = workflow_core::WorkflowTimestamp::now();
    let project_id = workflow_core::ProjectId::from_stable_key(&request.project_key);
    store
        .save_request_once(workflow_id, project_id, record, timestamp)
        .map_err(|error| ("request_rejected", error.to_string()))?;
    let state = match store
        .load_workflow(workflow_id)
        .map_err(|error| ("intake_failed", error.to_string()))?
    {
        None => {
            store
                .apply_workflow_command(
                    workflow_id,
                    &format!("{workflow_id}:complete-intake"),
                    workflow_core::WorkflowCommand::CompleteIntake,
                    timestamp,
                )
                .map_err(|error| ("intake_failed", error.to_string()))?
                .state
        }
        Some(state) => state,
    };
    if state.state() == workflow_core::WorkflowState::Routing {
        let evidence =
            crate::routing::automatic_evidence(record.original_text(), &request.affected_paths);
        let routed = crate::routing::decide_and_record(
            store,
            checkpoint_key,
            crate::routing::RoutingRequest {
                critical_downgrade_approval: request.critical_downgrade_approval,
                evidence,
                preference: request.routing_preference,
                project_key: request.project_key,
                timestamp_unix_millis: now_unix_millis()
                    .map_err(|error| ("clock_failed", error.to_string()))?,
                workflow_id,
            },
        )
        .map_err(|error| ("routing_failed", error.to_string()))?;
        store
            .apply_workflow_command(
                workflow_id,
                &format!("{workflow_id}:route"),
                workflow_core::WorkflowCommand::Route(routed.decision.mode),
                timestamp,
            )
            .map_err(|error| ("routing_failed", error.to_string()))?;
    }
    let mode = store
        .load_workflow(workflow_id)
        .map_err(|error| ("routing_failed", error.to_string()))?
        .and_then(|workflow| workflow.mode())
        .ok_or_else(|| {
            (
                "routing_failed",
                "workflow did not reach a routed state".to_owned(),
            )
        })?;
    Ok((workflow_id, mode, request.envelope))
}

fn accept_architecture(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    request: IpcRequest,
) -> Result<
    (
        workflow_core::WorkflowId,
        workflow_core::WorkflowMode,
        workflow_core::ProtocolEnvelope,
    ),
    (&'static str, String),
> {
    let workflow_id = request.workflow_id.ok_or_else(|| {
        (
            "missing_workflow",
            "architecture submission requires a workflow identifier".to_owned(),
        )
    })?;
    let plan = match &request.envelope.payload {
        workflow_core::ProtocolPayload::Architecture(plan) => plan,
        _ => unreachable!("protocol request dispatcher verified the payload"),
    };
    let (project_id, _) = store
        .load_request(workflow_id)
        .map_err(|error| ("architecture_rejected", error.to_string()))?
        .ok_or_else(|| {
            (
                "missing_workflow",
                "workflow request does not exist".to_owned(),
            )
        })?;
    if project_id != workflow_core::ProjectId::from_stable_key(&request.project_key) {
        return Err((
            "project_mismatch",
            "workflow belongs to another project".to_owned(),
        ));
    }
    let timestamp = workflow_core::WorkflowTimestamp::now();
    store
        .save_architecture_once(workflow_id, plan, timestamp)
        .map_err(|error| ("architecture_rejected", error.to_string()))?;
    let essentiality = crate::essentiality::EssentialityPolicy::default();
    let essentiality_value = serde_json::to_value(&essentiality)
        .map_err(|error| ("constraint_failed", error.to_string()))?;
    let duplicate_constraint = store
        .save_constraint_once(
            workflow_id,
            "essentiality",
            essentiality.digest(),
            &essentiality_value,
            timestamp,
        )
        .map_err(|error| ("constraint_failed", error.to_string()))?;
    if !duplicate_constraint {
        crate::audit::record(
            store,
            checkpoint_key,
            workflow_ipc::audit::AuditObservation {
                actor_id: "workflowd".to_owned(),
                candidate_id: None,
                data: workflow_ipc::audit::AuditData::Workflow {
                    action: "essentiality_constraint_recorded".to_owned(),
                },
                evidence_ids: Default::default(),
                files: Default::default(),
                metadata: std::collections::BTreeMap::from([(
                    "constraint_digest".to_owned(),
                    essentiality.digest().to_string(),
                )]),
                model: None,
                project_key: request.project_key.clone(),
                role: None,
                session_id: None,
                task_id: None,
                timestamp_unix_millis: now_unix_millis()
                    .map_err(|error| ("clock_failed", error.to_string()))?,
                workflow_id: Some(workflow_id),
            },
        )
        .map_err(|error| ("constraint_failed", error.to_string()))?;
    }
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| ("architecture_rejected", error.to_string()))?
        .ok_or_else(|| {
            (
                "missing_workflow",
                "workflow state does not exist".to_owned(),
            )
        })?;
    if state.state() == workflow_core::WorkflowState::Architecture {
        store
            .apply_workflow_command(
                workflow_id,
                &format!("{workflow_id}:architecture-accepted:{}", plan.digest()),
                workflow_core::WorkflowCommand::ArchitectureAccepted,
                timestamp,
            )
            .map_err(|error| ("architecture_rejected", error.to_string()))?;
    } else if !matches!(
        state.state(),
        workflow_core::WorkflowState::Execution | workflow_core::WorkflowState::QuickExecution
    ) {
        return Err((
            "invalid_state",
            "workflow is not awaiting an architecture plan".to_owned(),
        ));
    }
    let mode = state.mode().ok_or_else(|| {
        (
            "routing_failed",
            "workflow does not have a routing mode".to_owned(),
        )
    })?;
    Ok((workflow_id, mode, request.envelope))
}

fn safe_relative(value: &str) -> bool {
    let path = std::path::Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn admission_allowed(
    operation: workflow_ipc::AdmissionOperation,
    state: workflow_core::WorkflowState,
) -> bool {
    operation == workflow_ipc::AdmissionOperation::Release
        || !matches!(
            state,
            workflow_core::WorkflowState::Paused
                | workflow_core::WorkflowState::Blocked
                | workflow_core::WorkflowState::Completed
                | workflow_core::WorkflowState::Cancelled
        )
}

fn now_unix_millis() -> Result<i64, std::time::SystemTimeError> {
    Ok(
        i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())
            .expect("supported timestamps fit in i64"),
    )
}

struct RuntimePaths {
    checkpoint_key: PathBuf,
    database: PathBuf,
    runtime: PathBuf,
    secret: PathBuf,
    worktrees: PathBuf,
    #[cfg(unix)]
    socket: PathBuf,
}

impl RuntimePaths {
    fn new(root: &Path) -> Self {
        let runtime = root.join("runtime");
        Self {
            checkpoint_key: runtime.join("ledger.key"),
            database: root.join("control-plane.db"),
            secret: runtime.join("ipc.secret"),
            worktrees: root.join("worktrees"),
            #[cfg(unix)]
            socket: runtime.join("workflow.sock"),
            runtime,
        }
    }
}

#[cfg(test)]
mod tests {
    use workflow_core::WorkflowState;
    use workflow_ipc::AdmissionOperation;

    use super::admission_allowed;

    #[test]
    fn terminal_and_suspended_workflows_cannot_reenter_admission() {
        for state in [
            WorkflowState::Paused,
            WorkflowState::Blocked,
            WorkflowState::Completed,
            WorkflowState::Cancelled,
        ] {
            assert!(!admission_allowed(AdmissionOperation::Acquire, state));
            assert!(!admission_allowed(AdmissionOperation::Renew, state));
            assert!(admission_allowed(AdmissionOperation::Release, state));
        }
        assert!(admission_allowed(
            AdmissionOperation::Acquire,
            WorkflowState::Architecture,
        ));
    }
}
