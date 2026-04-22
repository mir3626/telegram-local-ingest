import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AppConfig } from "@telegram-local-ingest/core";
import { getJob, getTelegramOffset, listJobEvents, migrate, mustGetSourceBundleForJob, openIngestDatabase } from "@telegram-local-ingest/db";
import { TelegramBotApiClient, type FetchLike } from "@telegram-local-ingest/telegram";

import { runWorkerOnce, type WorkerContext } from "../apps/worker/src/index.js";

test("runWorkerOnce captures, imports, bundles, completes, and notifies", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/lead.txt", "lead content");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.deepEqual(result, {
      updatesSeen: 1,
      operatorCommandsHandled: 0,
      jobsCreated: 1,
      jobsProcessed: 1,
    });
    assert.equal(getTelegramOffset(dbHandle.db, "123:abc"), 11);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "documents", "lead.txt")), false);
    assert.ok(fs.existsSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "manifest.yaml")));
    assert.equal(mustGetSourceBundleForJob(dbHandle.db, "tg_300_21").sourceMarkdownPath.endsWith("source.md"), true);
    assert.deepEqual(sentMessages.map((message) => message.text), [
      "Queued: tg_300_21",
      "Completed: tg_300_21 (sales)",
    ]);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "wiki.skipped"));
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "telegram_source.deleted"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce treats file uploads without captions as ingest jobs", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/upload-only.txt", "upload only");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, undefined, "documents/upload-only.txt"),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsCreated, 1);
    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "documents", "upload-only.txt")), false);
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce handles operator status without creating a job", async () => {
  const fixture = createFixture();
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/status", null),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(result.jobsCreated, 0);
    assert.deepEqual(sentMessages.map((message) => message.text), ["No jobs found."]);
  } finally {
    dbHandle.close();
  }
});

function configFixture(fixture: { runtimeDir: string; vaultPath: string; botRoot: string }): AppConfig {
  return {
    telegram: {
      botToken: "123:abc",
      botApiBaseUrl: "http://127.0.0.1:8081",
      localFilesRoot: fixture.botRoot,
      allowedUserIds: ["400"],
      pollTimeoutSeconds: 1,
    },
    runtime: {
      runtimeDir: fixture.runtimeDir,
      sqliteDbPath: ":memory:",
      wikiWriteLockPath: path.join(fixture.runtimeDir, "wiki.lock"),
      maxFileSizeBytes: 1024,
    },
    vault: {
      obsidianVaultPath: fixture.vaultPath,
      rawRoot: "raw",
    },
    rtzr: {
      apiBaseUrl: "https://openapi.vito.ai",
      ffmpegPath: "ffmpeg",
    },
    wiki: {},
  };
}

function createFixture(): { root: string; botRoot: string; runtimeDir: string; vaultPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-loop-"));
  return {
    root,
    botRoot: path.join(root, "bot-root"),
    runtimeDir: path.join(root, "runtime"),
    vaultPath: path.join(root, "vault"),
  };
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function mockTelegramFetch(
  sentMessages: Array<{ chat_id: string; text: string }>,
  text: string | undefined = "/ingest project:sales tag:lead",
  filePath: string | null = "documents/lead.txt",
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              message_id: 21,
              date: 1_777_000_001,
              chat: { id: 300, type: "private" },
              from: { id: 400, is_bot: false, first_name: "Tony" },
              ...(text !== undefined ? { caption: text } : {}),
              ...(filePath
                ? {
                    document: {
                      file_id: "doc-file",
                      file_unique_id: "doc-unique",
                      file_name: path.basename(filePath),
                      mime_type: "text/plain",
                      file_size: 12,
                    },
                  }
                : {}),
            },
          },
        ],
      });
    }
    if (method === "getFile") {
      return jsonResponse({
        ok: true,
        result: {
          file_id: "doc-file",
          file_unique_id: "doc-unique",
          file_size: 12,
          file_path: filePath ?? "documents/lead.txt",
        },
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
