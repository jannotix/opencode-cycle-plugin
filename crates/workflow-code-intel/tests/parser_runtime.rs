use std::{sync::atomic::Ordering, time::Duration};

use workflow_code_intel::parser::{ParseError, ParseLimits, ParserRuntime};

fn runtime(max_bytes: usize) -> ParserRuntime {
    ParserRuntime::new(ParseLimits {
        max_bytes,
        max_duration: Duration::from_secs(1),
    })
}

#[test]
fn parser_handles_valid_partial_and_erroneous_sources() {
    let language = tree_sitter_json::LANGUAGE.into();
    let valid = runtime(1024)
        .parse(&language, br#"{"value": 1}"#, None)
        .unwrap();
    assert!(!valid.has_error);
    assert!(valid.node_count >= 5);
    let erroneous = runtime(1024)
        .parse(&language, br#"{"value": }"#, None)
        .unwrap();
    assert!(erroneous.has_error);
    assert!(erroneous.node_count > 1);
}

#[test]
fn file_limit_and_cancellation_fail_explicitly() {
    let language = tree_sitter_json::LANGUAGE.into();
    assert!(matches!(
        runtime(2).parse(&language, b"{}\n", None),
        Err(ParseError::FileTooLarge)
    ));
    let runtime = runtime(1024);
    runtime.cancellation_handle().store(true, Ordering::Release);
    assert!(matches!(
        runtime.parse(&language, b"{}", None),
        Err(ParseError::Cancelled)
    ));
}

#[test]
fn concurrent_parsers_use_independent_trees() {
    let handles: Vec<_> = (0..16)
        .map(|index| {
            std::thread::spawn(move || {
                let language = tree_sitter_json::LANGUAGE.into();
                runtime(1024)
                    .parse(
                        &language,
                        format!(r#"{{"value": {index}}}"#).as_bytes(),
                        None,
                    )
                    .unwrap()
                    .tree
                    .root_node()
                    .to_sexp()
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.len(), 16);
    assert!(results.iter().all(|result| result.starts_with("(document")));
}
