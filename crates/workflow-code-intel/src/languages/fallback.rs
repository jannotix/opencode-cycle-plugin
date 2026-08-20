use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FallbackExtraction {
    pub content_sha256: String,
    pub matched_lines: Vec<u32>,
    pub semantic: bool,
    pub source_path: String,
}

#[must_use]
pub fn extract(source_path: &str, source: &[u8], query: Option<&str>) -> FallbackExtraction {
    let matched_lines = query
        .filter(|query| !query.is_empty())
        .zip(std::str::from_utf8(source).ok())
        .map(|(query, source)| {
            source
                .lines()
                .enumerate()
                .filter(|(_, text)| text.contains(query))
                .map(|(line, _)| u32::try_from(line).unwrap_or(u32::MAX))
                .collect()
        })
        .unwrap_or_default();
    FallbackExtraction {
        content_sha256: digest(source),
        matched_lines,
        semantic: false,
        source_path: source_path.to_owned(),
    }
}

fn digest(source: &[u8]) -> String {
    Sha256::digest(source)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_is_explicitly_non_semantic_and_bounded_to_matching_lines() {
        let result = extract("src/example.xyz", b"alpha\nbeta\nalpha\n", Some("alpha"));

        assert!(!result.semantic);
        assert_eq!(result.matched_lines, vec![0, 2]);
        assert_eq!(result.content_sha256.len(), 64);
    }
}
