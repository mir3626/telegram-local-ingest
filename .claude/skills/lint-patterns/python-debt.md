# Python debt grep

Use this shard to catch Python shortcuts that usually hide control-flow bugs.

## Commands

```bash
rg -n --glob '!venv/**' --glob '!.venv/**' --glob '!dist/**' '\b(TODO|FIXME)\b|except Exception:|except:\s*$|print\(' src tests
rg -n --glob '!venv/**' --glob '!.venv/**' --glob '!dist/**' '# type: ignore(?!\[)' src tests
```

## Why this is debt

- Blanket `except Exception` and bare `except:` clauses suppress real failures and make retries guesswork.
- `print()` debugging in committed code usually bypasses structured logging and test assertions.
- Unqualified `# type: ignore` comments tend to stay forever because they do not name the ignored error class.

## Allowed exceptions

- CLI entry points where `print()` is the user-facing contract.
- `# type: ignore[code]` with a short rationale and an upstream issue link.
- Exception translation layers that catch broad errors and immediately re-raise a typed domain error.

## Determinism notes

- Keep test fixture folders excluded only when they intentionally include malformed samples.
- Prefer scanning `src` and `tests` separately if the repository mixes application and notebook code.

## Review tips

- Ask whether the broad exception can be replaced with a typed domain error.
- Move debug prints into assertions or structured logs before merging.
- Require a concrete mypy code when a `type: ignore` remains.
