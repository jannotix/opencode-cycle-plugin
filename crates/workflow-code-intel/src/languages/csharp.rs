use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["invocation_expression", "object_creation_expression"],
        configuration_kinds: &["attribute"],
        dependency_kinds: &["using_directive"],
        id: LanguageId::CSharp,
        inheritance_kinds: &["base_list"],
        language: || tree_sitter_c_sharp::LANGUAGE.into(),
        route_kinds: &["attribute"],
        schema_kinds: &[
            "class_declaration",
            "record_declaration",
            "struct_declaration",
        ],
        symbol_kinds: &[
            "class_declaration",
            "interface_declaration",
            "method_declaration",
            "record_declaration",
            "struct_declaration",
        ],
    }
}
