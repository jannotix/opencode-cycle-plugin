use super::{LanguageAdapter, LanguageId, adapter::SHELL};

pub fn bash() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: SHELL,
        call_kinds: &["command", "command_substitution"],
        configuration_kinds: &["variable_assignment"],
        dependency_kinds: &["command"],
        id: LanguageId::Bash,
        inheritance_kinds: &[],
        language: || tree_sitter_bash::LANGUAGE.into(),
        route_kinds: &[],
        schema_kinds: &[],
        symbol_kinds: &["function_definition"],
    }
}

pub fn powershell() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: SHELL,
        call_kinds: &["command", "invokation_expression"],
        configuration_kinds: &["assignment_expression", "hash_entry"],
        dependency_kinds: &["using_statement"],
        id: LanguageId::PowerShell,
        inheritance_kinds: &[],
        language: || tree_sitter_powershell::LANGUAGE.into(),
        route_kinds: &[],
        schema_kinds: &[],
        symbol_kinds: &["class_statement", "function_statement"],
    }
}
