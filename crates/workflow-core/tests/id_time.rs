use std::collections::HashSet;

use workflow_core::{
    CandidateId, EventId, EvidenceId, MemoryId, ProjectId, ReceiptId, SessionId, TaskId,
    WorkflowId, WorkflowTimestamp,
};

#[test]
fn identifiers_are_typed_unique_and_canonical() {
    let ids = (0..1_024)
        .map(|_| WorkflowId::new())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 1_024);

    let id = WorkflowId::new();
    let text = id.to_string();
    assert_eq!(text.parse::<WorkflowId>().unwrap(), id);
    assert_eq!(serde_json::to_string(&id).unwrap(), format!("\"{text}\""));
}

#[test]
fn identifier_types_cannot_share_constructors_accidentally() {
    let values = [
        ProjectId::new().to_string(),
        WorkflowId::new().to_string(),
        TaskId::new().to_string(),
        SessionId::new().to_string(),
        CandidateId::new().to_string(),
        EventId::new().to_string(),
        EvidenceId::new().to_string(),
        ReceiptId::new().to_string(),
        MemoryId::new().to_string(),
    ];

    assert_eq!(values.iter().collect::<HashSet<_>>().len(), values.len());
}

#[test]
fn project_identifier_is_stable_for_a_host_project_key() {
    let first = ProjectId::from_stable_key("project-key");
    assert_eq!(first, ProjectId::from_stable_key("project-key"));
    assert_ne!(first, ProjectId::from_stable_key("another-project"));
    assert_eq!(first.as_uuid().get_version_num(), 8);
}

#[test]
fn timestamps_normalize_to_utc_and_round_trip() {
    let timestamp = WorkflowTimestamp::parse("2026-08-12T10:15:30.123456789+02:00").unwrap();
    assert_eq!(timestamp.to_string(), "2026-08-12T08:15:30.123456789Z");

    let json = serde_json::to_string(&timestamp).unwrap();
    assert_eq!(json, "\"2026-08-12T08:15:30.123456789Z\"");
    assert_eq!(
        serde_json::from_str::<WorkflowTimestamp>(&json).unwrap(),
        timestamp
    );
}

#[test]
fn timestamps_preserve_nanosecond_epoch_values() {
    let timestamp =
        WorkflowTimestamp::from_unix_timestamp_nanos(1_786_519_330_123_456_789).unwrap();
    assert_eq!(timestamp.unix_timestamp_nanos(), 1_786_519_330_123_456_789);
}
