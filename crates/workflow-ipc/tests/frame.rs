use workflow_core::{
    ArchitecturePlan, ContentDigest, EvidenceId, ProtocolEnvelope, ProtocolPayload, ReceiptId,
    RequestRecord, TaskId, UserRoutingPreference, WorkflowId,
};
use workflow_ipc::{
    ClientMessage, FrameDecoder, FrameError, IpcRequest, MAX_FRAME_BYTES, ServerMessage,
    encode_frame,
    protocol::{
        TaskClosureCommandReceipt, TaskClosureCommandStatus, TaskClosureCoverageStatus,
        TaskClosureCriterionDecision, TaskClosureReport, TaskClosureRequirementDecision,
        TaskClosureReviewDecision, TaskClosureReviewerReceipt, TaskClosureReviewerVerdict,
    },
};

fn request(id: u64) -> IpcRequest {
    IpcRequest {
        affected_paths: Vec::new(),
        critical_downgrade_approval: None,
        project_key: "project".to_owned(),
        request_id: id,
        routing_preference: UserRoutingPreference::Auto,
        workflow_id: None,
        envelope: ProtocolEnvelope::new(ProtocolPayload::Request(RequestRecord::new(
            format!("request {id}"),
            Vec::new(),
        ))),
    }
}

#[test]
fn parses_fragmented_frames() {
    let expected = request(7);
    let frame = encode_frame(&expected).unwrap();
    let mut decoder = FrameDecoder::new();
    let mut decoded = Vec::new();
    for byte in frame {
        decoded.extend(decoder.feed_json::<IpcRequest>(&[byte]).unwrap());
    }
    assert_eq!(decoded, [expected]);
}

#[test]
fn parses_concatenated_frames_without_cross_delivery() {
    let first = request(1);
    let second = request(2);
    let bytes = [
        encode_frame(&first).unwrap(),
        encode_frame(&second).unwrap(),
    ]
    .concat();
    let decoded = FrameDecoder::new().feed_json::<IpcRequest>(&bytes).unwrap();
    assert_eq!(decoded, [first, second]);
}

#[test]
fn oversized_header_fails_before_payload_allocation_and_poisoned_decoder_stays_closed() {
    let announced = u32::try_from(MAX_FRAME_BYTES + 1).unwrap();
    let mut decoder = FrameDecoder::new();
    assert!(matches!(
        decoder.feed(&announced.to_be_bytes()),
        Err(FrameError::Oversized { .. })
    ));
    assert_eq!(decoder.buffered_bytes(), 0);
    assert!(matches!(
        decoder.feed(b"ignored"),
        Err(FrameError::Poisoned)
    ));
}

#[test]
fn malformed_json_and_unknown_protocol_versions_fail_closed() {
    let malformed = [3_u32.to_be_bytes().as_slice(), b"bad"].concat();
    let mut decoder = FrameDecoder::new();
    assert!(matches!(
        decoder.feed_json::<IpcRequest>(&malformed),
        Err(FrameError::Json(_))
    ));
    assert!(matches!(
        decoder.feed(b"ignored"),
        Err(FrameError::Poisoned)
    ));

    let mut value = serde_json::to_value(request(1)).unwrap();
    value["envelope"]["version"] = serde_json::json!(2);
    let frame = encode_frame(&value).unwrap();
    assert!(matches!(
        FrameDecoder::new().feed_json::<IpcRequest>(&frame),
        Err(FrameError::Json(_))
    ));
}

#[test]
fn arbitrary_input_never_buffers_more_than_the_declared_limit() {
    let mut seed = 0x9e37_79b9_u32;
    for _ in 0..10_000 {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let bytes = seed.to_be_bytes();
        let mut decoder = FrameDecoder::new();
        let _ = decoder.feed(&bytes);
        assert!(decoder.buffered_bytes() <= MAX_FRAME_BYTES);
    }
}

#[test]
fn authentication_acknowledgement_round_trips_with_the_protocol_version() {
    let expected = ServerMessage::Authenticated {
        protocol_version: workflow_core::PROTOCOL_VERSION,
    };
    let frame = encode_frame(&expected).unwrap();
    let decoded = FrameDecoder::new()
        .feed_json::<ServerMessage>(&frame)
        .unwrap();
    assert_eq!(decoded, [expected]);
}

#[test]
fn task_closure_report_round_trips_without_a_caller_authored_completion_flag() {
    let task_id = TaskId::new();
    let revision = "a".repeat(40);
    let report = TaskClosureReport {
        architecture_digest: ContentDigest::of(b"architecture"),
        base_revision: "b".repeat(40),
        changed_paths: vec!["src/feature.rs".to_owned()],
        commands: vec![TaskClosureCommandReceipt {
            evidence_id: EvidenceId::new(),
            exit_code: 0,
            invocation: "cargo test -p feature".to_owned(),
            output_digest: ContentDigest::of(b"passed"),
            status: TaskClosureCommandStatus::Passed,
        }],
        project_key: "project".to_owned(),
        receipt_id: ReceiptId::new(),
        request_digest: ContentDigest::of(b"request"),
        reviewer: TaskClosureReviewerReceipt {
            verdict: TaskClosureReviewerVerdict {
                criteria: vec![TaskClosureCriterionDecision {
                    criterion_id: format!("task:{task_id}:acceptance:1"),
                    evidence_ids: Vec::new(),
                    status: TaskClosureCoverageStatus::Satisfied,
                }],
                decision: TaskClosureReviewDecision::Approved,
                findings: Vec::new(),
                repair_target: None,
                requirements: vec![TaskClosureRequirementDecision {
                    evidence_ids: Vec::new(),
                    requirement_id: "REQ-1".to_owned(),
                    status: TaskClosureCoverageStatus::Satisfied,
                }],
                revision: revision.clone(),
                task_id,
            },
            verdict_digest: ContentDigest::of(b"verdict"),
        },
        submitted_revision: revision,
        task_id,
        workflow_id: WorkflowId::new(),
    };
    let message = ClientMessage::ReportTaskClosure {
        report: Box::new(report.clone()),
        request_id: 17,
    };
    let frame = encode_frame(&message).unwrap();
    assert_eq!(
        FrameDecoder::new()
            .feed_json::<ClientMessage>(&frame)
            .unwrap(),
        [message]
    );
    let serialized = serde_json::to_value(report).unwrap();
    assert!(serialized.get("completed").is_none());
}

#[test]
fn task_closure_report_rejects_unknown_fields() {
    let task_id = TaskId::new();
    let mut value = serde_json::json!({
        "type": "report_task_closure",
        "data": {
            "request_id": 17,
            "report": {
                "architecture_digest": ContentDigest::of(b"architecture"),
                "base_revision": "b".repeat(40),
                "changed_paths": ["src/feature.rs"],
                "commands": [{
                    "evidence_id": EvidenceId::new(),
                    "exit_code": 0,
                    "invocation": "cargo test -p feature",
                    "output_digest": ContentDigest::of(b"passed"),
                    "status": "passed"
                }],
                "project_key": "project",
                "receipt_id": ReceiptId::new(),
                "request_digest": ContentDigest::of(b"request"),
                "reviewer": {
                    "verdict": {
                        "criteria": [{
                            "criterion_id": format!("task:{task_id}:acceptance:1"),
                            "evidence_ids": [],
                            "status": "satisfied"
                        }],
                        "decision": "approved",
                        "findings": [],
                        "repair_target": null,
                        "requirements": [{
                            "evidence_ids": [],
                            "requirement_id": "REQ-1",
                            "status": "satisfied"
                        }],
                        "revision": "a".repeat(40),
                        "task_id": task_id
                    },
                    "verdict_digest": ContentDigest::of(b"verdict")
                },
                "submitted_revision": "a".repeat(40),
                "task_id": task_id,
                "workflow_id": WorkflowId::new()
            }
        }
    });
    value["data"]["report"]["completed"] = serde_json::json!(true);
    let frame = encode_frame(&value).unwrap();
    assert!(matches!(
        FrameDecoder::new().feed_json::<ClientMessage>(&frame),
        Err(FrameError::Json(_))
    ));
}

#[test]
fn task_closure_plan_and_verdict_digests_match_the_typescript_canonical_vectors() {
    let task_id = "018f0000-0000-7000-8000-000000000001";
    let evidence_id = "018f0000-0000-7000-8000-000000000002";
    let plan: ArchitecturePlan = serde_json::from_value(serde_json::json!({
        "assumptions": [],
        "integration_checks": ["Run tests."],
        "request_digest": "11".repeat(32),
        "requirements": [{
            "acceptance_criteria": ["It works."],
            "id": "REQ-1",
            "statement": "Build it."
        }],
        "risks": [],
        "tasks": [{
            "acceptance_criteria": ["Task works."],
            "dependencies": [],
            "id": task_id,
            "objective": "Build the task.",
            "requirement_ids": ["REQ-1"],
            "title": "Build",
            "verification_commands": ["rustc --version"],
            "write_scopes": ["src"]
        }]
    }))
    .unwrap();
    assert_eq!(
        plan.digest().to_string(),
        "d60825d62e94c853f04f6ee0a4e7504e620f727c7ab9bb92073459dd7311c6a1"
    );

    let verdict: TaskClosureReviewerVerdict = serde_json::from_value(serde_json::json!({
        "criteria": [
            {
                "criterion_id": format!("task:{task_id}:acceptance:1"),
                "evidence_ids": [evidence_id],
                "status": "satisfied"
            },
            {
                "criterion_id": "requirement:REQ-1:acceptance:1",
                "evidence_ids": [evidence_id],
                "status": "satisfied"
            }
        ],
        "decision": "approved",
        "findings": [],
        "repair_target": null,
        "requirements": [{
            "evidence_ids": [evidence_id],
            "requirement_id": "REQ-1",
            "status": "satisfied"
        }],
        "revision": "aa".repeat(20),
        "task_id": task_id
    }))
    .unwrap();
    assert_eq!(
        ContentDigest::of(&serde_json::to_vec(&verdict).unwrap()).to_string(),
        "cd8b4ce8399b464d14f65b816a4b35001e24252758c022c172791f3def3a5b09"
    );
}
