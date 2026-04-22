# QA Policy

## Default Verification Order

1. Focused unit tests for the touched package.
2. `npm run typecheck`.
3. `npm test`.
4. `npm run build`.
5. Targeted smoke check for worker startup or processor behavior.

## Required Smoke Checks By Area

- Telegram package: mocked `getUpdates` and `getFile` responses, including absolute local `file_path`.
- Worker startup: missing env values fail clearly before polling starts.
- File import: path traversal rejection, hash stability, duplicate detection.
- RTZR package: submit/poll lifecycle with mocked HTTP responses and 429/backoff handling.
- Vault package: raw bundle directory layout, manifest/source generation, immutable write guard.
- Wiki adapter: command receives only prepared source package and allowed wiki root.

## External-Service Testing

Do not require live Telegram, RTZR, or Obsidian for unit tests. Live smoke tests must be opt-in and must skip clearly when required env values are missing.

## Completion Rule

No Sprint is complete until the implementation has at least one automated verification path and a short note of any untested external behavior.
