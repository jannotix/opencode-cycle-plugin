use std::{
    ops::ControlFlow,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use tree_sitter::{Language, ParseOptions, ParseState, Parser, Tree};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseLimits {
    pub max_bytes: usize,
    pub max_duration: Duration,
}

pub struct ParserRuntime {
    cancelled: Arc<AtomicBool>,
    limits: ParseLimits,
}

pub struct ParsedTree {
    pub has_error: bool,
    pub node_count: usize,
    pub tree: Tree,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParseError {
    Cancelled,
    Failed,
    FileTooLarge,
    IncompatibleLanguage,
    TimedOut,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Cancelled => "parsing was cancelled",
            Self::Failed => "parser did not produce a syntax tree",
            Self::FileTooLarge => "source exceeds the configured parser limit",
            Self::IncompatibleLanguage => "parser language is incompatible with the runtime",
            Self::TimedOut => "parsing exceeded the configured time limit",
        })
    }
}

impl std::error::Error for ParseError {}

impl ParserRuntime {
    #[must_use]
    pub fn new(limits: ParseLimits) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            limits,
        }
    }

    #[must_use]
    pub fn cancellation_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    pub fn parse(
        &self,
        language: &Language,
        source: &[u8],
        old_tree: Option<&Tree>,
    ) -> Result<ParsedTree, ParseError> {
        if source.len() > self.limits.max_bytes {
            return Err(ParseError::FileTooLarge);
        }
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ParseError::Cancelled);
        }
        let mut parser = Parser::new();
        parser
            .set_language(language)
            .map_err(|_| ParseError::IncompatibleLanguage)?;
        let started = Instant::now();
        let mut stopped_by_cancellation = false;
        let mut stopped_by_timeout = false;
        let mut progress = |_: &ParseState| {
            if self.cancelled.load(Ordering::Acquire) {
                stopped_by_cancellation = true;
                ControlFlow::Break(())
            } else if started.elapsed() > self.limits.max_duration {
                stopped_by_timeout = true;
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let mut callback = |offset: usize, _| source.get(offset..).unwrap_or_default();
        let tree = parser.parse_with_options(
            &mut callback,
            old_tree,
            Some(ParseOptions::new().progress_callback(&mut progress)),
        );
        if stopped_by_cancellation {
            return Err(ParseError::Cancelled);
        }
        if stopped_by_timeout {
            return Err(ParseError::TimedOut);
        }
        let tree = tree.ok_or(ParseError::Failed)?;
        Ok(ParsedTree {
            has_error: tree.root_node().has_error(),
            node_count: count_nodes(&tree),
            tree,
        })
    }
}

fn count_nodes(tree: &Tree) -> usize {
    let mut cursor = tree.walk();
    let mut count = 1;
    loop {
        if cursor.goto_first_child() || cursor.goto_next_sibling() {
            count += 1;
        } else {
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    return count;
                }
            }
            count += 1;
        }
    }
}
