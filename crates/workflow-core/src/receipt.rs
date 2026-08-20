use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    CandidateId, ContentDigest, EvidenceId, ReceiptId, WorkflowId, WorkflowTimestamp,
    digest::CanonicalHasher,
};

// Immutable protocol-v1 compatibility identifier for persisted arbitration receipts.
const LEGACY_PROTOCOL_V1_ARBITRATION_RECEIPT_DOMAIN: &str =
    "opencode-workflow/arbitration-receipt/v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ArbitrationReceipt {
    pub arbiter_verdict_digest: ContentDigest,
    pub candidate_digest: ContentDigest,
    pub candidate_id: CandidateId,
    pub evidence_ids: BTreeSet<EvidenceId>,
    pub finalized_at: WorkflowTimestamp,
    pub functional_review_digest: Option<ContentDigest>,
    pub id: ReceiptId,
    pub request_digest: ContentDigest,
    pub security_review_digest: Option<ContentDigest>,
    pub workflow_id: WorkflowId,
}

impl ArbitrationReceipt {
    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        let mut hasher = CanonicalHasher::new(LEGACY_PROTOCOL_V1_ARBITRATION_RECEIPT_DOMAIN);
        hasher.write_bytes(self.id.as_uuid().as_bytes());
        hasher.write_bytes(self.workflow_id.as_uuid().as_bytes());
        hasher.write_bytes(self.candidate_id.as_uuid().as_bytes());
        hasher.write_digest(self.request_digest);
        hasher.write_digest(self.candidate_digest);
        hasher.write_bool(self.functional_review_digest.is_some());
        if let Some(digest) = self.functional_review_digest {
            hasher.write_digest(digest);
        }
        hasher.write_bool(self.security_review_digest.is_some());
        if let Some(digest) = self.security_review_digest {
            hasher.write_digest(digest);
        }
        hasher.write_digest(self.arbiter_verdict_digest);
        hasher.write_str(&self.finalized_at.to_string());
        hasher.write_u64(
            u64::try_from(self.evidence_ids.len()).expect("supported evidence counts fit in u64"),
        );
        for evidence_id in &self.evidence_ids {
            hasher.write_bytes(evidence_id.as_uuid().as_bytes());
        }
        hasher.finish()
    }
}
