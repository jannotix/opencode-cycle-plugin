use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    ClientMessage, HealthReport, ServerMessage,
    auth::Authenticator,
    channel::{ChannelError, JsonChannel},
    secret::IpcSecret,
};

#[derive(Debug)]
pub enum ClientError {
    Channel(ChannelError),
    Protocol(&'static str),
    Rejected { code: String, message: String },
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Channel(error) => error.fmt(formatter),
            Self::Protocol(message) => formatter.write_str(message),
            Self::Rejected { code, message } => {
                write!(formatter, "IPC request rejected ({code}): {message}")
            }
        }
    }
}

impl std::error::Error for ClientError {}

impl From<ChannelError> for ClientError {
    fn from(value: ChannelError) -> Self {
        Self::Channel(value)
    }
}

pub async fn query_health<S>(
    stream: S,
    secret: &IpcSecret,
    request_id: u64,
) -> Result<HealthReport, ClientError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut channel = JsonChannel::new(stream);
    let challenge = match channel.receive::<ServerMessage>().await? {
        ServerMessage::Challenge(challenge) => challenge,
        _ => {
            return Err(ClientError::Protocol(
                "server did not begin with an authentication challenge",
            ));
        }
    };
    channel
        .send(&ClientMessage::Authenticate(Authenticator::respond(
            secret.as_bytes(),
            &challenge,
        )))
        .await?;
    channel.send(&ClientMessage::Health { request_id }).await?;
    match channel.receive::<ServerMessage>().await? {
        ServerMessage::Health {
            request_id: received,
            report,
        } if received == request_id => Ok(report),
        ServerMessage::Error { code, message, .. } => Err(ClientError::Rejected { code, message }),
        _ => Err(ClientError::Protocol(
            "server returned an unexpected health response",
        )),
    }
}
