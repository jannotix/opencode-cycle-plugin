use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum WorkClass {
    RemoteModel(String),
    LocalModel,
    Build,
    Browser,
    Database,
    Indexing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapacityDecision {
    Admitted,
    AtCapacity,
    ProviderBackoff,
    Unconfigured,
}

pub struct CapacityLimiter {
    active: BTreeMap<WorkClass, u16>,
    backoff_until: BTreeMap<String, i64>,
    limits: BTreeMap<WorkClass, u16>,
}

impl CapacityLimiter {
    #[must_use]
    pub fn new(limits: BTreeMap<WorkClass, u16>) -> Self {
        Self {
            active: BTreeMap::new(),
            backoff_until: BTreeMap::new(),
            limits,
        }
    }

    pub fn try_admit(&mut self, class: &WorkClass, now_unix_millis: i64) -> CapacityDecision {
        if let WorkClass::RemoteModel(provider) = class
            && self
                .backoff_until
                .get(provider)
                .is_some_and(|until| *until > now_unix_millis)
        {
            return CapacityDecision::ProviderBackoff;
        }
        let Some(limit) = self.limits.get(class).copied() else {
            return CapacityDecision::Unconfigured;
        };
        let active = self.active.entry(class.clone()).or_default();
        if *active >= limit {
            CapacityDecision::AtCapacity
        } else {
            *active += 1;
            CapacityDecision::Admitted
        }
    }

    pub fn release(&mut self, class: &WorkClass) -> bool {
        let Some(active) = self.active.get_mut(class) else {
            return false;
        };
        if *active == 0 {
            return false;
        }
        *active -= 1;
        true
    }

    pub fn backoff_provider(&mut self, provider: String, until_unix_millis: i64) {
        self.backoff_until.insert(provider, until_unix_millis);
    }
}
