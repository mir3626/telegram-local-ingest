# Python + pytest

Use this shard for Python modules that need fixture-based tests, temp files, and readable failure output.

## Install and config

```bash
python -m pip install pytest
```

```toml
# pyproject.toml
[tool.pytest.ini_options]
testpaths = ["tests"]
```

## Example

```py
# src/report_writer.py
from pathlib import Path

def write_report(root: Path, name: str, content: str) -> Path:
    target = root / f"{name}.txt"
    target.write_text(content, encoding="utf-8")
    return target
```

```py
# tests/test_report_writer.py
from src.report_writer import write_report

def test_write_report(tmp_path):
    target = write_report(tmp_path, "daily", "ok")
    assert target.read_text(encoding="utf-8") == "ok"
    assert target.name == "daily.txt"

def test_write_report_can_be_redirected(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    target = write_report(tmp_path, "cwd", "here")
    assert target.exists()
```

## Common pitfalls

- Prefer `tmp_path` over manual cleanup of real directories.
- Use `monkeypatch` for environment variables, cwd changes, and module globals instead of ad hoc mutation.
- Keep fixtures narrow. Large autouse fixtures hide important setup and slow the suite.

## Determinism notes

- Read and write text with explicit UTF-8 when the output is asserted.
- Avoid time-dependent file names unless the test injects the timestamp.
- If randomness matters, pass a seeded `random.Random` instance instead of calling module-level randomness.
