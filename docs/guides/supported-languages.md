# Supported Languages

Cycle for OpenCode v1 provides bounded Tree-sitter parsing for the language families below. Every parser runs with an input-size limit, a deadline and cancellation support. Parse errors remain explicit; the engine never labels a partially parsed file as error-free.

| Family | File extensions | Extracted facts |
| --- | --- | --- |
| TypeScript and JavaScript | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | symbols, imports, calls, inheritance, types, configuration candidates |
| Python | `.py`, `.pyi` | symbols, imports, calls, inheritance, schema and decorator candidates |
| Rust | `.rs` | symbols, modules, calls, trait relations, schemas, attributes |
| Go | `.go` | symbols, imports, calls, interfaces, schemas, composite configuration |
| JVM | `.java`, `.kt`, `.kts` | symbols, imports, calls, inheritance, schemas, annotations |
| .NET | `.cs` | symbols, imports, calls, inheritance, schemas, attributes |
| C and C++ | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hh`, `.hpp`, `.hxx` | symbols, includes, calls, inheritance where applicable, schemas, preprocessor configuration |
| PHP | `.php` | symbols, imports, calls, inheritance, schemas, attributes |
| Ruby | `.rb` | symbols, calls, superclass relations and configuration candidates |
| Swift | `.swift` | symbols, imports, calls, inheritance, schemas, attributes |
| Dart | `.dart` | symbols, imports, calls, inheritance, schemas, metadata |
| SQL | `.sql` | functions, table dependencies, calls and schema definitions |
| Web | `.html`, `.htm`, `.css` | elements, selectors, imports and declarations |
| Shell | `.sh`, `.bash`, `.ps1`, `.psm1`, `.psd1` | functions, commands, imports and assignments |
| Structured data | `.json`, `.yaml`, `.yml`, `.toml`, `.xml` | configuration structure |

Syntax-derived facts carry parser provenance. Relations that cannot be proven from syntax alone are marked as inferred. Language-server facts retain their own provider identity and cannot overwrite parser-extracted facts.

Unsupported file types use an explicit non-semantic fallback. The fallback provides a content digest and optional exact-text line matches only. It does not claim symbol, dependency or call-graph coverage.

Source ranges use zero-based lines and columns, matching Tree-sitter. Graph queries are bounded by node, edge, depth and output budgets. A truncated result is reported as truncated instead of silently presented as complete.
