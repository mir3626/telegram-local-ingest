# TypeScript debt grep

Use this shard to find TypeScript debt markers before they become normal.

## Commands

```bash
rg -n --glob '!dist/**' --glob '!node_modules/**' '\b(any|as any)\b|@ts-ignore|@ts-nocheck' src test
rg -n --glob '!dist/**' --glob '!node_modules/**' 'eslint-disable(?!-next-line -- justified:)' src test
```

## Why this is debt

- `any` and `as any` erase the type contract at the exact boundary strict mode is meant to protect.
- `@ts-ignore` and `@ts-nocheck` often hide real regressions that should be expressed as a narrow type guard.
- Bare `eslint-disable` comments spread silently because reviewers stop noticing them.

## Allowed exceptions

- `// @ts-expect-error -- justified: <reason>` in a test that documents an intentional failing type surface.
- A generated file excluded by glob, as long as the generator source is checked elsewhere.
- A one-line compatibility shim that cannot be typed without a broken upstream definition, with a linked tracking issue.

## Determinism notes

- Keep the glob exclusions explicit so scans do not report vendored or generated artifacts.
- Run the grep in CI and fail on new hits rather than manually triaging a large backlog every sprint.

## Review tips

- Look at each hit in diff context, not in isolation.
- Prefer replacing a suppression with a type guard or a narrower interface.
- If a suppression must stay, attach an owner and a removal condition.
