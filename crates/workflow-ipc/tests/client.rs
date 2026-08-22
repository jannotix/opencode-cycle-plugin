use std::time::Duration;

use workflow_ipc::{
    ClientMessage, ServerMessage,
    auth::Challenge,
    channel::{ChannelError, JsonChannel},
    client::{ClientError, query_health},
    secret::IpcSecret,
};

#[tokio::test]
async fn authentication_close_fails_fast_without_waiting_for_a_request_timeout() {
    let secret = IpcSecret::generate().unwrap();
    let (client, server) = tokio::io::duplex(8_192);
    let server = tokio::spawn(async move {
        let mut channel = JsonChannel::new(server);
        channel
            .send(&ServerMessage::Challenge(Challenge {
                expires_at_unix_millis: i64::MAX,
                nonce: [7; 32],
            }))
            .await
            .unwrap();
        assert!(matches!(
            channel.receive::<ClientMessage>().await.unwrap(),
            ClientMessage::Authenticate(_)
        ));
    });

    let result = tokio::time::timeout(Duration::from_millis(250), query_health(client, &secret, 1))
        .await
        .expect("a closed authentication exchange must fail immediately");
    assert!(matches!(
        result,
        Err(ClientError::Channel(ChannelError::Closed))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn authentication_acknowledgement_must_match_the_protocol_version() {
    let secret = IpcSecret::generate().unwrap();
    let (client, server) = tokio::io::duplex(8_192);
    let server = tokio::spawn(async move {
        let mut channel = JsonChannel::new(server);
        channel
            .send(&ServerMessage::Challenge(Challenge {
                expires_at_unix_millis: i64::MAX,
                nonce: [9; 32],
            }))
            .await
            .unwrap();
        assert!(matches!(
            channel.receive::<ClientMessage>().await.unwrap(),
            ClientMessage::Authenticate(_)
        ));
        channel
            .send(&ServerMessage::Authenticated {
                protocol_version: workflow_core::PROTOCOL_VERSION + 1,
            })
            .await
            .unwrap();
    });

    let result = query_health(client, &secret, 1).await;
    assert!(matches!(result, Err(ClientError::Protocol(_))));
    server.await.unwrap();
}
