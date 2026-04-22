---
schemaVersion: 1
mapping:
  ts-vitest: typescript-vitest.md
  ts-playwright: typescript-playwright.md
  py-pytest: python-pytest.md
  py-hypothesis: python-hypothesis.md
  rust-cargo: rust-cargo-test.md
  go-testing: go-testing.md
  canvas-dom: canvas-dom-isolation.md
  shell-bats: shell-bats.md
---

# Test patterns index

Use this file as the machine-readable source of truth for stack-specific test shards.

| slug | shard | when to use |
| --- | --- | --- |
| `ts-vitest` | `typescript-vitest.md` | TypeScript unit and integration tests in Node |
| `ts-playwright` | `typescript-playwright.md` | Browser E2E and locator patterns |
| `py-pytest` | `python-pytest.md` | Python unit tests with fixtures and temp files |
| `py-hypothesis` | `python-hypothesis.md` | Python property tests for pure logic |
| `rust-cargo` | `rust-cargo-test.md` | Rust crate and module tests with `cargo test` |
| `go-testing` | `go-testing.md` | Go table-driven tests with `go test` |
| `canvas-dom` | `canvas-dom-isolation.md` | DOM or canvas code that needs environment isolation |
| `shell-bats` | `shell-bats.md` | Shell script tests with `bats` |
