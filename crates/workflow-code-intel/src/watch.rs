use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::mpsc::{Receiver, TryRecvError, channel},
    time::{Duration, Instant},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoalescedChange {
    CreateOrModify,
    Remove,
    Rescan,
}

#[derive(Default)]
pub struct ChangeAccumulator {
    changes: BTreeMap<PathBuf, CoalescedChange>,
}

impl ChangeAccumulator {
    pub fn push(&mut self, event: &Event) {
        let change = classify(&event.kind);
        if change == CoalescedChange::Rescan || event.need_rescan() {
            self.changes.clear();
            self.changes.insert(PathBuf::new(), CoalescedChange::Rescan);
            return;
        }
        if self.changes.get(Path::new("")) == Some(&CoalescedChange::Rescan) {
            return;
        }
        for path in &event.paths {
            self.changes.insert(path.clone(), change);
        }
    }

    pub fn drain(&mut self) -> BTreeMap<PathBuf, CoalescedChange> {
        std::mem::take(&mut self.changes)
    }
}

#[derive(Debug)]
pub enum WatchError {
    Notify(notify::Error),
    RootNotAbsolute,
}

impl std::fmt::Display for WatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Notify(error) => error.fmt(formatter),
            Self::RootNotAbsolute => formatter.write_str("watch root must be absolute"),
        }
    }
}

impl std::error::Error for WatchError {}

pub struct ProjectWatcher {
    _watcher: RecommendedWatcher,
    receiver: Receiver<notify::Result<Event>>,
    accumulator: ChangeAccumulator,
}

impl ProjectWatcher {
    pub fn collect(
        &mut self,
        window: Duration,
    ) -> Result<BTreeMap<PathBuf, CoalescedChange>, WatchError> {
        let deadline = Instant::now() + window;
        loop {
            match self.receiver.try_recv() {
                Ok(Ok(event)) => self.accumulator.push(&event),
                Ok(Err(error)) => return Err(WatchError::Notify(error)),
                Err(TryRecvError::Empty) if Instant::now() < deadline => std::thread::yield_now(),
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
        Ok(self.accumulator.drain())
    }
}

pub fn watch_project(root: &Path) -> Result<ProjectWatcher, WatchError> {
    if !root.is_absolute() {
        return Err(WatchError::RootNotAbsolute);
    }
    let (sender, receiver) = channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(WatchError::Notify)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(WatchError::Notify)?;
    Ok(ProjectWatcher {
        _watcher: watcher,
        accumulator: ChangeAccumulator::default(),
        receiver,
    })
}

fn classify(kind: &EventKind) -> CoalescedChange {
    match kind {
        EventKind::Create(_) | EventKind::Modify(_) => CoalescedChange::CreateOrModify,
        EventKind::Remove(_) => CoalescedChange::Remove,
        EventKind::Access(_) | EventKind::Other | EventKind::Any => CoalescedChange::Rescan,
    }
}
