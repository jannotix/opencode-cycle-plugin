use super::{LanguageAdapter, LanguageId, adapter::WEB};

pub fn html() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: WEB,
        call_kinds: &[],
        configuration_kinds: &["attribute"],
        dependency_kinds: &["script_element", "style_element"],
        id: LanguageId::Html,
        inheritance_kinds: &[],
        language: || tree_sitter_html::LANGUAGE.into(),
        route_kinds: &[],
        schema_kinds: &[],
        symbol_kinds: &["element"],
    }
}

pub fn css() -> LanguageAdapter {
    LanguageAdapter {
        capabilities: WEB,
        call_kinds: &[],
        configuration_kinds: &["declaration"],
        dependency_kinds: &["import_statement"],
        id: LanguageId::Css,
        inheritance_kinds: &[],
        language: || tree_sitter_css::LANGUAGE.into(),
        route_kinds: &[],
        schema_kinds: &[],
        symbol_kinds: &["class_selector", "id_selector", "tag_name"],
    }
}
