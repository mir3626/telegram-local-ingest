# Rust debt grep

Use this shard to find panic-oriented shortcuts in production Rust code.

## Commands

```bash
rg -n --glob '!target/**' '\.(unwrap|expect)\(' src tests
rg -n --glob '!target/**' '\b(TODO|FIXME)\b|dbg!\(' src tests
```

## Why this is debt

- `unwrap()` and `expect()` are often acceptable in tests but risky in runtime paths with real input.
- `dbg!` is useful during development, but leaving it in production code changes stderr behavior.
- TODO markers around error handling usually mean the crate has an incomplete failure story.

## Allowed exceptions

- Test code under `#[cfg(test)]` where `unwrap()` keeps the assertion readable.
- Build scripts or throwaway migration helpers that are intentionally fail-fast and documented as such.
- `expect()` with a stable invariant in startup-only code, if the message explains the invariant precisely.

## Determinism notes

- Separate `src` and `tests` review so test-only `unwrap()` does not hide production hits.
- If a panic is intentional, document why the invariant is unrecoverable rather than normalizing the pattern.

## Review tips

- Favor `Result` propagation in runtime paths.
- Replace `dbg!` with an assertion or structured tracing before commit.
- Keep the panic boundary close to process startup, not deep inside library code.
