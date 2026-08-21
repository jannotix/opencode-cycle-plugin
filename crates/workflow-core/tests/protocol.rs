use workflow_core::{PROTOCOL_VERSION, ProtocolEnvelope, ProtocolPayload};

#[test]
fn rust_deserializes_both_contract_fixtures() {
    for fixture in [
        include_str!("../../../tests/contract/protocol/rust-request-v1.json"),
        include_str!("../../../tests/contract/protocol/typescript-request-v1.json"),
    ] {
        let envelope: ProtocolEnvelope = serde_json::from_str(fixture).unwrap();
        assert_eq!(envelope.version, PROTOCOL_VERSION);
        assert!(matches!(envelope.payload, ProtocolPayload::Request(_)));
    }
}

#[test]
fn rust_rejects_unknown_protocol_versions() {
    let fixture = include_str!("../../../tests/contract/protocol/rust-request-v1.json");
    let value = fixture.replace("\"version\": 1", "\"version\": 2");
    assert!(serde_json::from_str::<ProtocolEnvelope>(&value).is_err());
}

#[test]
fn rust_rejects_unknown_fields() {
    let fixture = include_str!("../../../tests/contract/protocol/rust-request-v1.json");
    let value = fixture.replacen('{', "{\"unexpected\":true,", 1);
    assert!(serde_json::from_str::<ProtocolEnvelope>(&value).is_err());
}
