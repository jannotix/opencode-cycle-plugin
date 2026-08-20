use std::collections::{BTreeMap, BTreeSet};

use crate::{Actor, EventData, ModelIdentity};

#[derive(Clone, Debug)]
pub struct Redactor {
    sensitive_keys: BTreeSet<String>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new([])
    }
}

impl Redactor {
    #[must_use]
    pub fn new(keys: impl IntoIterator<Item = String>) -> Self {
        let mut sensitive_keys = BTreeSet::from([
            "api_key".to_owned(),
            "authorization".to_owned(),
            "cookie".to_owned(),
            "password".to_owned(),
            "secret".to_owned(),
            "token".to_owned(),
        ]);
        sensitive_keys.extend(keys.into_iter().map(|key| key.to_ascii_lowercase()));
        Self { sensitive_keys }
    }

    pub(crate) fn metadata(&self, metadata: BTreeMap<String, String>) -> BTreeMap<String, String> {
        metadata
            .into_iter()
            .map(|(key, value)| {
                let redacted = self.is_sensitive_key(&key) || sensitive_value(&value);
                (
                    key,
                    if redacted {
                        "[REDACTED]".to_owned()
                    } else {
                        value
                    },
                )
            })
            .collect()
    }

    pub(crate) fn actor(&self, mut actor: Actor) -> Actor {
        actor.id = self.value(actor.id);
        actor.model = actor.model.map(|mut model: ModelIdentity| {
            model.model = self.value(model.model);
            model.provider = self.value(model.provider);
            model
        });
        actor
    }

    pub(crate) fn data(&self, data: EventData) -> EventData {
        match data {
            EventData::Workflow { action } => EventData::Workflow {
                action: self.value(action),
            },
            EventData::Tool {
                invocation_digest,
                tool,
            } => EventData::Tool {
                invocation_digest,
                tool: self.value(tool),
            },
            EventData::Permission {
                decision,
                permission,
            } => EventData::Permission {
                decision: self.value(decision),
                permission: self.value(permission),
            },
            EventData::Git {
                externally_attributed,
                revision,
            } => EventData::Git {
                externally_attributed,
                revision: self.value(revision),
            },
            EventData::Verification { gate, status } => EventData::Verification {
                gate: self.value(gate),
                status: self.value(status),
            },
        }
    }

    #[must_use]
    pub fn value(&self, value: String) -> String {
        if sensitive_value(&value) {
            "[REDACTED]".to_owned()
        } else {
            value
        }
    }

    #[must_use]
    pub fn contains_sensitive(&self, value: &str) -> bool {
        sensitive_value(value)
    }

    fn is_sensitive_key(&self, key: &str) -> bool {
        let normalized = key.to_ascii_lowercase();
        self.sensitive_keys
            .iter()
            .any(|sensitive| normalized.contains(sensitive))
    }
}

fn sensitive_value(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.contains("-----begin private key-----")
        || lower.contains("-----begin rsa private key-----")
        || contains_token_prefix(trimmed, "sk-", 12)
        || contains_token_prefix(trimmed, "ghp_", 12)
        || contains_token_prefix(trimmed, "github_pat_", 12)
        || contains_token_prefix(trimmed, "akia", 16)
        || has_url_credentials(trimmed)
}

fn contains_token_prefix(value: &str, prefix: &str, minimum_length: usize) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.match_indices(prefix).any(|(index, _)| {
        lower[index..]
            .split(|character: char| {
                character.is_whitespace() || matches!(character, '\'' | '"' | ',' | ';')
            })
            .next()
            .is_some_and(|candidate| candidate.len() >= minimum_length)
    })
}

fn has_url_credentials(value: &str) -> bool {
    value.find("://").is_some_and(|scheme_end| {
        let authority = &value[scheme_end + 3..];
        authority
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains(':') && authority.contains('@'))
    })
}
