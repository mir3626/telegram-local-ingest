import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AppConfig } from "@telegram-local-ingest/core";
import {
  createJob,
  getJob,
  getTelegramOffset,
  listJobEvents,
  migrate,
  mustGetSourceBundleForJob,
  openIngestDatabase,
  transitionJob,
} from "@telegram-local-ingest/db";
import type { RtzrTranscribeConfig, RtzrTranscript, WaitForTranscriptionOptions } from "@telegram-local-ingest/rtzr";
import type { SenseVoiceTranscribeOptions, SenseVoiceTranscript } from "@telegram-local-ingest/sensevoice";
import { TelegramBotApiClient, type FetchLike } from "@telegram-local-ingest/telegram";

import {
  pollTelegramUpdatesOnce,
  runWorkerOnce,
  type RtzrTranscriber,
  type SenseVoiceTranscriber,
  type WorkerContext,
} from "../apps/worker/src/index.js";

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
      "📥 접수했어요: tg_300_21\n- lead.txt",
      "✅ 처리 완료: tg_300_21 (sales)\n- lead.txt",
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

test("runWorkerOnce asks for RTZR preset on audio uploads and queues after callback", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
    };

    const first = await runWorkerOnce(context);

    assert.equal(first.jobsCreated, 1);
    assert.equal(first.jobsProcessed, 0);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "RECEIVED");
    assert.match(sentMessages[0]?.text ?? "", /🎧 음성 파일 업로드/);
    assert.match(JSON.stringify(sentMessages[0]?.reply_markup), /회의/);
    assert.match(JSON.stringify(sentMessages[0]?.reply_markup), /stt:meeting/);

    const second = await runWorkerOnce(context);

    assert.equal(second.operatorCommandsHandled, 1);
    assert.equal(second.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "audio", "call.m4a")), false);
    assert.ok(answeredCallbacks.length > 0);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "stt.preset_selected"));
    assert.ok(
      fs.readFileSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "manifest.yaml"), "utf8")
        .includes("default_relation: \"business\""),
    );
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce transcribes audio with the selected RTZR preset and bundles artifacts", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  const rtzrCalls: Array<{ filePath: string; config: RtzrTranscribeConfig; waitOptions: WaitForTranscriptionOptions }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
      rtzr: mockRtzrTranscriber(rtzrCalls),
    };

    await runWorkerOnce(context);
    await runWorkerOnce(context);

    const manifest = fs.readFileSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "manifest.yaml"), "utf8");
    assert.equal(rtzrCalls.length, 1);
    assert.equal(rtzrCalls[0]?.config.domain, "GENERAL");
    assert.equal(rtzrCalls[0]?.config.use_diarization, true);
    assert.equal(rtzrCalls[0]?.waitOptions.pollIntervalMs, 5000);
    assert.match(manifest, /call\.rtzr\.json/);
    assert.match(manifest, /call\.transcript\.md/);
    assert.match(fs.readFileSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "extracted", "call.transcript.md"), "utf8"), /회의 내용입니다/);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "rtzr.transcribed"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce transcribes audio with SenseVoice on demand and bundles artifacts", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  const senseVoiceCalls: Array<{ filePath: string; options: SenseVoiceTranscribeOptions }> = [];
  try {
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.stt.provider = "sensevoice";
    config.sensevoice.pythonPath = ".venv-sensevoice/bin/python";
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
      sensevoice: mockSenseVoiceTranscriber(senseVoiceCalls),
    };

    await runWorkerOnce(context);
    await runWorkerOnce(context);

    const manifest = fs.readFileSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "manifest.yaml"), "utf8");
    assert.equal(senseVoiceCalls.length, 1);
    assert.equal(senseVoiceCalls[0]?.options.device, "cpu");
    assert.equal(senseVoiceCalls[0]?.options.language, "auto");
    assert.match(manifest, /provider: "sensevoice"/);
    assert.match(manifest, /call\.sensevoice\.json/);
    assert.match(manifest, /call\.transcript\.md/);
    assert.match(fs.readFileSync(path.join(fixture.vaultPath, "raw", "2026-04-22", "tg_300_21", "extracted", "call.transcript.md"), "utf8"), /센스보이스 전사입니다/);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "sensevoice.transcribed"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce sends a retry button when processing fails", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.stt.provider = "sensevoice";
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
      sensevoice: mockFailingSenseVoiceTranscriber("sensevoice failed"),
    };

    await runWorkerOnce(context);
    await assert.rejects(() => runWorkerOnce(context), /sensevoice failed/);

    const failureMessage = sentMessages.at(-1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "FAILED");
    assert.match(failureMessage?.text ?? "", /⚠️ 처리 실패: tg_300_21\nsensevoice failed/);
    assert.match(JSON.stringify(failureMessage?.reply_markup), /retry:tg_300_21/);
    assert.match(JSON.stringify(failureMessage?.reply_markup), /다시 처리/);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce retries a failed job from a retry button", async () => {
  const fixture = createFixture();
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-retry",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    transitionJob(dbHandle.db, "job-retry", "QUEUED", { now: "2026-04-22T12:00:01.000Z" });
    transitionJob(dbHandle.db, "job-retry", "IMPORTING", { now: "2026-04-22T12:00:02.000Z" });
    transitionJob(dbHandle.db, "job-retry", "FAILED", { now: "2026-04-22T12:00:03.000Z", error: "boom" });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockRetryCallbackFetch(sentMessages, answeredCallbacks),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(result.jobsCreated, 0);
    assert.equal(getJob(dbHandle.db, "job-retry")?.status, "QUEUED");
    assert.equal(getJob(dbHandle.db, "job-retry")?.retryCount, 1);
    assert.match(JSON.stringify(answeredCallbacks[0]), /재시도 대기열/);
    assert.equal(sentMessages.at(-1)?.text, "🔁 재시도 대기열에 넣었어요: job-retry");
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
    assert.deepEqual(sentMessages.map((message) => message.text), ["📭 작업이 없습니다."]);
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
    stt: {
      provider: "rtzr",
    },
    rtzr: {
      apiBaseUrl: "https://openapi.vito.ai",
      ffmpegPath: "ffmpeg",
      pollIntervalMs: 5000,
      timeoutMs: 30 * 60 * 1000,
      rateLimitBackoffMs: 30_000,
    },
    sensevoice: {
      pythonPath: "python3",
      scriptPath: "./scripts/sensevoice-transcribe.py",
      model: "iic/SenseVoiceSmall",
      vadModel: "fsmn-vad",
      device: "cpu",
      language: "auto",
      useItn: true,
      batchSizeSeconds: 60,
      mergeVad: true,
      mergeLengthSeconds: 15,
      maxSingleSegmentTimeMs: 30_000,
      timeoutMs: 60 * 60 * 1000,
    },
    wiki: {},
    translation: {
      defaultRelation: "business",
    },
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

function mockAudioPresetFetch(
  sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }>,
  answeredCallbacks: unknown[],
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      const offset = (body as { offset?: number }).offset;
      if (offset === undefined) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 11,
            message: {
              message_id: 21,
              date: 1_777_000_001,
              chat: { id: 300, type: "private" },
              from: { id: 400, is_bot: false, first_name: "Tony" },
              audio: {
                file_id: "audio-file",
                file_unique_id: "audio-unique",
                file_name: "call.m4a",
                mime_type: "audio/mp4",
                file_size: 10,
              },
            },
          }],
        });
      }
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 12,
          callback_query: {
            id: "callback-1",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 22,
              date: 1_777_000_002,
              chat: { id: 300, type: "private" },
              text: "preset",
            },
            data: "rtzr:meeting:tg_300_21",
          },
        }],
      });
    }
    if (method === "getFile") {
      return jsonResponse({
        ok: true,
        result: {
          file_id: "audio-file",
          file_unique_id: "audio-unique",
          file_size: 10,
          file_path: "audio/call.m4a",
        },
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string; reply_markup?: unknown });
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
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockRetryCallbackFetch(
  sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }>,
  answeredCallbacks: unknown[],
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 31,
          callback_query: {
            id: "retry-callback-1",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 32,
              date: 1_777_000_003,
              chat: { id: 300, type: "private" },
              text: "failed",
            },
            data: "retry:job-retry",
          },
        }],
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string; reply_markup?: unknown });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 100,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockSenseVoiceTranscriber(
  calls: Array<{ filePath: string; options: SenseVoiceTranscribeOptions }>,
): SenseVoiceTranscriber {
  return {
    async transcribeFile(filePath, options): Promise<SenseVoiceTranscript> {
      calls.push({ filePath, options });
      return {
        id: "sensevoice-1",
        text: "센스보이스 전사입니다",
        segments: [{ text: "센스보이스 전사입니다", language: "ko" }],
        raw: {
          id: "sensevoice-1",
          provider: "sensevoice",
          text: "센스보이스 전사입니다",
          segments: [{ text: "센스보이스 전사입니다", language: "ko" }],
        },
      };
    },
  };
}

function mockFailingSenseVoiceTranscriber(message: string): SenseVoiceTranscriber {
  return {
    async transcribeFile(): Promise<SenseVoiceTranscript> {
      throw new Error(message);
    },
  };
}

function mockRtzrTranscriber(
  calls: Array<{ filePath: string; config: RtzrTranscribeConfig; waitOptions: WaitForTranscriptionOptions }>,
): RtzrTranscriber {
  return {
    async transcribeFile(filePath, config, waitOptions): Promise<RtzrTranscript> {
      calls.push({ filePath, config, waitOptions });
      return {
        id: "rtzr-1",
        text: "회의 내용입니다",
        raw: {
          id: "rtzr-1",
          status: "completed",
          results: {
            utterances: [{ start_at: 0, duration: 1000, msg: "회의 내용입니다", spk: 0, lang: "ko" }],
          },
        },
      };
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
