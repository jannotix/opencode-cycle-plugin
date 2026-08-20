use std::collections::VecDeque;

use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{FrameDecoder, FrameError, encode_frame};

#[derive(Debug)]
pub enum ChannelError {
    Closed,
    Frame(FrameError),
    Io(std::io::Error),
}

impl std::fmt::Display for ChannelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => {
                formatter.write_str("local IPC connection closed before a complete message")
            }
            Self::Frame(error) => error.fmt(formatter),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ChannelError {}

impl From<FrameError> for ChannelError {
    fn from(value: FrameError) -> Self {
        Self::Frame(value)
    }
}

impl From<std::io::Error> for ChannelError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

pub struct JsonChannel<S> {
    decoder: FrameDecoder,
    pending: VecDeque<Vec<u8>>,
    stream: S,
}

impl<S> JsonChannel<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    #[must_use]
    pub fn new(stream: S) -> Self {
        Self {
            decoder: FrameDecoder::new(),
            pending: VecDeque::new(),
            stream,
        }
    }

    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<(), ChannelError> {
        self.stream.write_all(&encode_frame(value)?).await?;
        self.stream.flush().await?;
        Ok(())
    }

    pub async fn receive<T: DeserializeOwned>(&mut self) -> Result<T, ChannelError> {
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return serde_json::from_slice(&frame)
                    .map_err(FrameError::from)
                    .map_err(ChannelError::from);
            }
            let mut buffer = [0_u8; 8192];
            let read = self.stream.read(&mut buffer).await?;
            if read == 0 {
                return Err(ChannelError::Closed);
            }
            self.pending.extend(self.decoder.feed(&buffer[..read])?);
        }
    }

    pub fn into_inner(self) -> S {
        self.stream
    }
}
