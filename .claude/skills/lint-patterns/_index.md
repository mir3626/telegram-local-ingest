---
schemaVersion: 1
mapping:
  ts: typescript-debt.md
  py: python-debt.md
  rust: rust-debt.md
  go: go-debt.md
  universal: universal-debt.md
---

# Lint patterns index

Use this file as the machine-readable source of truth for language-specific debt scans.

| slug | shard | when to use |
| --- | --- | --- |
| `ts` | `typescript-debt.md` | TypeScript debt and unsafe suppression scans |
| `py` | `python-debt.md` | Python debt and blanket exception scans |
| `rust` | `rust-debt.md` | Rust debt and `unwrap` hot spot scans |
| `go` | `go-debt.md` | Go debt and ignored error scans |
| `universal` | `universal-debt.md` | Shared TODO/FIXME/XXX scans across stacks |
