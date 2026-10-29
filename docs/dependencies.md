# Product dependency verification

Verified 2026-10-28 against the official npm registry. Exact direct versions and transitive integrity hashes are locked in `package-lock.json`.

## Contents

- [Selected packages](#selected-packages)
- [Runtime and dependency boundaries](#runtime-and-dependency-boundaries)
- [Configuration parser](#configuration-parser)
- [Deferred packages](#deferred-packages)

## Selected packages

| Package       | Exact release | Published Node engine           | Purpose / primary source                                                                                                                                    |
| ------------- | ------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript    | 7.0.2         | >=16.20.0                       | Strict typechecking; [registry metadata](https://registry.npmjs.org/typescript/7.0.2)                                                                       |
| Vitest        | 5.0.5         | ^22.12.0 or ^24.0.0 or >=26.0.0 | Product tests; [registry metadata](https://registry.npmjs.org/vitest/5.0.5)                                                                                 |
| @types/node   | 24.19.2       | None declared                   | Node 24 tool/test types; [registry metadata](https://registry.npmjs.org/@types/node/24.19.2)                                                                |
| @babel/parser | 8.0.8         | ^22.18.0 or >=24.11.0           | Parse TS/JS imports for boundary checks; [registry metadata](https://registry.npmjs.org/@babel/parser/8.0.8)                                                |
| @noble/hashes | 2.4.0         | >=20.19.0                       | Portable audited SHA-256; [registry metadata](https://registry.npmjs.org/@noble/hashes/2.4.0), [official source](https://github.com/paulmillr/noble-hashes) |

`npm view` verified current latest releases of TypeScript, Vitest, Babel parser and noble hashes. Node types deliberately follow the pinned Node 24 release line rather than current Node 26 types. Vite 8.3.5 (engine ^20.19.0 or >=22.12.0) is a Vitest transitive dependency, not an application/UI selection. Existing ESLint 10.13.0 and Prettier 3.9.10 remain unchanged. Installation with scripts disabled reported zero vulnerabilities.

## Runtime and dependency boundaries

The existing project pins Node 24.19.0 and npm 11.21.1 with strict engines. These settings are preserved. Local commands use the existing verified Node distribution and exact npm. The shell's default Node 26/npm 12 is not the validation runtime.

Domain code imports only its own portable modules and the two explicit noble SHA-256/byte-format modules. It uses no Node, provider, host or filesystem APIs. A separate domain TypeScript check excludes Node ambient types. The build-only Babel parser runs in the boundary checker; it does not enter the domain dependency graph. Application code may depend on domain, while production imports of tests and outward domain/application imports fail the boundary check.

Canonical JSON sorts object keys by UTF-16 code units, preserves string contents and array order, uses JSON number spelling (including zero for negative zero), rejects non-finite numbers and non-JSON values, and hashes UTF-8 bytes. SHA-256 is checked against Node's independent implementation in tests. Repository identity accepts bounded ASCII DNS/owner/repository spellings and lowercases only those remote coordinates. Unsupported non-ASCII spellings fail without transliteration; display values and local execution paths remain unchanged. IDNA conversion and local path normalization are not performed by this remote-coordinate function.

## Configuration parser

Task 2 verified `yaml` **2.9.1** on 2026-10-29 through the [official registry metadata](https://registry.npmjs.org/yaml/2.9.1) (`npm view yaml version engines dist.integrity --json`). Its declared Node engine is `>=14.6`, compatible with the pinned Node 24.19.0. The exact workspace dependency and integrity are locked; installation used `npm install --ignore-scripts` and reported zero vulnerabilities. Existing dependencies were preserved.

The [official YAML 2 documentation](https://eemeli.org/yaml/) establishes `parseDocument`, strict duplicate-key detection, node type guards, document errors/warnings and schema options. Parsing lives in the local adapter; domain validates the resulting JSON and application resolves provenance without importing the parser. No Ajv dependency is needed for the current small closed envelope; runtime validation reuses the existing execution/resource codecs and validates configuration independently.

The parser accepts one YAML 1.2 core document, at most 256 KiB of UTF-8, 10,000 nodes and depth 32. It rejects aliases entirely before expansion, duplicate keys, merge keys, non-string mapping keys, unknown/custom tags, non-finite numbers and prototype-shaped keys. These are parser safety bounds, not invented retention defaults. Source paths are relative repository file paths with no traversal, absolute paths or backslashes. Source authority/trust is injected metadata, and document attempts to provide it fail `UNTRUSTED_POLICY`. The committed reader requires the injected port's returned revision to equal the pinned revision; runtime's actual ref-to-revision binding remains Task 23's responsibility.

GitHub restrictions in the current `Record<FieldPath, Json>` interface represent exact required values. They constrain managed intent without making omitted fields managed. Trusted organization-enforced intents override advisory/profile recommendations; explicit repository choices conflicting with an enforced intent fail. Equal-rank conflicts fail rather than depending on input order. Component-specific field ownership/semantics belong to Task 3's registry; this envelope rejects unknown structural/intent members and execution preferences without pretending that future component schemas already exist.

## Deferred packages

Ajv, Octokit, React, browser tooling and MCP SDKs are not installed for this slice. Verify their maintained releases, engines and actual supported APIs in the task that first consumes them. No paid API or live repository mutation is used by product tests.
