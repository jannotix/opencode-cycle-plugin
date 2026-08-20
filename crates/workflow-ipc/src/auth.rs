use std::collections::BTreeMap;

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const AUTH_DOMAIN: &[u8] = b"opencode-cycle-ipc-auth-v1";
const MAX_USED_CHALLENGES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Challenge {
    pub expires_at_unix_millis: i64,
    pub nonce: [u8; 32],
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeResponse {
    pub mac: [u8; 32],
    pub nonce: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthError {
    Expired,
    Invalid,
    Replayed,
    Saturated,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Expired => "IPC authentication challenge expired",
            Self::Invalid => "IPC authentication failed",
            Self::Replayed => "IPC authentication challenge was already used",
            Self::Saturated => "IPC authentication capacity is temporarily exhausted",
        })
    }
}

impl std::error::Error for AuthError {}

pub struct Authenticator {
    secret: [u8; 32],
    used: BTreeMap<[u8; 32], i64>,
}

impl Authenticator {
    #[must_use]
    pub const fn new(secret: [u8; 32]) -> Self {
        Self {
            secret,
            used: BTreeMap::new(),
        }
    }

    #[must_use]
    pub const fn challenge(nonce: [u8; 32], expires_at_unix_millis: i64) -> Challenge {
        Challenge {
            expires_at_unix_millis,
            nonce,
        }
    }

    #[must_use]
    pub fn respond(secret: &[u8; 32], challenge: &Challenge) -> ChallengeResponse {
        ChallengeResponse {
            mac: calculate_mac(secret, challenge),
            nonce: challenge.nonce,
        }
    }

    pub fn verify(
        &mut self,
        challenge: &Challenge,
        response: &ChallengeResponse,
        now_unix_millis: i64,
    ) -> Result<(), AuthError> {
        if now_unix_millis > challenge.expires_at_unix_millis {
            return Err(AuthError::Expired);
        }
        self.used.retain(|_, expiry| *expiry >= now_unix_millis);
        if self.used.contains_key(&challenge.nonce) {
            return Err(AuthError::Replayed);
        }
        if self.used.len() >= MAX_USED_CHALLENGES {
            return Err(AuthError::Saturated);
        }
        if response.nonce != challenge.nonce {
            return Err(AuthError::Invalid);
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC accepts 32-byte keys");
        update_mac(&mut mac, challenge);
        mac.verify_slice(&response.mac)
            .map_err(|_| AuthError::Invalid)?;
        self.used
            .insert(challenge.nonce, challenge.expires_at_unix_millis);
        Ok(())
    }
}

fn calculate_mac(secret: &[u8; 32], challenge: &Challenge) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts 32-byte keys");
    update_mac(&mut mac, challenge);
    mac.finalize().into_bytes().into()
}

fn update_mac(mac: &mut Hmac<Sha256>, challenge: &Challenge) {
    mac.update(AUTH_DOMAIN);
    mac.update(&challenge.nonce);
    mac.update(&challenge.expires_at_unix_millis.to_be_bytes());
}
