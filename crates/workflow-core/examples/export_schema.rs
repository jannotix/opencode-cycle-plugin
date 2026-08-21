#[cfg(not(feature = "schema"))]
compile_error!("enable the schema feature");

fn main() {
    let schema = schemars::schema_for!(workflow_core::ProtocolEnvelope);
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}
