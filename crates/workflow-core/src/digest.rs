use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ContentDigest([u8; 32]);

impl ContentDigest {
    #[must_use]
    pub fn of(content: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(content);
        Self(hasher.finalize().into())
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl fmt::Display for ContentDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DigestParseError;

impl fmt::Display for DigestParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("expected a 64-character lowercase hexadecimal SHA-256 digest")
    }
}

impl std::error::Error for DigestParseError {}

impl FromStr for ContentDigest {
    type Err = DigestParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 64
            || value
                .bytes()
                .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
        {
            return Err(DigestParseError);
        }
        let mut bytes = [0_u8; 32];
        for (index, output) in bytes.iter_mut().enumerate() {
            let offset = index * 2;
            *output =
                u8::from_str_radix(&value[offset..offset + 2], 16).map_err(|_| DigestParseError)?;
        }
        Ok(Self(bytes))
    }
}

impl Serialize for ContentDigest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for ContentDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(de::Error::custom)
    }
}

#[cfg(feature = "schema")]
impl schemars::JsonSchema for ContentDigest {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("ContentDigest")
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-f]{64}$"
        })
    }
}

pub(crate) struct CanonicalHasher(Sha256);

impl CanonicalHasher {
    pub(crate) fn new(domain: &str) -> Self {
        let mut value = Self(Sha256::new());
        value.write_str(domain);
        value
    }

    pub(crate) fn write_bytes(&mut self, value: &[u8]) {
        let length = u64::try_from(value.len()).expect("supported lengths fit in u64");
        self.0.update(length.to_be_bytes());
        self.0.update(value);
    }

    pub(crate) fn write_str(&mut self, value: &str) {
        self.write_bytes(value.as_bytes());
    }

    pub(crate) fn write_optional_str(&mut self, value: Option<&str>) {
        match value {
            Some(value) => {
                self.write_bool(true);
                self.write_str(value);
            }
            None => self.write_bool(false),
        }
    }

    pub(crate) fn write_digest(&mut self, value: ContentDigest) {
        self.write_bytes(value.as_bytes());
    }

    pub(crate) fn write_bool(&mut self, value: bool) {
        self.0.update([u8::from(value)]);
    }

    pub(crate) fn write_u64(&mut self, value: u64) {
        self.0.update(value.to_be_bytes());
    }

    pub(crate) fn finish(self) -> ContentDigest {
        ContentDigest(self.0.finalize().into())
    }
}
