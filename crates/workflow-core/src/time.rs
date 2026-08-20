use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct WorkflowTimestamp(OffsetDateTime);

impl WorkflowTimestamp {
    #[must_use]
    pub fn now() -> Self {
        Self(OffsetDateTime::now_utc())
    }

    pub fn parse(value: &str) -> Result<Self, time::error::Parse> {
        OffsetDateTime::parse(value, &Rfc3339).map(|value| Self(value.to_offset(UtcOffset::UTC)))
    }

    pub fn from_unix_timestamp_nanos(timestamp: i128) -> Result<Self, time::error::ComponentRange> {
        OffsetDateTime::from_unix_timestamp_nanos(timestamp).map(Self)
    }

    #[must_use]
    pub const fn unix_timestamp_nanos(self) -> i128 {
        self.0.unix_timestamp_nanos()
    }
}

impl fmt::Display for WorkflowTimestamp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0.format(&Rfc3339).map_err(|_| fmt::Error)?)
    }
}

impl Serialize for WorkflowTimestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0.format(&Rfc3339).map_err(serde::ser::Error::custom)?)
    }
}

impl<'de> Deserialize<'de> for WorkflowTimestamp {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = <&str>::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for WorkflowTimestamp {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("WorkflowTimestamp")
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "format": "date-time"
        })
    }
}
