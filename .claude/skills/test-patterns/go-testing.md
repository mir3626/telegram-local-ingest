# Go + testing

Use this shard for Go packages that benefit from table-driven tests and explicit error handling.

## Install and config

```bash
go test ./...
```

```go
// normalize.go
package slug

import "strings"

func Normalize(input string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(input)), " ", "-")
}
```

```go
// normalize_test.go
package slug

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "trim and lowercase", input: "  Hello Go  ", want: "hello-go"},
		{name: "single token", input: "CLI", want: "cli"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.input); got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}
```

## Common pitfalls

- Prefer table-driven tests for small pure functions instead of many nearly identical test functions.
- Call `t.Helper()` inside shared assertion helpers so failures point at the spec.
- Keep concurrency explicit; if a case uses goroutines, assert on channels or contexts, not sleeps.

## Determinism notes

- Avoid package globals in tested code unless the test can restore them with `t.Cleanup`.
- Use `t.Setenv` and `t.TempDir` for isolated environment and filesystem state.
- Keep failure messages concrete so flaky behavior is obvious from one test run.
