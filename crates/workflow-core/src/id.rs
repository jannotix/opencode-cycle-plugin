use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// Immutable protocol-v1 compatibility identifier for persisted project IDs.
const LEGACY_PROTOCOL_V1_PROJECT_DOMAIN: &[u8] = b"opencode-workflow/project/v1";

macro_rules! typed_id {
    ($name:ident) => {
        #[derive(
            Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            #[must_use]
            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(value).map(Self)
            }
        }

        #[cfg(feature = "schema")]
        impl schemars::JsonSchema for $name {
            fn inline_schema() -> bool {
                true
            }

            fn schema_name() -> std::borrow::Cow<'static, str> {
                std::borrow::Cow::Borrowed(stringify!($name))
            }

            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "format": "uuid"
                })
            }
        }
    };
}

typed_id!(ProjectId);
typed_id!(WorkflowId);
typed_id!(TaskId);
typed_id!(SessionId);
typed_id!(CandidateId);
typed_id!(EventId);
typed_id!(EvidenceId);
typed_id!(VerificationPlanId);
typed_id!(ReceiptId);
typed_id!(LeaseId);
typed_id!(MemoryId);
typed_id!(GoalId);

impl ProjectId {
    #[must_use]
    pub fn from_stable_key(value: &str) -> Self {
        let mut input = LEGACY_PROTOCOL_V1_PROJECT_DOMAIN.to_vec();
        input.extend_from_slice(value.as_bytes());
        let digest = crate::ContentDigest::of(&input);
        let mut bytes = [0_u8; 16];
        bytes.copy_from_slice(&digest.as_bytes()[..16]);
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        Self(Uuid::from_bytes(bytes))
    }
}
