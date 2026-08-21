use workflow_core::{GoalId, ReceiptId};
use workflow_ipc::{ClientMessage, GoalControlAction, GoalOperation};

#[test]
fn goal_operations_round_trip_without_unknown_fields() {
    let message = ClientMessage::Goal {
        operation: GoalOperation::Control {
            action: GoalControlAction::RequestCompletion,
            completion_evidence: None,
            goal_id: GoalId::new(),
            operation_id: ReceiptId::new(),
            reason: None,
        },
        project_key: "project".to_owned(),
        request_id: 21,
    };
    let json = serde_json::to_string(&message).unwrap();
    assert_eq!(
        serde_json::from_str::<ClientMessage>(&json).unwrap(),
        message
    );
}

#[test]
fn goal_protocol_rejects_unknown_fields() {
    let malformed = r#"{"type":"goal","data":{"operation":{"type":"list","extra":true},"project_key":"project","request_id":21}}"#;
    assert!(serde_json::from_str::<ClientMessage>(malformed).is_err());
}
