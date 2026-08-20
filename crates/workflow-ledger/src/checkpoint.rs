use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use workflow_core::{ContentDigest, WorkflowTimestamp};

use crate::CheckpointKey;

// Immutable protocol-v1 compatibility identifier for persisted checkpoint signatures.
const LEGACY_PROTOCOL_V1_CHECKPOINT_SIGNATURE_DOMAIN: &[u8] =
    b"opencode-workflow-ledger-checkpoint-v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub head: ContentDigest,
    pub public_key: [u8; 32],
    pub sequence: u64,
    pub signature: Vec<u8>,
    pub signed_at: WorkflowTimestamp,
}

impl Checkpoint {
    #[must_use]
    pub fn sign(
        sequence: u64,
        head: ContentDigest,
        signed_at: WorkflowTimestamp,
        key: &CheckpointKey,
    ) -> Self {
        let public_key = key.verifying_key().to_bytes();
        let message = signature_message(sequence, head, signed_at, &public_key);
        Self {
            head,
            public_key,
            sequence,
            signature: key.sign(&message).to_vec(),
            signed_at,
        }
    }

    #[must_use]
    pub fn verify(
        &self,
        key: Option<&VerifyingKey>,
        chain_head: Option<(u64, ContentDigest)>,
    ) -> CheckpointVerification {
        if chain_head != Some((self.sequence, self.head)) {
            return CheckpointVerification::HeadMismatch;
        }
        let Some(key) = key else {
            return CheckpointVerification::MissingKey;
        };
        if key.to_bytes() != self.public_key {
            return CheckpointVerification::WrongKey;
        }
        let Ok(signature) = Signature::try_from(self.signature.as_slice()) else {
            return CheckpointVerification::InvalidSignature;
        };
        let message = signature_message(self.sequence, self.head, self.signed_at, &self.public_key);
        if key.verify_strict(&message, &signature).is_ok() {
            CheckpointVerification::Valid
        } else {
            CheckpointVerification::InvalidSignature
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckpointVerification {
    HeadMismatch,
    InvalidPublicKey,
    InvalidSignature,
    MissingKey,
    Valid,
    WrongKey,
}

impl Checkpoint {
    #[must_use]
    pub fn verify_embedded(
        &self,
        chain_head: Option<(u64, ContentDigest)>,
    ) -> CheckpointVerification {
        match VerifyingKey::from_bytes(&self.public_key) {
            Ok(key) => self.verify(Some(&key), chain_head),
            Err(_) => CheckpointVerification::InvalidPublicKey,
        }
    }
}

fn signature_message(
    sequence: u64,
    head: ContentDigest,
    signed_at: WorkflowTimestamp,
    public_key: &[u8; 32],
) -> Vec<u8> {
    let timestamp = signed_at.to_string();
    let mut message = Vec::with_capacity(
        LEGACY_PROTOCOL_V1_CHECKPOINT_SIGNATURE_DOMAIN.len()
            + 8
            + head.as_bytes().len()
            + timestamp.len()
            + public_key.len(),
    );
    message.extend_from_slice(LEGACY_PROTOCOL_V1_CHECKPOINT_SIGNATURE_DOMAIN);
    message.extend_from_slice(&sequence.to_be_bytes());
    message.extend_from_slice(head.as_bytes());
    message.extend_from_slice(public_key);
    message.extend_from_slice(timestamp.as_bytes());
    message
}
