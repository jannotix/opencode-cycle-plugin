use std::path::Path;

use serde_json::{Value, json};
use workflow_core::{ProjectId, ReceiptId, WorkflowCommand, WorkflowState, WorkflowTimestamp};
use workflow_ipc::ControlOperation;
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

pub fn execute(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    worktrees: &Path,
    project_key: &str,
    requested_workflow_id: Option<workflow_core::WorkflowId>,
    operation: ControlOperation,
    operation_id: ReceiptId,
) -> Result<Value, String> {
    if project_key.is_empty() || project_key.len() > 32_768 || project_key.contains('\0') {
        return Err("project key is invalid".to_owned());
    }
    if operation == ControlOperation::Doctor {
        return doctor(store, checkpoint_key);
    }
    let project_id = ProjectId::from_stable_key(project_key);
    let workflow_id = if let Some(workflow_id) = requested_workflow_id {
        let owner = store
            .load_request(workflow_id)
            .map_err(|error| error.to_string())?
            .map(|(owner, _)| owner);
        if owner != Some(project_id) {
            return Err("workflow does not belong to the project".to_owned());
        }
        workflow_id
    } else {
        store
            .latest_workflow_for_project(project_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project has no workflow".to_owned())?
    };
    let state = store
        .load_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow state does not exist".to_owned())?;
    match operation {
        ControlOperation::Status => Ok(json!({
            "currentCandidate": state.current_candidate(),
            "maximumRepairCycles": state.max_repair_cycles(),
            "mode": state.mode(),
            "repairCycles": state.repair_cycles(),
            "state": state.state(),
            "workflowId": workflow_id,
        })),
        ControlOperation::Tasks => {
            let tasks = store
                .load_workflow_tasks(workflow_id)
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|(task_id, task)| json!({ "state": task.state(), "taskId": task_id }))
                .collect::<Vec<_>>();
            Ok(json!({ "tasks": tasks, "workflowId": workflow_id }))
        }
        ControlOperation::Evidence => {
            let evidence = state
                .current_candidate()
                .map(|candidate_id| {
                    store
                        .load_candidate_evidence(candidate_id)
                        .map(|records| {
                            records
                                .into_iter()
                                .map(|(record, _, mandatory)| {
                                    json!({ "mandatory": mandatory, "record": record })
                                })
                                .collect::<Vec<_>>()
                        })
                        .map_err(|error| error.to_string())
                })
                .transpose()?
                .unwrap_or_default();
            Ok(json!({
                "candidateId": state.current_candidate(),
                "evidence": evidence,
                "workflowId": workflow_id,
            }))
        }
        ControlOperation::Recovery => recovery(store, worktrees, project_id, workflow_id, &state),
        ControlOperation::Pause
        | ControlOperation::Resume
        | ControlOperation::Cancel
        | ControlOperation::Retry => {
            if operation == ControlOperation::Retry && state.state() == WorkflowState::Delivery {
                return Ok(json!({
                    "duplicate": true,
                    "state": state.state(),
                    "workflowId": workflow_id,
                }));
            }
            if store
                .workflow_delivery_reserved(workflow_id)
                .map_err(|error| error.to_string())?
            {
                return Err("workflow candidate delivery is in progress".to_owned());
            }
            let command = command(operation, state.state());
            let result = store
                .apply_workflow_command(
                    workflow_id,
                    &format!("control:{operation_id}"),
                    command,
                    WorkflowTimestamp::now(),
                )
                .or_else(|error| {
                    if operation == ControlOperation::Retry
                        && state.state() == WorkflowState::Blocked
                    {
                        store.apply_workflow_command(
                            workflow_id,
                            &format!("control:{operation_id}"),
                            WorkflowCommand::ResumeBlocked {
                                additional_cycles: 5,
                            },
                            WorkflowTimestamp::now(),
                        )
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| error.to_string())?;
            Ok(json!({
                "duplicate": result.duplicate,
                "state": result.state.state(),
                "workflowId": workflow_id,
            }))
        }
        ControlOperation::Doctor => unreachable!("doctor is handled before workflow lookup"),
    }
}

fn command(operation: ControlOperation, state: WorkflowState) -> WorkflowCommand {
    match operation {
        ControlOperation::Pause => WorkflowCommand::Pause,
        ControlOperation::Resume => WorkflowCommand::Resume,
        ControlOperation::Cancel => WorkflowCommand::Cancel,
        ControlOperation::Retry if state == WorkflowState::Blocked => {
            WorkflowCommand::ResumeInfrastructure
        }
        ControlOperation::Retry => WorkflowCommand::RetryInfrastructure,
        ControlOperation::Doctor
        | ControlOperation::Evidence
        | ControlOperation::Recovery
        | ControlOperation::Status
        | ControlOperation::Tasks => {
            unreachable!("read operation cannot become a workflow command")
        }
    }
}

fn recovery(
    store: &Store,
    worktrees: &Path,
    project_id: ProjectId,
    workflow_id: workflow_core::WorkflowId,
    state: &workflow_core::Workflow,
) -> Result<Value, String> {
    let (_, request) = store
        .load_request(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow request does not exist".to_owned())?;
    if matches!(
        state.state(),
        WorkflowState::Architecture | WorkflowState::Execution | WorkflowState::QuickExecution
    ) {
        return early_recovery(store, worktrees, project_id, workflow_id, state, &request);
    }
    if !matches!(
        state.state(),
        WorkflowState::Verification
            | WorkflowState::IndependentReviews
            | WorkflowState::Arbitration
            | WorkflowState::Delivery
    ) {
        return Err("workflow is not in a recoverable finalization state".to_owned());
    }
    let plan = store
        .load_architecture(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow architecture does not exist".to_owned())?;
    let candidate_id = state
        .current_candidate()
        .ok_or_else(|| "workflow has no current candidate".to_owned())?;
    let candidate = store
        .load_candidate(candidate_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow candidate does not exist".to_owned())?;
    if candidate.workflow_id != workflow_id {
        return Err("workflow candidate ownership is invalid".to_owned());
    }
    let (verification_plan_id, _) = store
        .load_latest_verification_plan_for_workflow(workflow_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "workflow verification plan does not exist".to_owned())?;
    let evidence = store
        .load_candidate_evidence(candidate_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(record, output, mandatory)| {
            json!({ "mandatory": mandatory, "output": output, "record": record })
        })
        .collect::<Vec<_>>();
    let reviews = store
        .load_reviews(candidate_id)
        .map_err(|error| error.to_string())?;
    let executor_session_ids = store
        .load_role_session_ids(workflow_id, workflow_core::WorkflowRole::Executor)
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "candidateDigest": candidate.manifest.digest(),
        "candidateId": candidate_id,
        "evidence": evidence,
        "executorSessionIds": executor_session_ids,
        "manifest": candidate.manifest,
        "mode": state.mode(),
        "originalRequest": request.original_text(),
        "plan": plan,
        "reviews": reviews,
        "state": state.state(),
        "verificationPlanId": verification_plan_id,
        "workflowId": workflow_id,
        "worktreePath": worktrees.join(project_id.to_string()).join(workflow_id.to_string()),
    }))
}

fn early_recovery(
    store: &Store,
    worktrees: &Path,
    project_id: ProjectId,
    workflow_id: workflow_core::WorkflowId,
    state: &workflow_core::Workflow,
    request: &workflow_core::RequestRecord,
) -> Result<Value, String> {
    let mode = state
        .mode()
        .ok_or_else(|| "workflow mode does not exist".to_owned())?;
    let candidate = store
        .load_latest_candidate_for_workflow(workflow_id)
        .map_err(|error| error.to_string())?;
    if candidate
        .as_ref()
        .is_some_and(|candidate| candidate.workflow_id != workflow_id)
    {
        return Err("workflow candidate ownership is invalid".to_owned());
    }
    let candidate_revision = candidate
        .as_ref()
        .and_then(|candidate| candidate.manifest.base_revision())
        .map(str::to_owned);
    let ledger_revision = store
        .load_worktree_base_revision(workflow_id)
        .map_err(|error| error.to_string())?;
    let base_revision = match (candidate_revision, ledger_revision) {
        (Some(candidate), Some(ledger)) if candidate != ledger => {
            return Err("workflow worktree base revision is inconsistent".to_owned());
        }
        (Some(candidate), _) => Some(candidate),
        (None, ledger) => ledger,
    };
    if base_revision.as_deref().is_some_and(|revision| {
        !matches!(revision.len(), 40 | 64)
            || revision
                .bytes()
                .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    }) {
        return Err("workflow worktree base revision is invalid".to_owned());
    }
    let worktree_path = worktrees
        .join(project_id.to_string())
        .join(workflow_id.to_string());
    let worktree_exists = std::fs::symlink_metadata(&worktree_path)
        .map(|_| true)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("workflow worktree cannot be inspected: {error}"))?;
    if worktree_exists != base_revision.is_some() {
        return Err("workflow worktree recovery state is inconsistent".to_owned());
    }

    let mut result = serde_json::Map::new();
    result.insert("mode".to_owned(), json!(mode));
    result.insert("originalRequest".to_owned(), json!(request.original_text()));
    result.insert("requestDigest".to_owned(), json!(request.digest()));
    result.insert("state".to_owned(), json!(state.state()));
    result.insert("workflowId".to_owned(), json!(workflow_id));
    result.insert("worktreePath".to_owned(), json!(worktree_path));
    if let Some(base_revision) = base_revision {
        result.insert("baseRevision".to_owned(), json!(base_revision));
    }
    if matches!(
        state.state(),
        WorkflowState::Execution | WorkflowState::QuickExecution
    ) && let Some(plan) = store
        .load_architecture(workflow_id)
        .map_err(|error| error.to_string())?
    {
        result.insert("plan".to_owned(), json!(plan));
    }
    if let Some(candidate) = candidate {
        let arbitration = store
            .load_arbitration(candidate.manifest.candidate_id())
            .map_err(|error| error.to_string())?;
        let repair_feedback = if let Some((owner, verdict, _)) = arbitration {
            if owner != workflow_id {
                return Err("workflow arbitration ownership is invalid".to_owned());
            }
            Some(serde_json::to_string(&verdict).map_err(|error| error.to_string())?)
        } else {
            let failed = store
                .load_candidate_evidence(candidate.manifest.candidate_id())
                .map_err(|error| error.to_string())?
                .into_iter()
                .filter(|(record, _, _)| record.status != workflow_core::EvidenceStatus::Passed)
                .map(|(record, output, mandatory)| {
                    json!({ "mandatory": mandatory, "output": output, "record": record })
                })
                .collect::<Vec<_>>();
            (!failed.is_empty())
                .then(|| serde_json::to_string(&failed).map_err(|error| error.to_string()))
                .transpose()?
        };
        if let Some(repair_feedback) = repair_feedback {
            if repair_feedback.len() > 64 * 1024 {
                return Err("workflow repair feedback exceeds the recovery limit".to_owned());
            }
            result.insert("repairFeedback".to_owned(), json!(repair_feedback));
        }
    }
    Ok(Value::Object(result))
}

fn doctor(store: &Store, checkpoint_key: &CheckpointKey) -> Result<Value, String> {
    crate::history::verify_store(store, checkpoint_key).map_err(|error| error.to_string())?;
    let sample = crate::resources::sample(store.path().parent().unwrap_or_else(|| Path::new(".")));
    Ok(json!({
        "ledger": "valid",
        "resources": {
            "availableDiskBytes": sample.available_disk_bytes,
            "availableMemoryBytes": sample.available_memory_bytes,
            "cpuUsagePercent": sample.cpu_usage_percent,
            "ownedProcesses": sample.owned_processes,
        },
        "schemaVersion": workflow_store::CURRENT_SCHEMA_VERSION,
        "status": "PASS",
        "storeMode": format!("{:?}", store.mode()),
    }))
}
