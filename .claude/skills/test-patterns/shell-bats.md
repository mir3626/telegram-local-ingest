# Shell + bats

Use this shard for Bash-compatible scripts where exit codes and stdout are the primary contract.

## Install and config

```bash
brew install bats-core
# or
npm install -D bats
```

```bash
# test/version.bats
#!/usr/bin/env bats

setup() {
  export REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "version command prints semver" {
  run "$REPO_ROOT/scripts/print-version.sh"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

@test "version command has no stderr noise" {
  run "$REPO_ROOT/scripts/print-version.sh"
  [ -z "$stderr" ]
}
```

## Common pitfalls

- Quote every variable expansion in the script and in the test.
- Assert on exit code and output together; checking only one hides partial failures.
- Keep helper functions in `test_helper.bash` when multiple `.bats` files share setup.

## Determinism notes

- Set `HOME`, `TMPDIR`, and any config paths inside the test so local machines do not leak state.
- Avoid parsing colorized output unless the script is forced into `NO_COLOR=1`.
- Use temporary fixtures instead of reading mutable files from the real repository root.
