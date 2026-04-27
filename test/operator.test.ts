import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobOutput,
  createJob,
  getJob,
  markJobOutputDeleted,
  migrate,
  openIngestDatabase,
  transitionJob,
} from "@telegram-local-ingest/db";
import {
  buildDailyFailedJobsReport,
  buildJobCompletionMessage,
  buildJobFailureMessage,
  buildStartResponse,
  buildStatusResponse,
  handleOperatorCommand,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
import { TelegramBotApiClient, type FetchLike, type ParsedTelegramMessage } from "@telegram-local-ingest/telegram";

const NOW = "2026-04-22T12:00:00.000Z";

test("buildStartResponse shows user id and allowlist guidance", () => {
  const unauthorized = buildStartResponse(message("/start"), false);
  assert.match(unauthorized, /\[안내\]/);
  assert.match(unauthorized, /인증된 사용자만이 사용가능합니다/);
  assert.match(unauthorized, /사용자 ID: 400/);
  assert.match(unauthorized, /인증 상태: ❌ 미인증/);
  assert.match(unauthorized, /화이트리스트 등록/);

  const authorized = buildStartResponse(message("/start"), true);
  assert.match(authorized, /인증 상태: ✅ 인증됨/);
  assert.match(authorized, /\[사용 가능 명령어\]/);
  assert.match(authorized, /📋 \/status - 최근 작업 목록과 처리 상태를 확인합니다/);
  assert.match(authorized, /🔎 \/status <job_id> - 특정 작업의 상세 상태와 결과 파일을 확인합니다/);
  assert.match(authorized, /🔁 \/retry <job_id> - 실패한 작업을 다시 처리합니다/);
  assert.match(authorized, /🛑 \/cancel <job_id> - 진행 중인 작업을 취소합니다/);
});

test("buildStatusResponse lists recent jobs and details one job", () => {
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createTelegramJob(handle.db, "job-1");
    transitionJob(handle.db, "job-1", "IMPORTING", { now: NOW });
    createJobOutput(handle.db, {
      id: "out-active",
      jobId: "job-1",
      kind: "agent_translation",
      filePath: "/tmp/translated.docx",
      fileName: "translated.docx",
      createdAt: "2026-04-22T12:01:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    createJobOutput(handle.db, {
      id: "out-expired",
      jobId: "job-1",
      kind: "agent_translation",
      filePath: "/tmp/old.pdf",
      fileName: "old.pdf",
      createdAt: "2026-04-22T12:02:00.000Z",
      expiresAt: "2026-04-22T11:59:00.000Z",
    });
    createJobOutput(handle.db, {
      id: "out-deleted",
      jobId: "job-1",
      kind: "agent_translation",
      filePath: "/tmp/deleted.md",
      fileName: "deleted.md",
      createdAt: "2026-04-22T12:03:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    markJobOutputDeleted(handle.db, "out-deleted", "2026-04-22T12:04:00.000Z");

    assert.match(
      buildStatusResponse(handle.db, undefined, message("/status"), NOW),
      /job-1 IMPORTING sales \| 결과: 다운로드 가능 1, 만료 1, 폐기 1/,
    );
    const detail = buildStatusResponse(handle.db, "job-1", message("/status job-1"), NOW);
    assert.match(detail, /작업 job-1/);
    assert.match(detail, /결과 파일:/);
    assert.match(detail, /translated\.docx \[다운로드 가능\]/);
    assert.match(detail, /old\.pdf \[만료됨\]/);
    assert.match(detail, /deleted\.md \[폐기됨\]/);
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
