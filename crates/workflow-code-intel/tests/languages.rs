use std::path::Path;

use workflow_code_intel::{
    graph::{EdgeKind, NodeKind},
    languages::{LanguageId, adapter_for, certified_languages, extract},
};
use workflow_core::ProjectId;

struct Fixture {
    language: LanguageId,
    path: &'static str,
    source: &'static [u8],
}

const FIXTURES: &[Fixture] = &[
    Fixture { language: LanguageId::TypeScript, path: "src/app.ts", source: b"import { value } from './dep';\ninterface Config { ready: boolean }\nclass App extends Base { run() { return value(); } }\nrouter.get('/health', () => value());\n" },
    Fixture { language: LanguageId::Tsx, path: "src/app.tsx", source: b"export function App() { return <main>Ready</main>; }\n" },
    Fixture { language: LanguageId::Python, path: "app.py", source: b"from os import path\nclass App(object):\n    def run(self):\n        return path.exists('.')\n" },
    Fixture { language: LanguageId::Rust, path: "src/lib.rs", source: b"use std::fmt;\nstruct App;\nimpl App { fn run() { println!(\"ready\"); } }\n" },
    Fixture { language: LanguageId::Go, path: "main.go", source: b"package main\nimport \"fmt\"\ntype App struct{}\nfunc main() { fmt.Println(\"ready\") }\n" },
    Fixture { language: LanguageId::Java, path: "App.java", source: b"import java.util.List;\nclass App extends Base { void run() { System.out.println(List.of()); } }\nclass Base {}\n" },
    Fixture { language: LanguageId::Kotlin, path: "App.kt", source: b"fun main(args : Array<String>) {\n  println(\"ready\")\n}\n" },
    Fixture { language: LanguageId::CSharp, path: "App.cs", source: b"using System;\nclass App : Base { void Run() { Console.WriteLine(\"ready\"); } }\nclass Base {}\n" },
    Fixture { language: LanguageId::C, path: "main.c", source: b"#include <stdio.h>\nstruct App { int ready; };\nint main(void) { return puts(\"ready\"); }\n" },
    Fixture { language: LanguageId::Cpp, path: "main.cpp", source: b"#include <iostream>\nclass App { public: void run() { std::cout << \"ready\"; } };\n" },
    Fixture { language: LanguageId::Php, path: "app.php", source: b"<?php\nuse Vendor\\Base;\nclass App extends Base { public function run() { return helper(); } }\n" },
    Fixture { language: LanguageId::Ruby, path: "app.rb", source: b"require 'json'\nclass App < Base\n  def run\n    puts 'ready'\n  end\nend\n" },
    Fixture { language: LanguageId::Swift, path: "App.swift", source: b"import Foundation\nclass App: NSObject { func run() { print(\"ready\") } }\n" },
    Fixture { language: LanguageId::Dart, path: "app.dart", source: b"import 'dart:io';\nclass App { void run() { print(Platform.operatingSystem); } }\n" },
    Fixture { language: LanguageId::Sql, path: "schema.sql", source: b"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\nSELECT count(*) FROM users;\n" },
    Fixture { language: LanguageId::Html, path: "index.html", source: b"<!doctype html><html><body><main id=\"app\">Ready</main></body></html>" },
    Fixture { language: LanguageId::Css, path: "app.css", source: b"@import url('base.css');\n.app { color: green; }\n" },
    Fixture { language: LanguageId::Bash, path: "run.sh", source: b"#!/usr/bin/env bash\nrun() { printf '%s\\n' ready; }\nrun\n" },
    Fixture { language: LanguageId::PowerShell, path: "run.ps1", source: b"function Invoke-Test { Write-Output 'ready' }\nInvoke-Test\n" },
    Fixture { language: LanguageId::Json, path: "config.json", source: br#"{"enabled":true,"limit":5}"# },
    Fixture { language: LanguageId::Yaml, path: "config.yaml", source: b"enabled: true\nlimits:\n  workers: 5\n" },
    Fixture { language: LanguageId::Toml, path: "config.toml", source: b"enabled = true\n[limits]\nworkers = 5\n" },
    Fixture { language: LanguageId::Xml, path: "config.xml", source: b"<?xml version=\"1.0\"?><config enabled=\"true\"><workers>5</workers></config>" },
];

#[test]
fn every_certified_language_parses_a_valid_fixture() {
    assert_eq!(certified_languages().len(), FIXTURES.len());
    for fixture in FIXTURES {
        let adapter = adapter_for(Path::new(fixture.path)).expect("fixture must have an adapter");
        assert_eq!(adapter.id, fixture.language);

        let result = extract(
            &adapter,
            ProjectId::new(),
            "certification",
            fixture.path,
            fixture.source,
        )
        .expect("fixture must parse within limits");

        assert_eq!(result.language, fixture.language);
        assert!(
            !result.has_errors,
            "{} fixture has parse errors",
            fixture.path
        );
        assert!(
            result
                .partition
                .nodes
                .values()
                .any(|node| node.kind == NodeKind::File)
        );
    }
}

#[test]
fn malformed_input_is_reported_without_losing_the_file_fact() {
    for fixture in FIXTURES {
        let adapter = adapter_for(Path::new(fixture.path)).expect("fixture must have an adapter");
        let result = extract(
            &adapter,
            ProjectId::new(),
            "malformed",
            fixture.path,
            b"\0\xff{(",
        )
        .expect("malformed input must remain bounded");

        assert!(
            result
                .partition
                .nodes
                .values()
                .any(|node| node.kind == NodeKind::File)
        );
    }
}

#[test]
fn semantic_adapters_emit_provenance_backed_facts() {
    let fixture = &FIXTURES[0];
    let adapter = adapter_for(Path::new(fixture.path)).unwrap();
    let result = extract(
        &adapter,
        ProjectId::new(),
        "semantic",
        fixture.path,
        fixture.source,
    )
    .unwrap();

    assert!(
        result
            .partition
            .nodes
            .values()
            .any(|node| node.kind == NodeKind::Symbol)
    );
    assert!(
        result
            .partition
            .edges
            .values()
            .any(|edge| edge.kind == EdgeKind::Imports)
    );
    assert!(
        result
            .partition
            .edges
            .values()
            .any(|edge| edge.kind == EdgeKind::Calls)
    );
    assert!(
        result
            .partition
            .edges
            .values()
            .any(|edge| edge.kind == EdgeKind::RoutesTo)
    );
    assert!(
        result
            .partition
            .nodes
            .values()
            .any(|node| node.kind == NodeKind::Schema)
    );
    assert!(
        result
            .partition
            .edges
            .values()
            .all(|edge| edge.range.is_some())
    );
}

#[test]
fn unsupported_extensions_do_not_claim_semantic_support() {
    assert!(adapter_for(Path::new("asset.unknown")).is_none());
}
