use serde::{Deserialize, Serialize};

use crate::{ContentDigest, WorkflowTimestamp, digest::CanonicalHasher};

// Immutable protocol-v1 compatibility identifiers for persisted request digests.
const LEGACY_PROTOCOL_V1_REQUEST_AMENDMENT_DOMAIN: &str = "opencode-workflow/request-amendment/v1";
const LEGACY_PROTOCOL_V1_REQUEST_DOMAIN: &str = "opencode-workflow/request/v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct RequestAmendment {
    pub sequence: u32,
    pub text: String,
    pub received_at: WorkflowTimestamp,
}

impl RequestAmendment {
    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        let mut hasher = CanonicalHasher::new(LEGACY_PROTOCOL_V1_REQUEST_AMENDMENT_DOMAIN);
        hasher.write_u64(u64::from(self.sequence));
        hasher.write_str(&self.text);
        hasher.write_str(&self.received_at.to_string());
        hasher.finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct RequestRecord {
    original_text: String,
    attachment_hashes: Vec<ContentDigest>,
    amendments: Vec<RequestAmendment>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestRecordUnchecked {
    original_text: String,
    attachment_hashes: Vec<ContentDigest>,
    amendments: Vec<RequestAmendment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestError {
    InvalidAmendmentSequence,
    TooManyAmendments,
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAmendmentSequence => {
                "request amendments must have a contiguous one-based sequence"
            }
            Self::TooManyAmendments => "the request amendment limit has been reached",
        })
    }
}

impl std::error::Error for RequestError {}

impl TryFrom<RequestRecordUnchecked> for RequestRecord {
    type Error = RequestError;

    fn try_from(value: RequestRecordUnchecked) -> Result<Self, Self::Error> {
        for (index, amendment) in value.amendments.iter().enumerate() {
            let expected = u32::try_from(index)
                .map_err(|_| RequestError::TooManyAmendments)?
                .checked_add(1)
                .ok_or(RequestError::TooManyAmendments)?;
            if amendment.sequence != expected {
                return Err(RequestError::InvalidAmendmentSequence);
            }
        }
        Ok(Self {
            original_text: value.original_text,
            attachment_hashes: value.attachment_hashes,
            amendments: value.amendments,
        })
    }
}

impl<'de> Deserialize<'de> for RequestRecord {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        RequestRecordUnchecked::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}

impl RequestRecord {
    #[must_use]
    pub fn new(original_text: String, attachment_hashes: Vec<ContentDigest>) -> Self {
        Self {
            original_text,
            attachment_hashes,
            amendments: Vec::new(),
        }
    }

    #[must_use]
    pub fn original_text(&self) -> &str {
        &self.original_text
    }

    #[must_use]
    pub fn attachment_hashes(&self) -> &[ContentDigest] {
        &self.attachment_hashes
    }

    #[must_use]
    pub fn amendments(&self) -> &[RequestAmendment] {
        &self.amendments
    }

    pub fn append_amendment(
        &mut self,
        text: String,
        received_at: WorkflowTimestamp,
    ) -> Result<(), RequestError> {
        let sequence = u32::try_from(self.amendments.len())
            .map_err(|_| RequestError::TooManyAmendments)?
            .checked_add(1)
            .ok_or(RequestError::TooManyAmendments)?;
        self.amendments.push(RequestAmendment {
            sequence,
            text,
            received_at,
        });
        Ok(())
    }

    #[must_use]
    pub fn digest(&self) -> ContentDigest {
        let mut hasher = CanonicalHasher::new(LEGACY_PROTOCOL_V1_REQUEST_DOMAIN);
        hasher.write_str(&self.original_text);
        let mut attachments = self.attachment_hashes.clone();
        attachments.sort_unstable();
        hasher.write_u64(
            u64::try_from(attachments.len()).expect("supported collection lengths fit in u64"),
        );
        for attachment in attachments {
            hasher.write_digest(attachment);
        }
        hasher.write_u64(
            u64::try_from(self.amendments.len()).expect("supported collection lengths fit in u64"),
        );
        for amendment in &self.amendments {
            hasher.write_u64(u64::from(amendment.sequence));
            hasher.write_str(&amendment.text);
            hasher.write_str(&amendment.received_at.to_string());
        }
        hasher.finish()
    }
}
