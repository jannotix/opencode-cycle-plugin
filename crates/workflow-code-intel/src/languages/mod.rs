mod adapter;
mod c_family;
mod csharp;
mod dart;
mod data;
mod ecmascript;
pub mod fallback;
mod go;
mod jvm;
mod php;
mod python;
mod ruby;
mod rust;
mod shell;
mod sql;
mod swift;
mod web;

pub use adapter::{AdapterCapabilities, Extraction, LanguageAdapter, LanguageId, extract};

use std::path::Path;

#[must_use]
pub fn adapter_for(path: &Path) -> Option<LanguageAdapter> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "ts" | "js" | "mjs" | "cjs" => Some(ecmascript::typescript()),
        "tsx" | "jsx" => Some(ecmascript::tsx()),
        "py" | "pyi" => Some(python::adapter()),
        "rs" => Some(rust::adapter()),
        "go" => Some(go::adapter()),
        "java" => Some(jvm::java()),
        "kt" | "kts" => Some(jvm::kotlin()),
        "cs" => Some(csharp::adapter()),
        "c" | "h" => Some(c_family::c()),
        "cc" | "cpp" | "cxx" | "hh" | "hpp" | "hxx" => Some(c_family::cpp()),
        "php" => Some(php::adapter()),
        "rb" => Some(ruby::adapter()),
        "swift" => Some(swift::adapter()),
        "dart" => Some(dart::adapter()),
        "sql" => Some(sql::adapter()),
        "html" | "htm" => Some(web::html()),
        "css" => Some(web::css()),
        "sh" | "bash" => Some(shell::bash()),
        "ps1" | "psm1" | "psd1" => Some(shell::powershell()),
        "json" => Some(data::json()),
        "yaml" | "yml" => Some(data::yaml()),
        "toml" => Some(data::toml()),
        "xml" => Some(data::xml()),
        _ => None,
    }
}

#[must_use]
pub fn certified_languages() -> Vec<LanguageId> {
    vec![
        LanguageId::TypeScript,
        LanguageId::Tsx,
        LanguageId::Python,
        LanguageId::Rust,
        LanguageId::Go,
        LanguageId::Java,
        LanguageId::Kotlin,
        LanguageId::CSharp,
        LanguageId::C,
        LanguageId::Cpp,
        LanguageId::Php,
        LanguageId::Ruby,
        LanguageId::Swift,
        LanguageId::Dart,
        LanguageId::Sql,
        LanguageId::Html,
        LanguageId::Css,
        LanguageId::Bash,
        LanguageId::PowerShell,
        LanguageId::Json,
        LanguageId::Yaml,
        LanguageId::Toml,
        LanguageId::Xml,
    ]
}
