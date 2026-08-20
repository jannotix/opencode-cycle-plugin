use super::{LanguageAdapter, LanguageId, adapter::FULL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: &["call"],
        configuration_kinds: &["dictionary"],
        dependency_kinds: &["import_from_statement", "import_statement"],
        id: LanguageId::Python,
        inheritance_kinds: &["argument_list"],
        language: || tree_sitter_python::LANGUAGE.into(),
        route_kinds: &["decorator"],
        schema_kinds: &["class_definition"],
        symbol_kinds: &["class_definition", "function_definition"],
    }
}
