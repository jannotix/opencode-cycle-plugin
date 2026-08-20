use std::path::Path;

use workflow_core::{CandidateFileKind, CandidateManifest};
use workflow_ledger::Redactor;

pub fn scan(
    repository: &Path,
    manifest: &CandidateManifest,
    exact_diff: &[u8],
) -> Result<(), String> {
    let redactor = Redactor::default();
    if sensitive(&redactor, &String::from_utf8_lossy(exact_diff)) {
        return Err("credential-like content was detected in the exact candidate diff".to_owned());
    }
    for file in manifest
        .files()
        .iter()
        .filter(|file| file.kind != CandidateFileKind::Deleted)
    {
        let path = repository.join(&file.path);
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > 16 * 1024 * 1024 {
            continue;
        }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        if sensitive(&redactor, &String::from_utf8_lossy(&bytes)) {
            return Err(format!(
                "credential-like content was detected in {}",
                file.path
            ));
        }
    }
    Ok(())
}

fn sensitive(redactor: &Redactor, value: &str) -> bool {
    redactor.contains_sensitive(value)
        || value.lines().any(|line| {
            let lower = line.to_ascii_lowercase();
            ["api_key", "apikey", "password", "secret", "token"]
                .iter()
                .any(|name| assignment(&lower, name))
        })
}

fn assignment(line: &str, name: &str) -> bool {
    let Some(index) = line.find(name) else {
        return false;
    };
    let suffix = line[index + name.len()..].trim_start();
    let Some(value) = suffix
        .strip_prefix('=')
        .or_else(|| suffix.strip_prefix(':'))
    else {
        return false;
    };
    let value = value.trim().trim_matches(['\'', '"']);
    value.len() >= 8
        && !["changeme", "example", "placeholder", "redacted"]
            .iter()
            .any(|placeholder| value.contains(placeholder))
}
