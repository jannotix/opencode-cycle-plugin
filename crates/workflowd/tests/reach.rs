//! What a change reaches, and what the verification plan does with that answer.

use std::collections::{BTreeMap, BTreeSet};

use workflow_code_intel::graph::{
    EdgeInput, EdgeKind, FactConfidence, FactProvider, GraphEdge, GraphNode, GraphPartition,
    GraphStore, NodeInput, NodeKind, PartitionId,
};
use workflow_core::{
    ArchitecturePlan, ContentDigest, EvidenceKind, PlannedTask, ProjectId, Requirement, TaskId,
    WorkflowTimestamp,
};
use workflowd::verification::{Reach, ReachNote, VerificationExecutor, compute_reach, discover};

/// The code graph and the control plane share one SQLite file, and the control-plane store owns
/// the migrations. Opening it first is what creates the schema the graph store then requires.
fn empty_graph(directory: &std::path::Path) -> GraphStore {
    let path = directory.join("control-plane.db");
    drop(workflow_store::Store::open(&path, std::num::NonZeroUsize::new(1).unwrap()).unwrap());
    GraphStore::open(&path).unwrap()
}

/// One file node per path, plus an `Imports` edge for every `(importer, imported)` pair.
///
/// Reach walks incoming edges, so an edge from the importer to the file it imports is what makes
/// the imported file reachable *from* its importer.
fn graph(
    directory: &std::path::Path,
    project_id: ProjectId,
    imports: &[(&str, &str)],
) -> GraphStore {
    let mut store = empty_graph(directory);
    let partition_id = PartitionId::new(project_id, "src");
    let mut paths = BTreeSet::new();
    for (importer, imported) in imports {
        paths.insert(*importer);
        paths.insert(*imported);
    }
    let nodes: BTreeMap<&str, GraphNode> = paths
        .iter()
        .map(|path| {
            let node = GraphNode::new(NodeInput {
                confidence: FactConfidence::Extracted,
                kind: NodeKind::File,
                name: path.rsplit('/').next().unwrap().to_owned(),
                partition_id,
                provider: FactProvider::Manifest,
                qualified_name: (*path).to_owned(),
                range: None,
                source_path: (*path).to_owned(),
            })
            .unwrap();
            (*path, node)
        })
        .collect();
    let mut edges = BTreeMap::new();
    for (importer, imported) in imports {
        let edge = GraphEdge::new(EdgeInput {
            confidence: FactConfidence::Extracted,
            kind: EdgeKind::Imports,
            partition_id,
            provider: FactProvider::Parser("typescript".to_owned()),
            range: None,
            source: nodes[importer].id,
            source_path: (*importer).to_owned(),
            target: nodes[imported].id,
        })
        .unwrap();
        edges.insert(edge.id, edge);
    }
    let partition = GraphPartition {
        edges,
        external_nodes: BTreeSet::new(),
        id: partition_id,
        nodes: nodes.into_values().map(|node| (node.id, node)).collect(),
        project_id,
        scope: "src".to_owned(),
    };
    store
        .replace_partition(&partition, true, WorkflowTimestamp::now())
        .unwrap();
    store
}

fn architecture(scopes: Vec<String>) -> ArchitecturePlan {
    ArchitecturePlan::validate(
        ContentDigest::of(b"request"),
        vec![Requirement {
            acceptance_criteria: vec!["The feature works end to end.".to_owned()],
            id: "REQ-1".to_owned(),
            statement: "Implement the complete feature.".to_owned(),
        }],
        vec![PlannedTask {
            acceptance_criteria: vec!["All required checks pass.".to_owned()],
            dependencies: vec![],
            id: TaskId::new(),
            objective: "Implement the bounded feature.".to_owned(),
            requirement_ids: vec!["REQ-1".to_owned()],
            title: "Feature".to_owned(),
            verification_commands: vec!["bun test".to_owned()],
            write_scopes: scopes,
        }],
        vec![],
        vec![],
        vec!["Run the complete integration flow.".to_owned()],
    )
    .unwrap()
}

#[test]
fn a_change_reaching_the_user_interface_plans_the_user_interface_gates() {
    let directory = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new();
    // `page.tsx` imports the loader. Nothing the change touches is a user-interface path, and the
    // declared scope is the generic `src/`, so before reach neither the scope rule nor N4's
    // changed-path rule could see a user interface here.
    let store = graph(
        directory.path(),
        project_id,
        &[("src/ui/page.tsx", "src/lib/loader.ts")],
    );
    let changed = vec!["src/lib/loader.ts".to_owned()];
    let reach = compute_reach(&store, project_id, &changed);

    assert_eq!(reach.note, Some(ReachNote::Resolved(1)));
    assert_eq!(reach.reached, vec!["src/ui/page.tsx".to_owned()]);

    let plan = discover(
        directory.path(),
        &architecture(vec!["src".to_owned()]),
        &changed,
        &reach,
    )
    .unwrap();
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name == "browser:affected-user-flow"),
        "a change reaching the user interface must plan a browser flow"
    );
    assert!(
        plan.gates
            .iter()
            .any(|gate| gate.name == "accessibility:affected-user-flow")
    );
    // A reach that resolved is itself evidence: the record says the computation ran and what it
    // concluded, so a later run that silently stopped computing reach is visible in the ledger
    // rather than looking identical to a change that reaches nothing.
    let recorded = plan
        .gates
        .iter()
        .find(|gate| gate.name == "impact:unresolved")
        .expect("a resolved reach must still be recorded");
    let VerificationExecutor::Note { detail } = &recorded.executor else {
        panic!(
            "a resolved reach must record passing evidence, got {:?}",
            recorded.executor
        );
    };
    assert!(detail.contains("reaches 1 other indexed files"), "{detail}");
}

#[test]
fn the_same_change_without_the_reach_plans_no_user_interface_gate() {
    // The control for the test above. It states that the gate came from reach and from nothing
    // else, so a future change that plans that gate for an unrelated reason cannot make the proof
    // above pass while reach is broken.
    let directory = tempfile::tempdir().unwrap();
    let plan = discover(
        directory.path(),
        &architecture(vec!["src".to_owned()]),
        &["src/lib/loader.ts".to_owned()],
        &Reach::none(),
    )
    .unwrap();
    assert!(
        !plan
            .gates
            .iter()
            .any(|gate| gate.kind == EvidenceKind::Browser)
    );
}

#[test]
fn a_project_that_was_never_indexed_reports_an_unresolved_reach() {
    let directory = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new();
    let store = empty_graph(directory.path());
    let changed = vec!["src/lib/loader.ts".to_owned()];
    let reach = compute_reach(&store, project_id, &changed);

    let Some(ReachNote::Unresolved(reason)) = reach.note else {
        panic!("an unindexed project must not report an exact reach, got {reach:?}");
    };
    assert!(reason.contains("never been indexed"), "{reason}");

    let plan = discover(
        directory.path(),
        &architecture(vec!["src".to_owned()]),
        &changed,
        &Reach::unresolved(reason),
    )
    .unwrap();
    let gate = plan
        .gates
        .iter()
        .find(|gate| gate.name == "impact:unresolved")
        .expect("the unresolved reach must be recorded as evidence");
    // Advisory, not mandatory: OpenCode has no strictness setting to raise it under, and an
    // unindexed project must still be able to complete a cycle.
    assert!(!gate.mandatory);
}

#[test]
fn a_changed_file_the_index_does_not_know_is_named_in_the_reason() {
    let directory = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new();
    let store = graph(
        directory.path(),
        project_id,
        &[("src/ui/page.tsx", "src/lib/loader.ts")],
    );
    let reach = compute_reach(&store, project_id, &["src/lib/fresh.ts".to_owned()]);

    let Some(ReachNote::Unresolved(reason)) = reach.note else {
        panic!("an unknown changed file must not report an exact reach, got {reach:?}");
    };
    assert!(reason.contains("src/lib/fresh.ts"), "{reason}");
}

#[test]
fn a_change_outside_the_modelled_languages_is_not_an_unresolved_reach() {
    let directory = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new();
    // No graph at all, and yet this must not be reported as a gap: a changelog edit reaches
    // nothing because it is not modelled, which is a different fact from "we could not tell".
    let store = empty_graph(directory.path());
    let reach = compute_reach(&store, project_id, &["CHANGELOG.md".to_owned()]);

    assert_eq!(reach, Reach::none());
}

#[test]
fn a_widely_consumed_file_reports_high_fan_in_and_infers_no_gate() {
    let directory = tempfile::tempdir().unwrap();
    let project_id = ProjectId::new();
    // Every importer is a `.tsx` under `ui/`, so if a truncated traversal were allowed to insert
    // gates this would plan the browser gates. It must not: a truncated set is not evidence.
    let imports: Vec<(String, String)> = (0..400)
        .map(|index| {
            (
                format!("src/ui/page{index:03}.tsx"),
                "src/lib/hub.ts".to_owned(),
            )
        })
        .collect();
    let borrowed: Vec<(&str, &str)> = imports
        .iter()
        .map(|(importer, imported)| (importer.as_str(), imported.as_str()))
        .collect();
    let store = graph(directory.path(), project_id, &borrowed);
    let changed = vec!["src/lib/hub.ts".to_owned()];
    let reach = compute_reach(&store, project_id, &changed);

    let Some(ReachNote::HighFanIn(hubs)) = reach.note.clone() else {
        panic!("a 400-consumer hub must report high fan-in, got {reach:?}");
    };
    assert_eq!(hubs, vec!["src/lib/hub.ts".to_owned()]);
    assert!(reach.reached.is_empty());

    let plan = discover(
        directory.path(),
        &architecture(vec!["src".to_owned()]),
        &changed,
        &reach,
    )
    .unwrap();
    assert!(
        !plan
            .gates
            .iter()
            .any(|gate| gate.kind == EvidenceKind::Browser),
        "a truncated traversal must not be used to infer gates"
    );
    let gate = plan
        .gates
        .iter()
        .find(|gate| gate.name == "impact:high-fan-in")
        .expect("high fan-in must be recorded as evidence");
    assert!(!gate.mandatory);
}
