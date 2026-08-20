use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call_expression"],
        configuration_kinds: &["composite_literal"],
        dependency_kinds: &["import_declaration", "import_spec"],
        id: LanguageId::Go,
        inheritance_kinds: &["interface_type"],
        language: || tree_sitter_go::LANGUAGE.into(),
        route_kinds: &["call_expression"],
        schema_kinds: &["struct_type"],
        symbol_kinds: &[
            "function_declaration",
            "method_declaration",
            "type_declaration",
        ],
    }
}
