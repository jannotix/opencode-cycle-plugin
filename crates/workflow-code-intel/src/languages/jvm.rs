use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn java() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["method_invocation", "object_creation_expression"],
        configuration_kinds: &["annotation"],
        dependency_kinds: &["import_declaration", "package_declaration"],
        id: LanguageId::Java,
        inheritance_kinds: &["superclass", "super_interfaces"],
        language: || tree_sitter_java::LANGUAGE.into(),
        route_kinds: &["annotation"],
        schema_kinds: &[
            "class_declaration",
            "enum_declaration",
            "record_declaration",
        ],
        symbol_kinds: &[
            "class_declaration",
            "constructor_declaration",
            "interface_declaration",
            "method_declaration",
            "record_declaration",
        ],
    }
}

pub fn kotlin() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call_expression"],
        configuration_kinds: &["annotation"],
        dependency_kinds: &["import_header", "package_header"],
        id: LanguageId::Kotlin,
        inheritance_kinds: &["delegation_specifier"],
        language: || tree_sitter_kotlin_ng::LANGUAGE.into(),
        route_kinds: &["annotation"],
        schema_kinds: &["class_declaration", "object_declaration"],
        symbol_kinds: &[
            "class_declaration",
            "function_declaration",
            "object_declaration",
        ],
    }
}
