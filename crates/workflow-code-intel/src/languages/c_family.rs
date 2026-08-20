use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn c() -> LanguageAdapter {
    adapter(LanguageId::C, || tree_sitter_c::LANGUAGE.into())
}

pub fn cpp() -> LanguageAdapter {
    adapter(LanguageId::Cpp, || tree_sitter_cpp::LANGUAGE.into())
}

fn adapter(id: LanguageId, language: fn() -> tree_sitter::Language) -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call_expression"],
        configuration_kinds: &["preproc_def", "preproc_function_def"],
        dependency_kinds: &["preproc_include"],
        id,
        inheritance_kinds: &["base_class_clause"],
        language,
        route_kinds: &[],
        schema_kinds: &["enum_specifier", "struct_specifier"],
        symbol_kinds: &[
            "class_specifier",
            "enum_specifier",
            "function_definition",
            "struct_specifier",
        ],
    }
}
