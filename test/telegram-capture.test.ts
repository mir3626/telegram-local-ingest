import assert from "node:assert/strict";
import test from "node:test";

import { captureTelegramUpdates, pollAndCaptureTelegramUpdates } from "@telegram-local-ingest/capture";
import { getJob, getTelegramOffset, listJobEvents, listJobFiles, migrate, openIngestDatabase } from "@telegram-local-ingest/db";
import {
  getMessageCommand,
  isTelegramUserAllowed,
  parseTelegramCommand,
  parseTelegramUpdate,
  TelegramBotApiClient,
  type FetchLike,
  type TelegramUpdate,
} from "@telegram-local-ingest/telegram";

const NOW = "2026-04-22T09:00:00.000Z";

test("parseTelegramUpdate extracts text, caption, user, and largest photo", () => {
  const parsed = parseTelegramUpdate({
    update_id: 10,
    message: {
      message_id: 20,
      date: 1_777_000_000,
      chat: { id: 300, type: "private" },
      from: { id: 400, is_bot: false, first_name: "Tony" },
      caption: "/ingest project:wechat tag:lead summarize",
      photo: [
        { file_id: "small", file_unique_id: "small-u", width: 90, height: 90 },
        { file_id: "large", file_unique_id: "large-u", width: 1280, height: 720, file_size: 2048 },
      ],
    },
  });

  assert.equal(parsed?.updateId, 10);
  assert.equal(parsed?.messageId, 20);
  assert.equal(parsed?.chatId, "300");
  assert.equal(parsed?.userId, "400");
  assert.equal(parsed?.files.length, 1);
  assert.equal(parsed?.files[0]?.kind, "photo");
  assert.equal(parsed?.files[0]?.fileId, "large");
  assert.equal(getMessageCommand(parsed!)?.project, "wechat");
});

test("parseTelegramCommand supports ingest metadata and control command targets", () => {
  const ingest = parseTelegramCommand("/ingest@my_bot project:alpha tag:x tags:y,z keep Korean text");
  assert.equal(ingest?.name, "ingest");
  assert.equal(ingest?.project, "alpha");
  assert.deepEqual(ingest?.tags, ["x", "y", "z"]);
  assert.equal(ingest?.instructions, "keep Korean text");

  const retry = parseTelegramCommand("/retry job-123");
  assert.equal(retry?.name, "retry");
  assert.equal(retry?.targetJobId, "job-123");

  const unknown = parseTelegramCommand("/dance now");
  assert.equal(unknown?.name, "unknown");
});

test("isTelegramUserAllowed denies empty allowlists and missing users", () => {
  assert.equal(isTelegramUserAllowed("1", []), false);
  assert.equal(isTelegramUserAllowed(undefined, ["1"]), false);
  assert.equal(isTelegramUserAllowed("2", ["1"]), false);
  assert.equal(isTelegramUserAllowed("1", ["1"]), true);
});

test("captureTelegramUpdates creates queued ingest jobs and stores offsets", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);

    const result = captureTelegramUpdates(handle.db, [documentUpdate()], {
      botKey: "bot-main",
      allowedUserIds: ["400"],
      pollTimeoutSeconds: 0,
      now: NOW,
    });

    assert.deepEqual(result, {
      updatesSeen: 1,
      jobsCreated: 1,
      ignored: 0,
      unauthorized: 0,
      lastUpdateId: 11,
    });
    assert.equal(getTelegramOffset(handle.db, "bot-main"), 11);

    const job = getJob(handle.db, "tg_300_21");
    assert.equal(job?.status, "QUEUED");
    assert.equal(job?.project, "sales");
    assert.deepEqual(job?.tags, ["lead"]);
    assert.equal(job?.instructions, "please OCR");

    const files = listJobFiles(handle.db, "tg_300_21");
    assert.equal(files.length, 1);
    assert.equal(files[0]?.sourceFileId, "doc-file");
    assert.equal(files[0]?.originalName, "lead.pdf");
    assert.equal(files[0]?.mimeType, "application/pdf");

    assert.deepEqual(
      listJobEvents(handle.db, "tg_300_21").map((event) => event.type),
      ["job.created", "file.added", "job.transition"],
    );
  } finally {
    handle.close();
  }
});

test("captureTelegramUpdates advances offsets for unauthorized and unsupported updates", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);

    const result = captureTelegramUpdates(
      handle.db,
      [
        { update_id: 12 },
        {
          update_id: 13,
          message: {
            message_id: 22,
            date: 1,
            chat: { id: 300, type: "private" },
            from: { id: 999, is_bot: false, first_name: "Other" },
            text: "/ingest project:x",
          },
        },
      ],
      {
        botKey: "bot-main",
        allowedUserIds: ["400"],
        pollTimeoutSeconds: 0,
        now: NOW,
      },
    );

    assert.equal(result.ignored, 1);
    assert.equal(result.unauthorized, 1);
    assert.equal(result.jobsCreated, 0);
    assert.equal(getTelegramOffset(handle.db, "bot-main"), 13);
  } finally {
    handle.close();
  }
});

test("pollAndCaptureTelegramUpdates resumes from the durable Telegram offset", async () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    const requestedBodies: unknown[] = [];
    const client = new TelegramBotApiClient({ botToken: "123:abc", baseUrl: "http://127.0.0.1:8081" }, mockFetch((method, body) => {
      requestedBodies.push(body);
      if (method === "getUpdates") {
        const request = body as { offset?: number };
        return { ok: true, result: request.offset === undefined ? [documentUpdate()] : [] };
      }
      return { ok: true, result: true };
    }));

    await pollAndCaptureTelegramUpdates(handle.db, client, {
      botKey: "bot-main",
      allowedUserIds: ["400"],
      pollTimeoutSeconds: 10,
      now: NOW,
    });
    assert.equal(getTelegramOffset(handle.db, "bot-main"), 11);

    await pollAndCaptureTelegramUpdates(handle.db, client, {
      botKey: "bot-main",
      allowedUserIds: ["400"],
      pollTimeoutSeconds: 10,
      now: NOW,
    });

    assert.deepEqual(requestedBodies[0], { timeout: 10, allowed_updates: ["message"] });
    assert.deepEqual(requestedBodies[1], { timeout: 10, allowed_updates: ["message"], offset: 12 });
  } finally {
    handle.close();
  }
});

function documentUpdate(): TelegramUpdate {
  return {
    update_id: 11,
    message: {
      message_id: 21,
      date: 1_777_000_001,
      chat: { id: 300, type: "private" },
      from: { id: 400, is_bot: false, first_name: "Tony" },
      caption: "/ingest project:sales tag:lead please OCR",
      document: {
        file_id: "doc-file",
        file_unique_id: "doc-unique",
        file_name: "lead.pdf",
        mime_type: "application/pdf",
        file_size: 4096,
      },
    },
  };
}

function mockFetch(handler: (method: string, body: unknown) => unknown): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    assert.ok(method);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return jsonResponse(handler(method, body));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
