# Python + Hypothesis

Use this shard for pure logic where edge cases matter more than a few hand-written examples.

## Install and config

```bash
python -m pip install hypothesis pytest
```

```py
# tests/test_normalize_slug.py
from hypothesis import given, strategies as st

def normalize_slug(text: str) -> str:
    return "-".join(part for part in text.strip().lower().split() if part)

@given(st.text())
def test_normalize_slug_has_no_whitespace(raw: str) -> None:
    normalized = normalize_slug(raw)
    assert " " not in normalized

@given(st.lists(st.text(min_size=1), min_size=1, max_size=5))
def test_normalize_slug_preserves_token_order(parts: list[str]) -> None:
    raw = "   ".join(parts)
    normalized = normalize_slug(raw)
    assert normalized.split("-") == [part.strip().lower() for part in parts]
```

## Example strategy notes

- Start with `st.text()`, `st.integers()`, and `st.lists()` before building custom strategies.
- Add explicit bounds for size and domain when the function has practical limits.
- Keep the property focused on invariants, not on one exact output string for every input.

## Common pitfalls

- Do not mix hidden I/O or network calls into a property test.
- Shrinking is only useful when the assertion is simple enough to explain the failure.
- If a bug only appears under one locale or timezone, inject that state directly instead of hoping the generator finds it.

## Determinism notes

- Property tests must be free of wall-clock and random side effects.
- If examples are expensive, cap input sizes aggressively so the suite stays fast.
- Use regular pytest unit tests next to Hypothesis when a business rule is easier to understand from a concrete example.
