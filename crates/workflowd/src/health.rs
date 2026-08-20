use workflow_core::PROTOCOL_VERSION;
use workflow_ipc::HealthReport;
use workflow_store::{CURRENT_SCHEMA_VERSION, StoreMode};

#[must_use]
pub fn health_report(mode: StoreMode) -> HealthReport {
    let (schema_mode, schema_version) = match mode {
        StoreMode::ReadWrite => ("read_write", CURRENT_SCHEMA_VERSION),
        StoreMode::SafeReadOnly { schema_version } => ("safe_read_only", schema_version),
    };
    HealthReport {
        product_version: env!("CARGO_PKG_VERSION").to_owned(),
        protocol_version: PROTOCOL_VERSION,
        schema_mode: schema_mode.to_owned(),
        schema_version,
    }
}
