# Automation Context

Product automation modules are one-shot local tasks registered by manifest, not individual npm scripts.

## Module Layout

```text
automations/<module>/
  manifest.json
  run.mjs
  README.md
```

`manifest.json` declares the stable identity, title, entrypoint, default enabled state, required environment variables, capabilities, timeout, retry policy, and future schedule metadata. Adding or removing a module should not require editing `package.json`.

## CLI Boundary

The stable entrypoint is:

```bash
npm run tlgi -- automation list
npm run tlgi -- automation enable <id>
npm run tlgi -- automation disable <id>
npm run tlgi -- automation run <id> [--force]
npm run tlgi -- automation logs [id]
npm run tlgi -- automation dispatch [--dry-run]
npm run tlgi -- automation timer install
npm run ops:dashboard
```

Sprint 17 owns registry discovery, manual runs, durable run logs, and enable/disable state. Sprint 18 adds due-run dispatch and user-level `systemd` timer file installation.

## Storage

Automation state is stored in SQLite tables:

- `automation_modules`: manifest snapshot plus enabled state.
- `automation_runs`: run status, trigger, exit code, and log file paths.
- `automation_events`: structured run events for later dashboard views.
- `automation_schedule_state`: last due key, next due time, failure count, and retry-after metadata for enabled scheduled modules.

Run files live under `runtime/automation/runs/<run_id>/`:

- `stdout.log`
- `stderr.log`
- `result.json`

Secrets remain in `.env` or the host secret store. The registry only records missing/present readiness and must never persist secret values.

## Local Ops Dashboard

`apps/ops-dashboard` is a product-owned dashboard, separate from the `vibe-doctor` harness dashboard. It binds only to localhost by default (`OPS_DASHBOARD_HOST=127.0.0.1`, `OPS_DASHBOARD_PORT=58991`) and reads the same SQLite registry, run log paths, manifests, and automation-core readiness checks as `apps/ops-cli`. `scripts/start-local-stack.sh` starts it together with the Telegram Local Bot API Server and worker; `scripts/stop-local-stack.sh` stops it first.

The dashboard shows module enabled/available state, readiness as present/missing env names only, next due time, recent runs, run result/log text, and links to raw bundle/wiki source paths when a module result records them. It supports enable/disable, manual run, and dispatch actions. If `OPS_DASHBOARD_TOKEN` is set, write actions require `x-ops-dashboard-token`, `Authorization: Bearer ...`, or the local token field in the page; read-only status endpoints remain local GETs, and the token itself is never shown in API state.

## Scheduling Policy

The product should use one host timer to invoke a dispatcher, not one cron entry per automation:

```text
systemd user timer
  -> npm run tlgi -- automation dispatch
    -> enabled due modules run once
    -> process exits
```

This keeps the solution non-resident while still allowing catch-up behavior after the PC was off. The dispatcher idempotency key is the schedule window (`daily:<date>` or `interval:<iso>`), so rerunning dispatch does not duplicate the same scheduled window.

`automation timer install` writes:

- `${XDG_CONFIG_HOME:-~/.config}/systemd/user/telegram-local-ingest-automation.service`
- `${XDG_CONFIG_HOME:-~/.config}/systemd/user/telegram-local-ingest-automation.timer`

The CLI prints the `systemctl --user daemon-reload && systemctl --user enable --now telegram-local-ingest-automation.timer` command instead of running it implicitly.

## FX Module

`automations/fx-koreaexim-daily` is the first real module. It calls Korea Eximbank Open API `AP01`, using `FX_KOREAEXIM_AUTHKEY`, `FX_SEARCH_DATE` or the scheduled date, and `FX_CURRENCIES` as the token-efficiency filter. It writes:

- original API JSON as evidence.
- `rates-<YYYYMMDD>.md` as canonical text.
- `rates-<YYYYMMDD>.csv` as canonical tabular text.

If `WIKI_INGEST_COMMAND` is configured, the module runs the existing wiki ingest adapter after the raw bundle is finalized. If the API returns no selected rows, the module exits successfully with a skipped module result so non-business days do not become failed data.
