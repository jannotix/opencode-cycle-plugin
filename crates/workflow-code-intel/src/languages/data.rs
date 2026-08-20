use super::{LanguageAdapter, LanguageId, adapter::STRUCTURED_DATA};

pub fn json() -> LanguageAdapter {
    adapter(
        LanguageId::Json,
        || tree_sitter_json::LANGUAGE.into(),
        &["pair"],
    )
}

pub fn yaml() -> LanguageAdapter {
    adapter(
        LanguageId::Yaml,
        || tree_sitter_yaml::LANGUAGE.into(),
        &["block_mapping_pair", "flow_pair"],
    )
}

pub fn toml() -> LanguageAdapter {
    adapter(
        LanguageId::Toml,
        || tree_sitter_toml_ng::LANGUAGE.into(),
        &["pair", "table", "table_array_element"],
    )
}

pub fn xml() -> LanguageAdapter {
    adapter(
        LanguageId::Xml,
        || tree_sitter_xml::LANGUAGE_XML.into(),
        &["attribute", "element"],
    )
}

fn adapter(
    id: LanguageId,
    language: fn() -> tree_sitter::Language,
    configuration_kinds: &'static [&'static str],
) -> LanguageAdapter {
    LanguageAdapter {
        capabilities: STRUCTURED_DATA,
        call_kinds: &[],
        configuration_kinds,
        dependency_kinds: &[],
        id,
        inheritance_kinds: &[],
        language,
        route_kinds: &[],
        schema_kinds: &[],
        symbol_kinds: &[],
    }
}
