#![forbid(unsafe_code)]

mod context;
mod git;
pub mod graph;
mod ignore_policy;
mod index;
mod inventory;
pub mod languages;
mod lsp;
mod manifest;
pub mod parser;
mod query;
mod reconcile;
mod watch;

pub use context::{ContextBudget, ContextBundle, ContextLevel, context_bundle};
pub use git::{GitChange, GitChangeKind, parse_name_status_z};
pub use ignore_policy::{IgnorePolicy, IgnorePolicyError};
pub use index::{IndexError, IndexReport, IndexTimings, index_project};
pub use inventory::{InventoryEntry, InventoryError, InventoryStats, inventory};
pub use lsp::{LspFactBatch, LspMergeError, merge_lsp_facts};
pub use manifest::{
    FileChange, FileMetadata, Manifest, ManifestEntry, ManifestError, ManifestPlan, ManifestUpdate,
    ResolvedFileChange, hash_file,
};
pub use query::{TraversalDirection, TraversalResult, impact, neighbors, shortest_path};
pub use reconcile::{ReconcileCandidate, ReconcileError, reconcile};
pub use watch::{ChangeAccumulator, CoalescedChange, WatchError, watch_project};
