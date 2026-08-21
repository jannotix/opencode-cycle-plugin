use workflow_ledger::{
    ChainVerification, Checkpoint, CheckpointVerification, LedgerChain, LedgerEntry,
};

const LEGACY_HISTORY: &str = r#"[{"event":{"actor":{"id":"arbiter","model":null,"role":null,"session_id":null},"candidate_id":null,"data":{"type":"workflow","action":"approved"},"event_id":"0190f0a0-0000-7000-8000-000000000001","evidence_ids":[],"files":[],"metadata":{},"project_id":"0190f0a0-0000-7000-8000-000000000002","task_id":null,"timestamp":"2026-08-15T12:00:00Z","workflow_id":null},"hash":"81eaa01dbbe74855eac10b6b81de3d9d10fffb531dcd2ae57b4b0aea8ab5e96d","previous_hash":null,"sequence":0}]"#;

const LEGACY_CHECKPOINT: &str = r#"{"head":"81eaa01dbbe74855eac10b6b81de3d9d10fffb531dcd2ae57b4b0aea8ab5e96d","public_key":[234,74,108,99,226,156,82,10,190,245,80,123,19,46,197,249,149,71,118,174,190,190,123,146,66,30,234,105,20,70,210,44],"sequence":0,"signature":[73,192,26,113,48,35,48,7,146,176,60,15,228,116,74,19,202,181,208,243,138,60,77,23,204,46,185,114,120,72,31,153,119,165,15,146,108,28,244,128,34,160,18,254,133,84,80,192,17,42,224,184,128,68,87,192,16,62,169,121,30,230,108,9],"signed_at":"2026-08-15T12:00:00Z"}"#;

#[test]
fn protocol_v1_history_and_checkpoint_remain_verifiable() {
    let entries: Vec<LedgerEntry> = serde_json::from_str(LEGACY_HISTORY).unwrap();
    let chain = LedgerChain::from_entries(entries);
    let checkpoint: Checkpoint = serde_json::from_str(LEGACY_CHECKPOINT).unwrap();
    let head = chain.head().unwrap();
    assert!(matches!(
        chain.verify(Some(head)),
        ChainVerification::Valid { entries: 1, .. }
    ));
    assert_eq!(
        checkpoint.verify_embedded(Some((checkpoint.sequence, head))),
        CheckpointVerification::Valid
    );
}
