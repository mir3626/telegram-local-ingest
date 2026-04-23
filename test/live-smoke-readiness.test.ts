import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkLiveSmokeReadiness,
  renderReadinessReport,
} from "../apps/worker/src/readiness.js";

test("checkLiveSmokeReadiness reports missing .env without printing secrets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-readiness-missing-"));

  const report = await checkLiveSmokeReadiness({
    cwd: root,
    env: {},
    checkTelegram: false,
  });

  assert.equal(report.ready, false);
  assert.equal(report.envPath, null);
  assert.match(renderReadinessReport(report), /missing \.env/);
  assert.doesNotMatch(renderReadinessReport(report), /123:abc/);
});

test("checkLiveSmokeReadiness accepts a complete local smoke setup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-readiness-ready-"));
  const runtime = path.join(root, "runtime");
  const vault = path.join(root, "vault");
  const telegramFiles = path.join(root, "telegram-files");
  fs.mkdirSync(vault);
  fs.mkdirSync(telegramFiles);
  fs.writeFileSync(
    path.join(root, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123:abc",
      "TELEGRAM_ALLOWED_USER_IDS=42",
      "TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081",
      `TELEGRAM_LOCAL_FILES_ROOT=${telegramFiles}`,
      `INGEST_RUNTIME_DIR=${runtime}`,
      `SQLITE_DB_PATH=${path.join(runtime, "ingest.db")}`,
      `OBSIDIAN_VAULT_PATH=${vault}`,
      "OBSIDIAN_RAW_ROOT=raw",
      "",
    ].join("\n"),
    "utf8",
  );

  const report = await checkLiveSmokeReadiness({
    cwd: root,
    env: {},
    fetchImpl: async (input) => {
      const method = input.split("/").at(-1);
      if (method === "getMe") {
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Ingest", username: "ingest_bot" } });
      }
      if (method === "getWebhookInfo") {
        return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
      }
      return jsonResponse({ ok: false, description: "unexpected method", error_code: 400 }, 400);
    },
  });

  assert.equal(report.ready, true);
  assert.equal(report.checks.some((check) => check.name === "Telegram Local Bot API Server" && check.status === "ok"), true);
  assert.match(renderReadinessReport(report), /Live smoke readiness: ready/);
});

test("checkLiveSmokeReadiness blocks cloud Telegram Bot API for live smoke", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-readiness-cloud-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  fs.writeFileSync(
    path.join(root, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123:abc",
      "TELEGRAM_ALLOWED_USER_IDS=42",
      "TELEGRAM_BOT_API_BASE_URL=https://api.telegram.org",
      `OBSIDIAN_VAULT_PATH=${vault}`,
      "",
    ].join("\n"),
    "utf8",
  );

  const report = await checkLiveSmokeReadiness({
    cwd: root,
    env: {},
    fetchImpl: async () =>
      jsonResponse({
        ok: true,
        result: { id: 1, is_bot: true, first_name: "Ingest", username: "ingest_bot", url: "", pending_update_count: 0 },
      }),
  });

  assert.equal(report.ready, false);
  assert.match(renderReadinessReport(report), /use Telegram Local Bot API Server/);
});

test("checkLiveSmokeReadiness checks configured Codex postprocess wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-readiness-agent-"));
  const runtime = path.join(root, "runtime");
  const vault = path.join(root, "vault");
  const telegramFiles = path.join(root, "telegram-files");
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(vault);
  fs.mkdirSync(telegramFiles);
  fs.mkdirSync(scripts);
  const wrapper = path.join(scripts, "run-codex-postprocess.sh");
  fs.writeFileSync(wrapper, "#!/usr/bin/env bash\necho codex wrapper ok\n", "utf8");
  fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(
    path.join(root, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=123:abc",
      "TELEGRAM_ALLOWED_USER_IDS=42",
      "TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081",
      `TELEGRAM_LOCAL_FILES_ROOT=${telegramFiles}`,
      `INGEST_RUNTIME_DIR=${runtime}`,
      `SQLITE_DB_PATH=${path.join(runtime, "ingest.db")}`,
      `OBSIDIAN_VAULT_PATH=${vault}`,
      "OBSIDIAN_RAW_ROOT=raw",
      "AGENT_POSTPROCESS_PROVIDER=codex",
      "AGENT_POSTPROCESS_COMMAND={projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}",
      "",
    ].join("\n"),
    "utf8",
  );

  const report = await checkLiveSmokeReadiness({
    cwd: root,
    env: {},
    checkTelegram: false,
  });

  assert.equal(report.ready, true);
  assert.equal(report.checks.some((check) => check.name === "Codex postprocess wrapper" && check.status === "ok"), true);
  assert.match(renderReadinessReport(report), /codex wrapper ok/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
