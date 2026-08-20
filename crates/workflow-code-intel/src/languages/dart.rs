use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["selector", "unconditional_assignable_selector"],
        configuration_kinds: &["metadata"],
        dependency_kinds: &[
            "export_specification",
            "import_specification",
            "part_directive",
        ],
        id: LanguageId::Dart,
        inheritance_kinds: &["interfaces", "mixins", "superclass"],
        language: || tree_sitter_dart::LANGUAGE.into(),
        route_kinds: &["metadata"],
        schema_kinds: &["class_definition", "enum_declaration"],
        symbol_kinds: &["class_definition", "function_signature", "method_signature"],
    }
}
