# Go debt grep

Use this shard to find ignored errors and placeholder work in Go packages.

## Commands

```bash
rg -n --glob '!vendor/**' --glob '!bin/**' '\bTODO\b|panic\(' .
rg -n --glob '!vendor/**' --glob '!bin/**' 'if err != nil \{\s*\}|_ = err|fmt\.Print' .
```

## Why this is debt

- Empty `if err != nil {}` blocks and `_ = err` silently discard the only failure signal Go gives you.
- Unexplained `panic()` calls are a strong smell outside tests and startup invariants.
- Stray `fmt.Print*` lines usually bypass the package logger and complicate CLI assertions.

## Allowed exceptions

- `panic()` in impossible-default branches that protect exhaustive enum-like switches.
- `_ = err` only when an interface requires a best-effort cleanup and the code comments why the failure is safe to ignore.
- `fmt.Print*` in user-facing commands where stdout is the intended output channel.

## Determinism notes

- Keep vendor and build output excluded so the scan stays actionable.
- Prefer `go test` plus this grep together: the grep catches swallowed errors that still let the suite pass.

## Review tips

- Ask what should happen when the ignored error is real.
- Prefer returning wrapped errors over printing and continuing silently.
- Keep panic usage explicit and rare in non-test packages.
