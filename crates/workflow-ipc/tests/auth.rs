use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use workflow_ipc::auth::{AuthError, Authenticator};

#[test]
fn valid_challenge_is_single_use() {
    let secret = [7_u8; 32];
    let challenge = Authenticator::challenge([9_u8; 32], 1_000);
    let response = Authenticator::respond(&secret, &challenge);
    let mut authenticator = Authenticator::new(secret);
    authenticator.verify(&challenge, &response, 999).unwrap();
    assert_eq!(
        authenticator.verify(&challenge, &response, 999),
        Err(AuthError::Replayed)
    );
}

#[test]
fn wrong_secret_nonce_and_expired_challenges_fail() {
    let secret = [1_u8; 32];
    let challenge = Authenticator::challenge([2_u8; 32], 100);
    let mut authenticator = Authenticator::new(secret);
    let wrong_secret = Authenticator::respond(&[3_u8; 32], &challenge);
    assert_eq!(
        authenticator.verify(&challenge, &wrong_secret, 99),
        Err(AuthError::Invalid)
    );

    let mut wrong_nonce = Authenticator::respond(&secret, &challenge);
    wrong_nonce.nonce = [4_u8; 32];
    assert_eq!(
        authenticator.verify(&challenge, &wrong_nonce, 99),
        Err(AuthError::Invalid)
    );

    let response = Authenticator::respond(&secret, &challenge);
    assert_eq!(
        authenticator.verify(&challenge, &response, 101),
        Err(AuthError::Expired)
    );
}

#[test]
fn previous_product_authentication_domain_is_rejected() {
    let secret = [1_u8; 32];
    let challenge = Authenticator::challenge([2_u8; 32], 100);
    let mut legacy_mac = Hmac::<Sha256>::new_from_slice(&secret).unwrap();
    legacy_mac.update(b"opencode-workflow-ipc-auth-v1");
    legacy_mac.update(&challenge.nonce);
    legacy_mac.update(&challenge.expires_at_unix_millis.to_be_bytes());
    let response = workflow_ipc::auth::ChallengeResponse {
        mac: legacy_mac.finalize().into_bytes().into(),
        nonce: challenge.nonce,
    };
    let mut authenticator = Authenticator::new(secret);

    assert_eq!(
        authenticator.verify(&challenge, &response, 99),
        Err(AuthError::Invalid)
    );
}

#[test]
fn errors_never_render_secret_or_mac_material() {
    for error in [
        AuthError::Expired,
        AuthError::Invalid,
        AuthError::Replayed,
        AuthError::Saturated,
    ] {
        let text = error.to_string();
        assert!(!text.contains("070707"));
        assert!(!text.contains("mac"));
        assert!(!text.contains("secret"));
    }
}

#[test]
fn replay_cache_is_bounded_and_expired_entries_are_reclaimed() {
    let secret = [5_u8; 32];
    let mut authenticator = Authenticator::new(secret);
    for value in 0..4096_u32 {
        let mut nonce = [0_u8; 32];
        nonce[..4].copy_from_slice(&value.to_be_bytes());
        let challenge = Authenticator::challenge(nonce, 100);
        let response = Authenticator::respond(&secret, &challenge);
        authenticator.verify(&challenge, &response, 1).unwrap();
    }
    let full = Authenticator::challenge([255_u8; 32], 100);
    assert_eq!(
        authenticator.verify(&full, &Authenticator::respond(&secret, &full), 1),
        Err(AuthError::Saturated)
    );

    let future = Authenticator::challenge([254_u8; 32], 200);
    authenticator
        .verify(&future, &Authenticator::respond(&secret, &future), 101)
        .unwrap();
}
