pub(crate) fn is_safe_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

pub(crate) fn overlaps(first: &str, second: &str) -> bool {
    first == second
        || first
            .strip_prefix(second)
            .is_some_and(|suffix| suffix.starts_with('/'))
        || second
            .strip_prefix(first)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
