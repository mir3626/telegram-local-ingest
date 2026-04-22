import assert from "node:assert/strict";
import test from "node:test";

import {
  createJob,
  getJob,
  migrate,
  openIngestDatabase,
  transitionJob,
} from "@telegram-local-ingest/db";
import {
  buildDailyFailedJobsReport,
  buildJobCompletionMessage,
  buildJobFailureMessage,
  buildStatusResponse,
  handleOperatorCommand,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
import { TelegramBotApiClient, type FetchLike, type ParsedTelegramMessage } from "@telegram-local-ingest/telegram";

const NOW = "2026-04-22T12:00:00.000Z";

test("buildStatusResponse lists recent jobs and details one job", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-1");
    transitionJob(handle.db, "job-1", "IMPORTING", { now: NOW });

    assert.match(buildStatusResponse(handle.db, undefined, message("/status")), /최근 작업:\njob-1 IMPORTING sales/);
    const detail = buildStatusResponse(handle.db, "job-1", message("/status job-1"));
    assert.match(detail, /작업 job-1/);
    assert.match(detail, /최근 이벤트:/);
  } finally {
    handle.close();
  }
});

test("handleOperatorCommand retries failed jobs back to QUEUED", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-2");
    transitionJob(handle.db, "job-2", "IMPORTING", { now: NOW });
    transitionJob(handle.db, "job-2", "FAILED", { now: NOW, error: "adapter failed" });

    const result = handleOperatorCommand(handle.db, message("/retry job-2"), NOW);

    assert.equal(result.handled, true);
    assert.equal(result.text, "🔁 재시도 대기열에 넣었어요: job-2");
    assert.equal(getJob(handle.db, "job-2")?.status, "QUEUED");
    assert.equal(getJob(handle.db, "job-2")?.retryCount, 1);
  } finally {
    handle.close();
  }
});

test("handleOperatorCommand cancels active jobs and enforces chat ownership", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-3");
    transitionJob(handle.db, "job-3", "IMPORTING", { now: NOW });

    assert.throws(() => handleOperatorCommand(handle.db, { ...message("/cancel job-3"), chatId: "999" }, NOW), /볼 수 없습니다/);
    const result = handleOperatorCommand(handle.db, message("/cancel job-3"), NOW);

    assert.equal(result.text, "🛑 취소했어요: job-3");
    assert.equal(getJob(handle.db, "job-3")?.status, "CANCELLED");
  } finally {
    handle.close();
  }
});

test("sendOperatorCommandResponse sends Telegram messages for handled commands", async () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-4");
    const sent: unknown[] = [];
    const client = new TelegramBotApiClient({ botToken: "123:abc", baseUrl: "http://127.0.0.1:8081" }, mockFetch(sent));

    const result = await sendOperatorCommandResponse(handle.db, client, message("/status job-4"), NOW);

    assert.equal(result.handled, true);
    assert.deepEqual(sent[0], { chat_id: "300", text: result.text });
  } finally {
    handle.close();
  }
});

test("completion, failure, and daily failed report messages are concise", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-5");
    transitionJob(handle.db, "job-5", "IMPORTING", { now: NOW });
    const failed = transitionJob(handle.db, "job-5", "FAILED", { now: NOW, error: "boom" });

    assert.equal(buildJobCompletionMessage({ ...failed, status: "COMPLETED" }), "✅ 처리 완료: job-5 (sales)");
    assert.equal(
      buildJobCompletionMessage({ ...failed, status: "COMPLETED" }, [{
        id: "file-1",
        jobId: "job-5",
        originalName: "lead.pdf",
        createdAt: NOW,
      }]),
      "✅ 처리 완료: job-5 (sales)\n- lead.pdf",
    );
    assert.equal(buildJobFailureMessage(failed), "⚠️ 처리 실패: job-5\nboom");
    assert.match(buildDailyFailedJobsReport(handle.db, "2026-04-22"), /2026-04-22 실패 작업: 1/);
  } finally {
    handle.close();
  }
});

function createTelegramJob(db: Parameters<typeof createJob>[0], id: string): void {
  createJob(db, {
    id,
    source: "telegram-local-bot-api",
    chatId: "300",
    userId: "400",
    command: "/ingest project:sales tag:lead",
    project: "sales",
    tags: ["lead"],
    now: NOW,
  });
  transitionJob(db, id, "QUEUED", { now: NOW });
}

function message(text: string): ParsedTelegramMessage {
  return {
    updateId: 1,
    messageId: 2,
    chatId: "300",
    userId: "400",
    date: 1,
    text,
    files: [],
  };
}

function mockFetch(sent: unknown[]): FetchLike {
  return async (_input, init) => {
    sent.push(init?.body ? JSON.parse(String(init.body)) : {});
    return new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 10,
        date: 1,
        chat: { id: 300, type: "private" },
        text: "sent",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
