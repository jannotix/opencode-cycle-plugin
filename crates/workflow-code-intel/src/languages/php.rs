use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &[
            "function_call_expression",
            "member_call_expression",
            "object_creation_expression",
        ],
        configuration_kinds: &["attribute"],
        dependency_kinds: &["namespace_use_declaration", "require_expression"],
        id: LanguageId::Php,
        inheritance_kinds: &["base_clause", "class_interface_clause"],
        language: || tree_sitter_php::LANGUAGE_PHP.into(),
        route_kinds: &["attribute"],
        schema_kinds: &["class_declaration", "enum_declaration"],
        symbol_kinds: &[
            "class_declaration",
            "function_definition",
            "interface_declaration",
            "method_declaration",
            "trait_declaration",
        ],
    }
}
