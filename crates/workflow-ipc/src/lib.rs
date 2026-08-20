#![deny(unsafe_code)]

pub mod audit;
pub mod auth;
pub mod channel;
pub mod client;
pub mod frame;
pub mod protocol;
pub mod secret;
pub mod transport;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows;

pub use frame::{FrameDecoder, FrameError, MAX_FRAME_BYTES, encode_frame};
pub use protocol::{
    AdmissionOperation, ClientMessage, ControlOperation, ExecutionOutcome, GoalControlAction,
    GoalOperation, HealthReport, IpcRequest, IpcResponse, ManagedBrowserAttestation, ServerMessage,
    VerificationEvidence,
};
