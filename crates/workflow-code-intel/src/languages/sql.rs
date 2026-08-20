use super::{LanguageAdapter, LanguageId, adapter::SQL};

pub fn adapter() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: SQL,
        call_kinds: &["invocation"],
        configuration_kinds: &[],
        dependency_kinds: &["relation", "table_reference"],
        id: LanguageId::Sql,
        inheritance_kinds: &[],
        language: || tree_sitter_sequel::LANGUAGE.into(),
        route_kinds: &[],
        schema_kinds: &[
            "alter_table",
            "alter_view",
            "create_materialized_view",
            "create_table",
            "create_view",
        ],
        symbol_kinds: &["create_function", "function_declaration"],
    }
}
