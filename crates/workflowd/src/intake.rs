use serde::{Deserialize, Serialize};
use workflow_core::{ContentDigest, RequestError, RequestRecord, WorkflowTimestamp};

const MAX_ATTACHMENTS: usize = 256;
const MAX_MEDIA_TYPE_BYTES: usize = 127;
const MAX_NAME_BYTES: usize = 255;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentMetadata {
    content_digest: ContentDigest,
    display_name: Option<String>,
    media_type: String,
    size_bytes: u64,
}

impl AttachmentMetadata {
    pub fn new(
        content_digest: ContentDigest,
        display_name: Option<String>,
        media_type: String,
        size_bytes: u64,
    ) -> Result<Self, IntakeError> {
        if display_name.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.len() > MAX_NAME_BYTES
                || name.contains(['/', '\\'])
                || name.chars().any(char::is_control)
        }) {
            return Err(IntakeError::UnsafeAttachmentName);
        }
        if media_type.is_empty()
            || media_type.len() > MAX_MEDIA_TYPE_BYTES
            || !media_type.is_ascii()
            || media_type.bytes().any(|byte| byte.is_ascii_control())
        {
            return Err(IntakeError::InvalidMediaType);
        }
        Ok(Self {
            content_digest,
            display_name,
            media_type,
            size_bytes,
        })
    }

    #[must_use]
    pub const fn content_digest(&self) -> ContentDigest {
        self.content_digest
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImmutableIntake {
    attachments: Vec<AttachmentMetadata>,
    original_bytes: Vec<u8>,
    request: RequestRecord,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UncheckedIntake {
    attachments: Vec<AttachmentMetadata>,
    original_bytes: Vec<u8>,
    request: RequestRecord,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArbiterIntakeBundle {
    pub amendment_digests: Vec<ContentDigest>,
    pub attachments: Vec<AttachmentMetadata>,
    pub original_digest: ContentDigest,
    pub original_request: String,
    pub request_digest: ContentDigest,
}

#[derive(Debug)]
pub enum IntakeError {
    AttachmentMismatch,
    InvalidMediaType,
    InvalidUtf8(std::str::Utf8Error),
    Request(RequestError),
    RequestTooLarge,
    TooManyAttachments,
    UnsafeAttachmentName,
}

impl std::fmt::Display for IntakeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AttachmentMismatch => {
                formatter.write_str("attachment metadata does not match the immutable request")
            }
            Self::InvalidMediaType => formatter.write_str("attachment media type is invalid"),
            Self::InvalidUtf8(error) => error.fmt(formatter),
            Self::Request(error) => error.fmt(formatter),
            Self::RequestTooLarge => formatter.write_str("original request exceeds the byte limit"),
            Self::TooManyAttachments => formatter.write_str("attachment count exceeds the limit"),
            Self::UnsafeAttachmentName => {
                formatter.write_str("attachment display name must be a safe basename")
            }
        }
    }
}

impl std::error::Error for IntakeError {}

impl ImmutableIntake {
    pub fn capture(
        original_bytes: Vec<u8>,
        attachments: Vec<AttachmentMetadata>,
    ) -> Result<Self, IntakeError> {
        if original_bytes.len() > MAX_REQUEST_BYTES {
            return Err(IntakeError::RequestTooLarge);
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(IntakeError::TooManyAttachments);
        }
        let original_text = std::str::from_utf8(&original_bytes)
            .map_err(IntakeError::InvalidUtf8)?
            .to_owned();
        let attachment_hashes = attachments
            .iter()
            .map(AttachmentMetadata::content_digest)
            .collect();
        Ok(Self {
            request: RequestRecord::new(original_text, attachment_hashes),
            original_bytes,
            attachments,
        })
    }

    pub fn append_amendment(
        &mut self,
        text: String,
        received_at: WorkflowTimestamp,
    ) -> Result<(), IntakeError> {
        self.request
            .append_amendment(text, received_at)
            .map_err(IntakeError::Request)
    }

    #[must_use]
    pub fn arbiter_bundle(&self) -> ArbiterIntakeBundle {
        ArbiterIntakeBundle {
            amendment_digests: self
                .request
                .amendments()
                .iter()
                .map(workflow_core::RequestAmendment::digest)
                .collect(),
            attachments: self.attachments.clone(),
            original_digest: ContentDigest::of(&self.original_bytes),
            original_request: self.request.original_text().to_owned(),
            request_digest: self.request.digest(),
        }
    }

    #[must_use]
    pub fn request(&self) -> &RequestRecord {
        &self.request
    }
}

impl TryFrom<UncheckedIntake> for ImmutableIntake {
    type Error = IntakeError;

    fn try_from(value: UncheckedIntake) -> Result<Self, Self::Error> {
        let mut intake = Self::capture(value.original_bytes, value.attachments)?;
        if intake.request.original_text() != value.request.original_text()
            || intake.request.attachment_hashes() != value.request.attachment_hashes()
        {
            return Err(IntakeError::AttachmentMismatch);
        }
        for amendment in value.request.amendments() {
            intake.append_amendment(amendment.text.clone(), amendment.received_at)?;
        }
        if intake.request != value.request {
            return Err(IntakeError::AttachmentMismatch);
        }
        Ok(intake)
    }
}

impl<'de> Deserialize<'de> for ImmutableIntake {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        UncheckedIntake::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}
