use std::num::NonZeroUsize;

use workflow_core::{
    ArchitecturePlan, CandidateId, PlannedTask, ProjectId, RepairTarget, RequestRecord,
    Requirement, TaskId, WorkflowCommand, WorkflowId, WorkflowMode, WorkflowTimestamp,
};
use workflow_store::{Store, StoreError};

fn plan(request: &RequestRecord) -> ArchitecturePlan {
    ArchitecturePlan::validate(
        request.digest(),
        vec![Requirement {
            acceptance_criteria: vec!["The result works end to end.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Implement the requested result.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["The implementation passes its tests.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Implement the bounded production change.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Implementation".to_owned(),
            verification_commands: vec!["project-test".to_owned()],
            write_scopes: vec!["src".to_owned()],
        }],
        vec![],
        vec![],
        vec!["Run the end-to-end test.".to_owned()],
    )
    .unwrap()
}

#[test]
fn plan_is_bound_to_the_persisted_request_and_is_write_once() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let request = RequestRecord::new("Original request".to_owned(), vec![]);
    store
        .save_request_once(
            workflow_id,
            ProjectId::from_stable_key("project"),
            &request,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let saved_plan = plan(&request);
    assert!(
        !store
            .save_architecture_once(workflow_id, &saved_plan, WorkflowTimestamp::now())
            .unwrap()
    );
    assert!(
        store
            .save_architecture_once(workflow_id, &saved_plan, WorkflowTimestamp::now())
            .unwrap()
    );
    assert_eq!(
        store.load_architecture(workflow_id).unwrap(),
        Some(saved_plan)
    );

    let other_request = RequestRecord::new("Different request".to_owned(), vec![]);
    assert!(matches!(
        store.save_architecture_once(workflow_id, &plan(&other_request), WorkflowTimestamp::now()),
        Err(StoreError::RequestDigestMismatch)
    ));
}

#[test]
fn rejected_architecture_is_replanned_as_an_append_only_version() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = Store::open(
        directory.path().join("workflow.db"),
        NonZeroUsize::new(1).unwrap(),
    )
    .unwrap();
    let workflow_id = WorkflowId::new();
    let request = RequestRecord::new("Original request".to_owned(), vec![]);
    store
        .save_request_once(
            workflow_id,
            ProjectId::from_stable_key("project"),
            &request,
            WorkflowTimestamp::now(),
        )
        .unwrap();
    let original = plan(&request);
    store
        .save_architecture_once(workflow_id, &original, WorkflowTimestamp::now())
        .unwrap();
    let candidate_id = CandidateId::new();
    for (key, command) in [
        ("intake", WorkflowCommand::CompleteIntake),
        ("route", WorkflowCommand::Route(WorkflowMode::Full)),
        ("architecture", WorkflowCommand::ArchitectureAccepted),
        ("candidate", WorkflowCommand::CandidateReady(candidate_id)),
        ("verification", WorkflowCommand::VerificationPassed),
        ("reviews", WorkflowCommand::ReviewsReady),
        (
            "reject",
            WorkflowCommand::Reject(RepairTarget::Architecture),
        ),
        ("repair", WorkflowCommand::BeginRepair),
    ] {
        store
            .apply_workflow_command(workflow_id, key, command, WorkflowTimestamp::now())
            .unwrap();
    }
    let mut replacement = plan(&request);
    replacement.tasks[0].title = "Replanned implementation".to_owned();
    assert!(
        !store
            .save_architecture_once(workflow_id, &replacement, WorkflowTimestamp::now())
            .unwrap()
    );
    assert_eq!(
        store.load_architecture_versions(workflow_id).unwrap(),
        vec![original, replacement.clone()]
    );
    assert_eq!(
        store.load_architecture(workflow_id).unwrap(),
        Some(replacement)
    );
}
