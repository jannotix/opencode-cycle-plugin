use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use workflow_core::ContentDigest;

use crate::LedgerEvent;

// Immutable protocol-v1 compatibility identifier for persisted ledger entry hashes.
const LEGACY_PROTOCOL_V1_LEDGER_ENTRY_HASH_DOMAIN: &[u8] = b"opencode-workflow-ledger-entry-v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerEntry {
    pub event: LedgerEvent,
    pub hash: ContentDigest,
    pub previous_hash: Option<ContentDigest>,
    pub sequence: u64,
}

impl LedgerEntry {
    pub fn new(
        sequence: u64,
        previous_hash: Option<ContentDigest>,
        event: LedgerEvent,
    ) -> Result<Self, LedgerError> {
        Self::calculate_hash(sequence, previous_hash, &event).map(|hash| Self {
            event,
            hash,
            previous_hash,
            sequence,
        })
    }

    fn calculate_hash(
        sequence: u64,
        previous_hash: Option<ContentDigest>,
        event: &LedgerEvent,
    ) -> Result<ContentDigest, LedgerError> {
        let event = event
            .canonical_bytes()
            .map_err(LedgerError::Serialization)?;
        let mut input = Vec::with_capacity(
            LEGACY_PROTOCOL_V1_LEDGER_ENTRY_HASH_DOMAIN.len() + 8 + 1 + 32 + 8 + event.len(),
        );
        input.extend_from_slice(LEGACY_PROTOCOL_V1_LEDGER_ENTRY_HASH_DOMAIN);
        input.extend_from_slice(&sequence.to_be_bytes());
        match previous_hash {
            Some(hash) => {
                input.push(1);
                input.extend_from_slice(hash.as_bytes());
            }
            None => input.push(0),
        }
        input.extend_from_slice(
            &u64::try_from(event.len())
                .map_err(|_| LedgerError::Capacity)?
                .to_be_bytes(),
        );
        input.extend_from_slice(&event);
        Ok(ContentDigest::of(&input))
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerChain {
    entries: Vec<LedgerEntry>,
}

impl LedgerChain {
    #[must_use]
    pub fn from_entries(entries: Vec<LedgerEntry>) -> Self {
        Self { entries }
    }

    #[must_use]
    pub fn entries(&self) -> &[LedgerEntry] {
        &self.entries
    }

    #[must_use]
    pub fn head(&self) -> Option<ContentDigest> {
        self.entries.last().map(|entry| entry.hash)
    }

    pub fn append(&mut self, event: LedgerEvent) -> Result<LedgerEntry, LedgerError> {
        let sequence = u64::try_from(self.entries.len()).map_err(|_| LedgerError::Capacity)?;
        let previous_hash = self.head();
        let entry = LedgerEntry::new(sequence, previous_hash, event)?;
        self.entries.push(entry.clone());
        Ok(entry)
    }

    #[must_use]
    pub fn verify(&self, expected_head: Option<ContentDigest>) -> ChainVerification {
        let mut previous = None;
        for (index, entry) in self.entries.iter().enumerate() {
            let Ok(sequence) = u64::try_from(index) else {
                return ChainVerification::Broken {
                    reason: ChainFailure::Sequence,
                    sequence: u64::MAX,
                };
            };
            if entry.sequence != sequence {
                return ChainVerification::Broken {
                    reason: ChainFailure::Sequence,
                    sequence,
                };
            }
            if entry.previous_hash != previous {
                return ChainVerification::Broken {
                    reason: ChainFailure::PreviousHash,
                    sequence,
                };
            }
            match LedgerEntry::calculate_hash(sequence, previous, &entry.event) {
                Ok(hash) if hash == entry.hash => previous = Some(hash),
                Ok(_) | Err(_) => {
                    return ChainVerification::Broken {
                        reason: ChainFailure::EntryHash,
                        sequence,
                    };
                }
            }
        }
        if expected_head.is_some() && expected_head != previous {
            return ChainVerification::HeadMismatch {
                actual: previous,
                expected: expected_head,
            };
        }
        ChainVerification::Valid {
            entries: self.entries.len(),
            head: previous,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChainFailure {
    EntryHash,
    PreviousHash,
    Sequence,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChainVerification {
    Valid {
        entries: usize,
        head: Option<ContentDigest>,
    },
    Broken {
        reason: ChainFailure,
        sequence: u64,
    },
    HeadMismatch {
        actual: Option<ContentDigest>,
        expected: Option<ContentDigest>,
    },
}

#[derive(Debug)]
pub enum LedgerError {
    Capacity,
    LockPoisoned,
    Serialization(serde_json::Error),
}

impl std::fmt::Display for LedgerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Capacity => formatter.write_str("ledger capacity exceeded"),
            Self::LockPoisoned => formatter.write_str("ledger writer lock is poisoned"),
            Self::Serialization(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for LedgerError {}

#[derive(Debug, Default)]
pub struct LedgerWriter(Mutex<LedgerChain>);

impl LedgerWriter {
    #[must_use]
    pub fn new(chain: LedgerChain) -> Self {
        Self(Mutex::new(chain))
    }

    pub fn append(&self, event: LedgerEvent) -> Result<LedgerEntry, LedgerError> {
        self.0
            .lock()
            .map_err(|_| LedgerError::LockPoisoned)?
            .append(event)
    }

    pub fn snapshot(&self) -> Result<LedgerChain, LedgerError> {
        self.0
            .lock()
            .map_err(|_| LedgerError::LockPoisoned)
            .map(|chain| chain.clone())
    }
}
