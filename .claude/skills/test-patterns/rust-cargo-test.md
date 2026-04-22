# Rust + cargo test

Use this shard for crate-local logic where compile-time types and narrow unit tests should do most of the work.

## Install and config

```bash
cargo test
```

```toml
# Cargo.toml
[package]
name = "example"
edition = "2024"
```

## Example

```rust
// src/lib.rs
pub fn normalize_port(raw: &str) -> Option<u16> {
    raw.trim().parse::<u16>().ok()
}

#[cfg(test)]
mod tests {
    use super::normalize_port;

    #[test]
    fn parses_valid_ports() {
        assert_eq!(normalize_port("8080"), Some(8080));
    }

    #[test]
    fn rejects_invalid_ports() {
        assert_eq!(normalize_port("nope"), None);
    }
}
```

## Common pitfalls

- Keep unit tests next to the module when they only need private helpers.
- Reach for integration tests in `tests/` only when the public API boundary is the point of the check.
- Prefer `assert_eq!` and explicit values over debug-printing and manual inspection.

## Determinism notes

- Avoid reading environment state directly in the function under test; pass configuration in.
- Use `cargo test normalize_port` to iterate on one focused case before running the whole crate.
- If ordering matters, sort collections before asserting formatted output.
