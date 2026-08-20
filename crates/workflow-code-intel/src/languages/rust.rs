use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call_expression", "macro_invocation"],
        configuration_kinds: &["attribute_item"],
        dependency_kinds: &["extern_crate_declaration", "use_declaration"],
        id: LanguageId::Rust,
        inheritance_kinds: &["impl_item", "trait_bounds"],
        language: || tree_sitter_rust::LANGUAGE.into(),
        route_kinds: &["attribute_item"],
        schema_kinds: &["enum_item", "struct_item"],
        symbol_kinds: &[
            "enum_item",
            "function_item",
            "mod_item",
            "struct_item",
            "trait_item",
        ],
    }
}
