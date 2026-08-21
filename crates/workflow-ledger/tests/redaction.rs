mod common;

use std::collections::BTreeMap;

use workflow_ledger::{Actor, EventData, LedgerEvent, ModelIdentity, Redactor};

#[test]
fn secrets_are_redacted_at_the_write_boundary() {
    let base = common::event("started");
    let event = LedgerEvent::new(
        Actor {
            id: "operator".to_owned(),
            model: Some(ModelIdentity {
                model: "stable-model".to_owned(),
                provider: "https://user:password@example.com".to_owned(),
            }),
            role: None,
            session_id: None,
        },
        None,
        EventData::Tool {
            invocation_digest: "aabb".to_owned(),
            tool: "shell Bearer secret-value".to_owned(),
        },
        [],
        ["sk-12345678901234567890".to_owned()],
        BTreeMap::from([
            ("authorization".to_owned(), "plain".to_owned()),
            ("safe".to_owned(), "ghp_12345678901234567890".to_owned()),
        ]),
        base.project_id,
        None,
        base.timestamp,
        base.workflow_id,
        &Redactor::default(),
    )
    .unwrap();

    let encoded = String::from_utf8(event.canonical_bytes().unwrap()).unwrap();
    assert!(!encoded.contains("password"));
    assert!(!encoded.contains("secret-value"));
    assert!(!encoded.contains("ghp_"));
    assert!(!encoded.contains("sk-"));
    assert!(encoded.matches("[REDACTED]").count() >= 4);
}

#[test]
fn custom_sensitive_keys_are_case_insensitive() {
    let redactor = Redactor::new(["tenantCredential".to_owned()]);
    let base = common::event("started");
    let event = LedgerEvent::new(
        base.actor,
        None,
        EventData::Workflow {
            action: "started".to_owned(),
        },
        [],
        [],
        BTreeMap::from([("TenantCredentialId".to_owned(), "value".to_owned())]),
        base.project_id,
        None,
        base.timestamp,
        base.workflow_id,
        &redactor,
    )
    .unwrap();
    assert_eq!(event.metadata["TenantCredentialId"], "[REDACTED]");
}
