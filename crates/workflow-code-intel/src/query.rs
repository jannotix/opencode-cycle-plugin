use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;

use crate::graph::{EdgeId, GraphPartition, NodeId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TraversalDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TraversalResult {
    pub edges: Vec<EdgeId>,
    pub nodes: Vec<NodeId>,
    pub truncated: bool,
}

#[must_use]
pub fn neighbors(
    partition: &GraphPartition,
    node: NodeId,
    direction: TraversalDirection,
    limit: usize,
) -> TraversalResult {
    let mut matches: Vec<_> = partition
        .edges
        .values()
        .filter_map(|edge| match direction {
            TraversalDirection::Incoming if edge.target == node => Some((edge.id, edge.source)),
            TraversalDirection::Outgoing if edge.source == node => Some((edge.id, edge.target)),
            TraversalDirection::Incoming | TraversalDirection::Outgoing => None,
        })
        .collect();
    matches.sort_unstable();
    let limit = limit.max(1);
    let truncated = matches.len() > limit;
    matches.truncate(limit);
    TraversalResult {
        edges: matches.iter().map(|(edge, _)| *edge).collect(),
        nodes: matches.into_iter().map(|(_, node)| node).collect(),
        truncated,
    }
}

#[must_use]
pub fn shortest_path(
    partition: &GraphPartition,
    source: NodeId,
    target: NodeId,
    max_depth: usize,
    max_visited: usize,
) -> TraversalResult {
    if source == target {
        return TraversalResult {
            edges: Vec::new(),
            nodes: vec![source],
            truncated: false,
        };
    }
    let adjacency = adjacency(partition, TraversalDirection::Outgoing);
    let mut queue = VecDeque::from([(source, 0_usize)]);
    let mut visited = BTreeSet::from([source]);
    let mut previous: BTreeMap<NodeId, (NodeId, EdgeId)> = BTreeMap::new();
    let max_visited = max_visited.max(1);
    let mut truncated = false;
    while let Some((node, depth)) = queue.pop_front() {
        if depth >= max_depth {
            truncated = true;
            continue;
        }
        for (edge, next) in adjacency.get(&node).into_iter().flatten() {
            if visited.len() >= max_visited {
                truncated = true;
                break;
            }
            if visited.insert(*next) {
                previous.insert(*next, (node, *edge));
                if *next == target {
                    return reconstruct(source, target, &previous, truncated);
                }
                queue.push_back((*next, depth + 1));
            }
        }
    }
    TraversalResult {
        edges: Vec::new(),
        nodes: Vec::new(),
        truncated,
    }
}

#[must_use]
pub fn impact(
    partition: &GraphPartition,
    roots: &BTreeSet<NodeId>,
    direction: TraversalDirection,
    max_depth: usize,
    max_nodes: usize,
) -> TraversalResult {
    let adjacency = adjacency(partition, direction);
    let mut queue: VecDeque<_> = roots.iter().copied().map(|node| (node, 0_usize)).collect();
    let mut visited = roots.clone();
    let mut edges = BTreeSet::new();
    let max_nodes = max_nodes.max(roots.len());
    let mut truncated = false;
    while let Some((node, depth)) = queue.pop_front() {
        if depth >= max_depth {
            truncated = true;
            continue;
        }
        for (edge, next) in adjacency.get(&node).into_iter().flatten() {
            if visited.len() >= max_nodes {
                truncated = true;
                break;
            }
            edges.insert(*edge);
            if visited.insert(*next) {
                queue.push_back((*next, depth + 1));
            }
        }
    }
    TraversalResult {
        edges: edges.into_iter().collect(),
        nodes: visited.into_iter().collect(),
        truncated,
    }
}

fn adjacency(
    partition: &GraphPartition,
    direction: TraversalDirection,
) -> BTreeMap<NodeId, Vec<(EdgeId, NodeId)>> {
    let mut result: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for edge in partition.edges.values() {
        let (from, to) = match direction {
            TraversalDirection::Incoming => (edge.target, edge.source),
            TraversalDirection::Outgoing => (edge.source, edge.target),
        };
        result.entry(from).or_default().push((edge.id, to));
    }
    for edges in result.values_mut() {
        edges.sort_unstable();
    }
    result
}

fn reconstruct(
    source: NodeId,
    mut target: NodeId,
    previous: &BTreeMap<NodeId, (NodeId, EdgeId)>,
    truncated: bool,
) -> TraversalResult {
    let mut nodes = vec![target];
    let mut edges = Vec::new();
    while target != source {
        let (parent, edge) = previous[&target];
        edges.push(edge);
        nodes.push(parent);
        target = parent;
    }
    nodes.reverse();
    edges.reverse();
    TraversalResult {
        edges,
        nodes,
        truncated,
    }
}
