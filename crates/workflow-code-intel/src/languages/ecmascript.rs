use super::{LanguageAdapter, LanguageId, adapter::FULL};

const SYMBOLS: &[&str] = &[
    "class_declaration",
    "function_declaration",
    "interface_declaration",
    "method_definition",
    "type_alias_declaration",
];
const DEPENDENCIES: &[&str] = &["import_statement", "export_statement"];
const CALLS: &[&str] = &["call_expression", "new_expression"];

pub fn typescript() -> LanguageAdapter {
    adapter(LanguageId::TypeScript, || {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
    })
}

pub fn tsx() -> LanguageAdapter {
    adapter(LanguageId::Tsx, || {
        tree_sitter_typescript::LANGUAGE_TSX.into()
    })
}

fn adapter(id: LanguageId, language: fn() -> tree_sitter::Language) -> LanguageAdapter {
    LanguageAdapter {
        capabilities: FULL,
        call_kinds: CALLS,
        configuration_kinds: &["pair"],
        dependency_kinds: DEPENDENCIES,
        id,
        inheritance_kinds: &["class_heritage"],
        language,
        route_kinds: &["call_expression"],
        schema_kinds: &["interface_declaration", "type_alias_declaration"],
        symbol_kinds: SYMBOLS,
    }
}
