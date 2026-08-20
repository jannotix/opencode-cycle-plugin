use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call_expression"],
        configuration_kinds: &["attribute"],
        dependency_kinds: &["import_declaration"],
        id: LanguageId::Swift,
        inheritance_kinds: &["inheritance_specifier"],
        language: || tree_sitter_swift::LANGUAGE.into(),
        route_kinds: &["attribute"],
        schema_kinds: &[
            "class_declaration",
            "enum_declaration",
            "struct_declaration",
        ],
        symbol_kinds: &[
            "class_declaration",
            "function_declaration",
            "protocol_declaration",
            "struct_declaration",
        ],
    }
}
