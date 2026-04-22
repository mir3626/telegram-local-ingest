import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  checkTelegramLocalBotApi,
  resolveTelegramFileLocation,
  TelegramApiError,
  TelegramBotApiClient,
  type FetchLike,
} from "@telegram-local-ingest/telegram";

test("loadConfig validates required Telegram and vault settings", () => {
  assert.throws(
    () => loadConfig({}),
    (error) =>
      error instanceof ConfigError &&
      error.issues.includes("TELEGRAM_BOT_TOKEN is required") &&
      error.issues.includes("OBSIDIAN_VAULT_PATH is required"),
  );
});

test("loadConfig applies local Bot API defaults and parses allowlist", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    OBSIDIAN_VAULT_PATH: "C:/vault",
    TELEGRAM_ALLOWED_USER_IDS: "42, 99",
    TELEGRAM_POLL_TIMEOUT_SECONDS: "25",
  });

  assert.equal(config.telegram.botApiBaseUrl, "http://127.0.0.1:8081");
  assert.deepEqual(config.telegram.allowedUserIds, ["42", "99"]);
  assert.equal(config.telegram.pollTimeoutSeconds, 25);
  assert.equal(config.runtime.maxFileSizeBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(config.vault.rawRoot, "raw");
});

test("loadNearestEnvFile searches parent directories without overwriting env", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-ingest-env-"));
  const nested = path.join(root, "apps", "worker");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), "TELEGRAM_BOT_TOKEN=from-file\nEXISTING=from-file\nQUOTED=\"hello world\"\n", "utf8");
  const env: NodeJS.ProcessEnv = { EXISTING: "from-env" };

  const loadedPath = loadNearestEnvFile(nested, env);

  assert.equal(loadedPath, path.join(root, ".env"));
  assert.equal(env.TELEGRAM_BOT_TOKEN, "from-file");
  assert.equal(env.EXISTING, "from-env");
  assert.equal(env.QUOTED, "hello world");
});

test("TelegramBotApiClient calls local Bot API endpoints", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    calls.push(input);
    const method = input.split("/").at(-1);
    if (method === "getMe") {
      return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Ingest", username: "ingest_bot" } });
    }
    if (method === "getWebhookInfo") {
      return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
    }
    return jsonResponse({ ok: false, description: "unexpected method", error_code: 400 }, 400);
  };

  const client = new TelegramBotApiClient({ botToken: "123:abc", baseUrl: "http://127.0.0.1:8081/" }, fetchImpl);

  assert.equal((await client.getMe()).username, "ingest_bot");
  assert.equal((await client.getWebhookInfo()).pending_update_count, 0);
  assert.deepEqual(calls, [
    "http://127.0.0.1:8081/bot123:abc/getMe",
    "http://127.0.0.1:8081/bot123:abc/getWebhookInfo",
  ]);
});

test("getFile preserves absolute Local Bot API file paths", async () => {
  const absolutePath = process.platform === "win32" ? "C:\\telegram-bot-api\\files\\big.zip" : "/var/lib/telegram-bot-api/files/big.zip";
  const client = new TelegramBotApiClient(
    { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081" },
    async () =>
      jsonResponse({
        ok: true,
        result: {
          file_id: "file-1",
          file_unique_id: "uniq-1",
          file_size: 1024,
          file_path: absolutePath,
        },
      }),
  );

  const file = await client.getFile("file-1");
  const location = resolveTelegramFileLocation(file, client.config);

  assert.equal(location.kind, "local-path");
  assert.equal(location.path, path.normalize(absolutePath));
});

test("relative file paths resolve under localFilesRoot and reject traversal", () => {
  const config = {
    botToken: "123:abc",
    baseUrl: "http://127.0.0.1:8081",
    localFilesRoot: path.join(process.cwd(), "telegram-files"),
  };

  const safe = resolveTelegramFileLocation({ fileId: "safe", filePath: "documents/a.pdf" }, config);
  assert.equal(safe.kind, "local-path");
  assert.equal(safe.path, path.resolve(config.localFilesRoot, "documents/a.pdf"));

  assert.throws(
    () => resolveTelegramFileLocation({ fileId: "bad", filePath: "../secret.txt" }, config),
    TelegramApiError,
  );
});

test("absolute file paths are constrained when localFilesRoot is configured", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-outside-"));
  const insidePath = path.join(root, "documents", "safe.pdf");
  const outsidePath = path.join(outside, "secret.pdf");
  const config = {
    botToken: "123:abc",
    baseUrl: "http://127.0.0.1:8081",
    localFilesRoot: root,
  };

  const inside = resolveTelegramFileLocation({ fileId: "safe", filePath: insidePath }, config);
  assert.equal(inside.kind, "local-path");
  assert.equal(inside.path, path.resolve(insidePath));
  assert.throws(
    () => resolveTelegramFileLocation({ fileId: "bad", filePath: outsidePath }, config),
    TelegramApiError,
  );
});

test("health check warns when configured for cloud Bot API", async () => {
  const client = new TelegramBotApiClient(
    { botToken: "123:abc", baseUrl: "https://api.telegram.org" },
    async (input) => {
      const method = input.split("/").at(-1);
      if (method === "getMe") {
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: "Ingest" } });
      }
      return jsonResponse({ ok: true, result: { url: "", pending_update_count: 0 } });
    },
  );

  const report = await checkTelegramLocalBotApi(client);

  assert.equal(report.ok, false);
  assert.equal(report.localBaseUrlLikely, false);
  assert.match(report.issues.join("\n"), /Telegram Local Bot API Server/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
