use serde::{Serialize, de::DeserializeOwned};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Empty,
    Json(serde_json::Error),
    Oversized { announced: usize, maximum: usize },
    Poisoned,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => formatter.write_str("empty IPC frames are forbidden"),
            Self::Json(error) => error.fmt(formatter),
            Self::Oversized { announced, maximum } => {
                write!(
                    formatter,
                    "IPC frame size {announced} exceeds maximum {maximum}"
                )
            }
            Self::Poisoned => {
                formatter.write_str("IPC decoder is closed after a protocol violation")
            }
        }
    }
}

impl std::error::Error for FrameError {}

impl From<serde_json::Error> for FrameError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    let payload = serde_json::to_vec(value)?;
    if payload.is_empty() {
        return Err(FrameError::Empty);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::Oversized {
            announced: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    let length = u32::try_from(payload.len()).expect("maximum frame length fits in u32");
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

enum DecodeState {
    Header { bytes: [u8; 4], filled: usize },
    Payload { bytes: Vec<u8>, length: usize },
    Poisoned,
}

pub struct FrameDecoder {
    state: DecodeState,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            state: DecodeState::Header {
                bytes: [0; 4],
                filled: 0,
            },
        }
    }

    pub fn feed(&mut self, mut input: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        let mut complete = Vec::new();
        while !input.is_empty() {
            match &mut self.state {
                DecodeState::Header { bytes, filled } => {
                    let copied = (4 - *filled).min(input.len());
                    bytes[*filled..*filled + copied].copy_from_slice(&input[..copied]);
                    *filled += copied;
                    input = &input[copied..];
                    if *filled == 4 {
                        let length = usize::try_from(u32::from_be_bytes(*bytes))
                            .expect("u32 fits in usize on supported targets");
                        if length == 0 {
                            self.state = DecodeState::Poisoned;
                            return Err(FrameError::Empty);
                        }
                        if length > MAX_FRAME_BYTES {
                            self.state = DecodeState::Poisoned;
                            return Err(FrameError::Oversized {
                                announced: length,
                                maximum: MAX_FRAME_BYTES,
                            });
                        }
                        self.state = DecodeState::Payload {
                            bytes: Vec::with_capacity(length),
                            length,
                        };
                    }
                }
                DecodeState::Payload { bytes, length } => {
                    let copied = (*length - bytes.len()).min(input.len());
                    bytes.extend_from_slice(&input[..copied]);
                    input = &input[copied..];
                    if bytes.len() == *length {
                        complete.push(std::mem::take(bytes));
                        self.state = DecodeState::Header {
                            bytes: [0; 4],
                            filled: 0,
                        };
                    }
                }
                DecodeState::Poisoned => return Err(FrameError::Poisoned),
            }
        }
        Ok(complete)
    }

    pub fn feed_json<T: DeserializeOwned>(&mut self, input: &[u8]) -> Result<Vec<T>, FrameError> {
        let mut decoded = Vec::new();
        for frame in self.feed(input)? {
            match serde_json::from_slice(&frame) {
                Ok(value) => decoded.push(value),
                Err(error) => {
                    self.state = DecodeState::Poisoned;
                    return Err(FrameError::Json(error));
                }
            }
        }
        Ok(decoded)
    }

    #[must_use]
    pub fn buffered_bytes(&self) -> usize {
        match &self.state {
            DecodeState::Header { filled, .. } => *filled,
            DecodeState::Payload { bytes, .. } => bytes.len(),
            DecodeState::Poisoned => 0,
        }
    }
}
