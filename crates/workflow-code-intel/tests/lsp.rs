mod common;

use std::collections::BTreeMap;

use workflow_code_intel::graph::{FactConfidence, FactProvider};
use workflow_code_intel::{LspFactBatch, LspMergeError, merge_lsp_facts};
use workflow_core::ProjectId;

#[test]
fn language_server_facts_retain_source_provider_and_cannot_override_extracted_facts() {
    let project = ProjectId::new();
    let mut partition = common::partition(project, "src", &["run"]);
    let extracted = partition
        .nodes
        .values()
        .find(|node| node.name == "run")
        .unwrap()
        .clone();
    let mut inferred = extracted.clone();
    inferred.confidence = FactConfidence::Inferred;
    inferred.provider = FactProvider::LanguageServer("rust-analyzer".to_owned());
    inferred.range = None;
    let partition_id = partition.id;
    merge_lsp_facts(
        &mut partition,
        LspFactBatch {
            edges: BTreeMap::new(),
            nodes: BTreeMap::from([(inferred.id, inferred)]),
            partition_id,
            provider: "rust-analyzer".to_owned(),
        },
    )
    .unwrap();
    assert_eq!(partition.nodes[&extracted.id], extracted);
}

#[test]
fn language_server_failure_isolated_from_readable_graph() {
    let project = ProjectId::new();
    let mut partition = common::partition(project, "src", &["run"]);
    let before = partition.clone();
    let partition_id = partition.id;
    assert_eq!(
        merge_lsp_facts(
            &mut partition,
            LspFactBatch {
                edges: BTreeMap::new(),
                nodes: BTreeMap::new(),
                partition_id,
                provider: String::new(),
            },
        ),
        Err(LspMergeError::InvalidProvider)
    );
    assert_eq!(partition, before);
}
