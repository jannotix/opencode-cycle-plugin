use std::path::PathBuf;

use notify::{
    Event, EventKind,
    event::{ModifyKind, RemoveKind},
};
use workflow_code_intel::{ChangeAccumulator, CoalescedChange};

#[test]
fn event_storms_coalesce_to_the_final_state() {
    let path = PathBuf::from("src/lib.rs");
    let mut accumulator = ChangeAccumulator::default();
    for _ in 0..10_000 {
        accumulator.push(&Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path.clone()));
    }
    accumulator.push(&Event::new(EventKind::Remove(RemoveKind::Any)).add_path(path.clone()));
    assert_eq!(
        accumulator.drain(),
        [(path, CoalescedChange::Remove)].into()
    );
}

#[test]
fn ambiguous_watcher_event_requests_explicit_rescan() {
    let mut accumulator = ChangeAccumulator::default();
    accumulator.push(&Event::new(EventKind::Any));
    assert_eq!(
        accumulator.drain(),
        [(PathBuf::new(), CoalescedChange::Rescan)].into()
    );
}
