use serde::{Deserialize, Serialize};

use crate::{ArbiterVerdict, ArchitecturePlan, CandidateManifest, EvidenceRecord, RequestRecord};

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub enum ProtocolPayload {
    Request(RequestRecord),
    Architecture(ArchitecturePlan),
    Candidate(CandidateManifest),
    Evidence(EvidenceRecord),
    Verdict(ArbiterVerdict),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct ProtocolEnvelope {
    pub version: u16,
    pub payload: ProtocolPayload,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolEnvelopeUnchecked {
    version: u16,
    payload: ProtocolPayload,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolError {
    pub received: u16,
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
            self.received
        )
    }
}

impl std::error::Error for ProtocolError {}

impl ProtocolEnvelope {
    #[must_use]
    pub const fn new(payload: ProtocolPayload) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            payload,
        }
    }
}

impl TryFrom<ProtocolEnvelopeUnchecked> for ProtocolEnvelope {
    type Error = ProtocolError;

    fn try_from(value: ProtocolEnvelopeUnchecked) -> Result<Self, Self::Error> {
        if value.version != PROTOCOL_VERSION {
            return Err(ProtocolError {
                received: value.version,
            });
        }
        Ok(Self {
            version: value.version,
            payload: value.payload,
        })
    }
}

impl<'de> Deserialize<'de> for ProtocolEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        ProtocolEnvelopeUnchecked::deserialize(deserializer)?
            .try_into()
            .map_err(serde::de::Error::custom)
    }
}
