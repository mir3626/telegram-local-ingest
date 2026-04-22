# Universal debt grep

Use this shard in every stack. It catches backlog markers that spread across otherwise clean codebases.

## Commands

```bash
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!target/**' --glob '!vendor/**' '\b(TODO|FIXME|XXX|HACK)\b' .
rg -n --glob '!node_modules/**' --glob '!dist/**' --glob '!target/**' --glob '!vendor/**' 'temporary workaround|remove before release' .
```

## Why this is debt

- These markers tend to outlive the sprint that introduced them.
- They are often the only signal that a workaround, migration shim, or missing validation is still in the tree.
- A shared scan gives Planner and Evaluator one consistent quality gate across languages.

## Allowed exceptions

- Intentional fixture text used to test parsers, if the file path clearly lives under fixtures.
- Documentation that quotes a literal TODO comment from another system.
- A marker with a ticket number and explicit owner when the sprint scope cannot close it.

## Determinism notes

- Keep the ignore list short and visible. Hidden exclusions make the scan meaningless.
- Review new matches in diff context, not only in the aggregate report, so churn stays low.

## Review tips

- Convert vague TODOs into ticket-linked tasks with an owner.
- Delete workaround comments when the workaround is removed in the same change.
- Treat repeated debt markers in one area as a refactor boundary, not isolated noise.
