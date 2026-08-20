use std::{collections::BTreeMap, num::NonZeroU8, time::SystemTime};

use serde_json::{Value, json};
use workflow_core::{
    Goal, GoalCommand, GoalId, GoalState, ProjectId, WorkflowState, WorkflowTimestamp,
};
use workflow_ipc::{
    GoalControlAction, GoalOperation,
    audit::{AuditData, AuditObservation},
};
use workflow_ledger::CheckpointKey;
use workflow_store::Store;

pub fn execute(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    project_key: &str,
    operation: GoalOperation,
) -> Result<Value, String> {
    validate_project_key(project_key)?;
    let project_id = ProjectId::from_stable_key(project_key);
    match operation {
        GoalOperation::Create {
            constraints,
            goal_id,
            max_continuations,
            non_goals,
            objective,
            session_id,
            success_criteria,
        } => {
            let maximum = NonZeroU8::new(max_continuations)
                .ok_or_else(|| "goal continuation limit must be greater than zero".to_owned())?;
            let goal = Goal::new(objective, success_criteria, constraints, non_goals, maximum)
                .map_err(|error| error.to_string())?;
            let now = WorkflowTimestamp::now();
            let duplicate = store
                .save_goal_once(goal_id, project_id, &goal, now)
                .map_err(|error| error.to_string())?;
            store
                .focus_goal(project_id, &session_id, goal_id, now)
                .map_err(|error| error.to_string())?;
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                &session_id,
                "goal_created",
                BTreeMap::from([
                    ("duplicate".to_owned(), duplicate.to_string()),
                    (
                        "objective_digest".to_owned(),
                        goal.objective_digest().to_string(),
                    ),
                ]),
            )?;
            snapshot(store, project_id, goal_id)
        }
        GoalOperation::Amend {
            goal_id,
            operation_id,
            text,
        } => {
            require_owner(store, project_id, goal_id)?;
            let goal = store
                .append_goal_amendment(
                    goal_id,
                    &format!("goal:{goal_id}:amend:{operation_id}"),
                    text,
                    WorkflowTimestamp::now(),
                )
                .map_err(|error| error.to_string())?;
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                "system",
                "goal_amended",
                BTreeMap::from([(
                    "request_digest".to_owned(),
                    goal.request_digest().to_string(),
                )]),
            )?;
            snapshot(store, project_id, goal_id)
        }
        GoalOperation::Control {
            action,
            completion_evidence,
            goal_id,
            operation_id,
            reason,
        } => {
            require_owner(store, project_id, goal_id)?;
            validate_control(
                store,
                goal_id,
                action,
                completion_evidence,
                reason.as_deref(),
            )?;
            let result = store
                .apply_goal_command(
                    goal_id,
                    &format!("goal:{goal_id}:control:{operation_id}"),
                    command(action),
                    WorkflowTimestamp::now(),
                )
                .map_err(|error| error.to_string())?;
            let mut metadata = BTreeMap::from([
                ("duplicate".to_owned(), result.duplicate.to_string()),
                ("state".to_owned(), state_name(result.state.state())),
            ]);
            if let Some(reason) = reason {
                metadata.insert("reason".to_owned(), reason);
            }
            if let Some(evidence) = completion_evidence {
                metadata.insert("completion_evidence".to_owned(), evidence.to_string());
            }
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                "system",
                action_name(action),
                metadata,
            )?;
            snapshot(store, project_id, goal_id)
        }
        GoalOperation::Focus {
            goal_id,
            session_id,
        } => {
            require_owner(store, project_id, goal_id)?;
            store
                .focus_goal(project_id, &session_id, goal_id, WorkflowTimestamp::now())
                .map_err(|error| error.to_string())?;
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                &session_id,
                "goal_focused",
                BTreeMap::new(),
            )?;
            snapshot(store, project_id, goal_id)
        }
        GoalOperation::LinkWorkflow {
            goal_id,
            milestone,
            workflow_id,
        } => {
            require_owner(store, project_id, goal_id)?;
            let workflow_owner = store
                .load_request(workflow_id)
                .map_err(|error| error.to_string())?
                .map(|(owner, _)| owner)
                .ok_or_else(|| "workflow request does not exist".to_owned())?;
            if workflow_owner != project_id {
                return Err("workflow belongs to another project".to_owned());
            }
            store
                .link_goal_workflow(goal_id, workflow_id, &milestone, WorkflowTimestamp::now())
                .map_err(|error| error.to_string())?;
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                "system",
                "goal_workflow_linked",
                BTreeMap::from([
                    ("milestone".to_owned(), milestone),
                    ("workflow_id".to_owned(), workflow_id.to_string()),
                ]),
            )?;
            snapshot(store, project_id, goal_id)
        }
        GoalOperation::List {} => {
            let goals = store
                .list_goals(project_id)
                .map_err(|error| error.to_string())?
                .into_iter()
                .map(|(goal_id, goal)| {
                    json!({
                        "continuations": goal.continuations(),
                        "goalId": goal_id,
                        "objective": goal.objective(),
                        "objectiveDigest": goal.objective_digest(),
                        "state": state_name(goal.state()),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "goals": goals }))
        }
        GoalOperation::SavePlan {
            content,
            goal_id,
            source_session_id,
        } => {
            let goal = require_owner(store, project_id, goal_id)?;
            if goal.state() == GoalState::Draft {
                store
                    .apply_goal_command(
                        goal_id,
                        &format!("goal:{goal_id}:start-planning"),
                        GoalCommand::StartPlanning,
                        WorkflowTimestamp::now(),
                    )
                    .map_err(|error| error.to_string())?;
            } else if goal.state() != GoalState::Planning {
                return Err("goal plans can only be saved while planning".to_owned());
            }
            let revision = store
                .save_goal_plan(
                    goal_id,
                    &source_session_id,
                    &content,
                    WorkflowTimestamp::now(),
                )
                .map_err(|error| error.to_string())?;
            record(
                store,
                checkpoint_key,
                project_key,
                goal_id,
                &source_session_id,
                "goal_plan_saved",
                BTreeMap::from([
                    (
                        "plan_digest".to_owned(),
                        workflow_core::ContentDigest::of(content.as_bytes()).to_string(),
                    ),
                    ("revision".to_owned(), revision.to_string()),
                ]),
            )?;
            Ok(json!({ "goalId": goal_id, "revision": revision }))
        }
        GoalOperation::Status {
            goal_id,
            session_id,
        } => {
            let goal_id = match goal_id {
                Some(goal_id) => goal_id,
                None => store
                    .focused_goal(project_id, &session_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "session has no focused goal".to_owned())?,
            };
            require_owner(store, project_id, goal_id)?;
            snapshot(store, project_id, goal_id)
        }
    }
}

fn validate_control(
    store: &Store,
    goal_id: GoalId,
    action: GoalControlAction,
    completion_evidence: Option<workflow_core::ContentDigest>,
    reason: Option<&str>,
) -> Result<(), String> {
    if completion_evidence.is_some() && action != GoalControlAction::ApproveCompletion {
        return Err("completion evidence is accepted only for completion approval".to_owned());
    }
    if matches!(
        action,
        GoalControlAction::Abort | GoalControlAction::Block | GoalControlAction::RejectCompletion
    ) && reason.is_none_or(|value| value.trim().is_empty() || value.len() > 4_096)
    {
        return Err("this goal transition requires a bounded reason".to_owned());
    }
    if action == GoalControlAction::MarkReady
        && store
            .load_latest_goal_plan(goal_id)
            .map_err(|error| error.to_string())?
            .is_none()
    {
        return Err("goal cannot become ready without a versioned architecture plan".to_owned());
    }
    if matches!(
        action,
        GoalControlAction::RequestCompletion | GoalControlAction::ApproveCompletion
    ) {
        let links = store
            .goal_workflows(goal_id)
            .map_err(|error| error.to_string())?;
        if links.is_empty() {
            return Err("goal completion requires at least one linked workflow".to_owned());
        }
        let mut milestones = BTreeMap::new();
        for (workflow_id, milestone) in links {
            let state = store
                .load_workflow(workflow_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "linked workflow state does not exist".to_owned())?;
            match state.state() {
                WorkflowState::Completed => {
                    milestones.insert(milestone, true);
                }
                WorkflowState::Cancelled => {
                    milestones.entry(milestone).or_insert(false);
                }
                _ => {
                    return Err(
                        "linked workflows must be completed or cancelled before goal completion"
                            .to_owned(),
                    );
                }
            }
        }
        if milestones.values().any(|completed| !completed) {
            return Err(
                "each linked milestone requires at least one completed workflow".to_owned(),
            );
        }
    }
    if action == GoalControlAction::ApproveCompletion && completion_evidence.is_none() {
        return Err("goal completion requires independent arbiter evidence".to_owned());
    }
    Ok(())
}

fn command(action: GoalControlAction) -> GoalCommand {
    match action {
        GoalControlAction::StartPlanning => GoalCommand::StartPlanning,
        GoalControlAction::MarkReady => GoalCommand::MarkReady,
        GoalControlAction::Activate => GoalCommand::Activate,
        GoalControlAction::Pause => GoalCommand::Pause,
        GoalControlAction::Resume => GoalCommand::Resume,
        GoalControlAction::Block => GoalCommand::Block,
        GoalControlAction::ResumeBlocked => GoalCommand::ResumeBlocked,
        GoalControlAction::Continue => GoalCommand::Continue,
        GoalControlAction::RequestCompletion => GoalCommand::RequestCompletion,
        GoalControlAction::ApproveCompletion => GoalCommand::ApproveCompletion,
        GoalControlAction::RejectCompletion => GoalCommand::RejectCompletion,
        GoalControlAction::Abort => GoalCommand::Abort,
    }
}

fn require_owner(store: &Store, project_id: ProjectId, goal_id: GoalId) -> Result<Goal, String> {
    let (owner, goal) = store
        .load_goal(goal_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "goal does not exist".to_owned())?;
    if owner != project_id {
        return Err("goal belongs to another project".to_owned());
    }
    Ok(goal)
}

fn snapshot(store: &Store, project_id: ProjectId, goal_id: GoalId) -> Result<Value, String> {
    let goal = require_owner(store, project_id, goal_id)?;
    let plan = store
        .load_latest_goal_plan(goal_id)
        .map_err(|error| error.to_string())?
        .map(|plan| {
            json!({
                "content": plan.content,
                "contentDigest": plan.content_digest,
                "createdAt": plan.created_at,
                "revision": plan.revision,
                "sourceSessionId": plan.source_session_id,
            })
        });
    let workflows = store
        .goal_workflows(goal_id)
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|(workflow_id, milestone)| {
            let state = store
                .load_workflow(workflow_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "linked workflow state does not exist".to_owned())?;
            Ok(json!({
                "milestone": milestone,
                "state": format!("{:?}", state.state()).to_ascii_lowercase(),
                "workflowId": workflow_id,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "amendments": goal.amendments(),
        "constraints": goal.constraints(),
        "continuations": goal.continuations(),
        "goalId": goal_id,
        "maximumContinuations": goal.max_continuations(),
        "nonGoals": goal.non_goals(),
        "objective": goal.objective(),
        "objectiveDigest": goal.objective_digest(),
        "plan": plan,
        "requestDigest": goal.request_digest(),
        "state": state_name(goal.state()),
        "successCriteria": goal.success_criteria(),
        "workflows": workflows,
    }))
}

fn record(
    store: &mut Store,
    checkpoint_key: &CheckpointKey,
    project_key: &str,
    goal_id: GoalId,
    session_id: &str,
    action: &str,
    mut metadata: BTreeMap<String, String>,
) -> Result<(), String> {
    metadata.insert("goal_id".to_owned(), goal_id.to_string());
    crate::audit::record(
        store,
        checkpoint_key,
        AuditObservation {
            actor_id: "workflowd".to_owned(),
            candidate_id: None,
            data: AuditData::Workflow {
                action: action.to_owned(),
            },
            evidence_ids: Default::default(),
            files: Default::default(),
            metadata,
            model: None,
            project_key: project_key.to_owned(),
            role: None,
            session_id: Some(session_id.to_owned()),
            task_id: None,
            timestamp_unix_millis: now_unix_millis()?,
            workflow_id: None,
        },
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn validate_project_key(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 1_024 || value.contains('\0') {
        Err("project key is invalid".to_owned())
    } else {
        Ok(())
    }
}

fn state_name(state: GoalState) -> String {
    serde_json::to_value(state)
        .expect("goal state serializes")
        .as_str()
        .expect("goal state serializes as text")
        .to_owned()
}

const fn action_name(action: GoalControlAction) -> &'static str {
    match action {
        GoalControlAction::StartPlanning => "goal_planning_started",
        GoalControlAction::MarkReady => "goal_marked_ready",
        GoalControlAction::Activate => "goal_activated",
        GoalControlAction::Pause => "goal_paused",
        GoalControlAction::Resume => "goal_resumed",
        GoalControlAction::Block => "goal_blocked",
        GoalControlAction::ResumeBlocked => "goal_block_resolved",
        GoalControlAction::Continue => "goal_continued",
        GoalControlAction::RequestCompletion => "goal_completion_requested",
        GoalControlAction::ApproveCompletion => "goal_completion_approved",
        GoalControlAction::RejectCompletion => "goal_completion_rejected",
        GoalControlAction::Abort => "goal_aborted",
    }
}

fn now_unix_millis() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    i64::try_from(duration.as_millis()).map_err(|_| "system time is out of range".to_owned())
}
