# Conventions

## Project Defaults

- Language: TypeScript on Node.js 24+.
- Package manager: npm workspaces, to stay aligned with the `vibe-doctor` harness.
- Runtime style: local long-running worker plus deterministic processors.
- Tests: Node `node:test` for harness and focused app unit tests unless a later Sprint adopts another runner.
- Config: load from environment at process startup and validate before polling.

## Implementation Rules

- Keep LLM-facing boundaries explicit. LLMs may summarize or ingest prepared source packages, but they must not own job state, file import, retry, permission, or notification decisions.
- Use structured parsers for manifests, JSON, Telegram updates, and STT responses.
- Treat every uploaded file as untrusted input.
- Resolve and validate filesystem paths before copy/link/move operations.
- Preserve original bytes in `runtime/archive/originals` and in raw bundle `original/`.
- Store hashes for original and normalized artifacts.
- Use idempotent job steps so `/retry` can resume from the last durable checkpoint.
- Keep user-facing Telegram messages concise and operational: ACK, queued, processing, completed, failed, status.

## Telegram Local Bot API Rules

- `TELEGRAM_BOT_API_BASE_URL` must be configurable and must not be hardcoded to `api.telegram.org`.
- Code must handle local `getFile.file_path` as an absolute path.
- Code must also handle relative `file_path` so tests can simulate cloud-compatible behavior.
- Do not process files directly in the Bot API storage directory. Import to runtime staging first.
- Startup checks should verify the local server, bot token, and local-mode file semantics before entering the polling loop.

## Obsidian Raw Bundle Rules

- `raw/**` is immutable after finalization.
- `manifest.yaml` is the machine-readable source of truth.
- `source.md` is the LLM-readable ingest entrypoint.
- Derived text goes under `extracted/`.
- Converted media or normalized documents go under `normalized/`.
- Original files stay under `original/`.
- `log.md` records processing events and non-fatal warnings.

## Cross-Platform Rules

- Prefer Node filesystem APIs over shell commands in app code.
- When spawning commands such as ffmpeg or wiki ingest adapter, use `child_process.spawn` with Windows-safe command handling.
- Always write text files as UTF-8.
- Do not assume POSIX paths; normalize for display but keep filesystem calls platform-native.

## Documentation Rules

- Update `docs/context/*` when a durable architecture decision changes.
- Update `docs/plans/sprint-roadmap.md` before starting implementation work.
- Keep sensitive examples out of docs. Use placeholder env names only.
