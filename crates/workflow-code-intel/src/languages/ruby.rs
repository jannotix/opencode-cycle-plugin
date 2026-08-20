use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call"],
        configuration_kinds: &["pair"],
        dependency_kinds: &["call"],
        id: LanguageId::Ruby,
        inheritance_kinds: &["superclass"],
        language: || tree_sitter_ruby::LANGUAGE.into(),
        route_kinds: &["call"],
        schema_kinds: &["class"],
        symbol_kinds: &["class", "method", "module", "singleton_method"],
    }
}
