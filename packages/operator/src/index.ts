import type { DatabaseSync } from "node:sqlite";

import {
  getJob,
  listJobEvents,
  listJobs,
  requestRetry,
  transitionJob,
  type StoredJob,
  type StoredJobFile,
} from "@telegram-local-ingest/db";
import {
  getMessageCommand,
  type ParsedTelegramCommand,
  type ParsedTelegramMessage,
  type TelegramBotApiClient,
} from "@telegram-local-ingest/telegram";

export interface OperatorCommandResult {
  handled: boolean;
  chatId: string;
  text?: string;
  job?: StoredJob;
}

export function handleOperatorCommand(db: DatabaseSync, message: ParsedTelegramMessage, now?: string): OperatorCommandResult {
  const command = getMessageCommand(message);
  if (!command || command.name === "ingest" || command.name === "unknown") {
    return { handled: false, chatId: message.chatId };
  }

  if (command.name === "status") {
    return {
      handled: true,
      chatId: message.chatId,
      text: buildStatusResponse(db, command.targetJobId, message),
    };
  }

  if (command.name === "retry") {
    const jobId = requiredTargetJobId(command);
    const job = assertJobVisibleToMessage(db, jobId, message);
    const retryRequested = requestRetry(db, job.id, {
      message: "Retry requested from Telegram",
      ...(now ? { now } : {}),
    });
    const retried = transitionJob(db, retryRequested.id, "QUEUED", {
      message: "Retry queued from Telegram",
      ...(now ? { now } : {}),
    });
    return {
      handled: true,
      chatId: message.chatId,
      text: `🔁 재시도 대기열에 넣었어요: ${retried.id}`,
      job: retried,
    };
  }

  const jobId = requiredTargetJobId(command);
  const job = assertJobVisibleToMessage(db, jobId, message);
  const cancelled = transitionJob(db, job.id, "CANCELLED", {
    message: "Cancelled from Telegram",
    ...(now ? { now } : {}),
  });
  return {
    handled: true,
    chatId: message.chatId,
    text: `🛑 취소했어요: ${cancelled.id}`,
    job: cancelled,
  };
}

export async function sendOperatorCommandResponse(
  db: DatabaseSync,
  client: TelegramBotApiClient,
  message: ParsedTelegramMessage,
  now?: string,
): Promise<OperatorCommandResult> {
  const result = handleOperatorCommand(db, message, now);
  if (result.handled && result.text) {
    await client.sendMessage(result.chatId, result.text);
  }
  return result;
}

export function buildStatusResponse(db: DatabaseSync, targetJobId: string | undefined, requester?: ParsedTelegramMessage): string {
  if (targetJobId) {
    const job = assertJobVisibleToMessage(db, targetJobId, requester);
    const events = listJobEvents(db, job.id).slice(-5);
    return [
      `📌 작업 ${job.id}`,
      `상태: ${job.status}`,
      `프로젝트: ${job.project ?? "-"}`,
      `태그: ${job.tags.length > 0 ? job.tags.join(", ") : "-"}`,
      `업데이트: ${job.updatedAt}`,
      job.error ? `오류: ${job.error}` : undefined,
      events.length > 0 ? "최근 이벤트:" : undefined,
      ...events.map((event) => `- ${event.createdAt} ${event.type}${event.message ? `: ${event.message}` : ""}`),
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  const jobs = listJobs(db, 5).filter((job) => requester === undefined || jobMatchesRequester(job, requester));
  if (jobs.length === 0) {
    return "📭 작업이 없습니다.";
  }
  return [
    "📋 최근 작업:",
    ...jobs.map((job) => `${job.id} ${job.status} ${job.project ?? "-"}`),
  ].join("\n");
}

export function buildJobCompletionMessage(job: StoredJob, files: StoredJobFile[] = []): string {
  return [
    `✅ 처리 완료: ${job.id}${job.project ? ` (${job.project})` : ""}`,
    ...files.map((file) => `- ${file.originalName ?? file.id}`),
  ].join("\n");
}

export function buildJobFailureMessage(job: StoredJob): string {
  return `⚠️ 처리 실패: ${job.id}${job.error ? `\n${job.error}` : ""}`;
}

export function buildDailyFailedJobsReport(db: DatabaseSync, date: string): string {
  const failed = listJobs(db, 500).filter((job) => job.status === "FAILED" && job.updatedAt.startsWith(date));
  if (failed.length === 0) {
    return `📅 ${date} 실패 작업: 없음`;
  }
  return [
    `📅 ${date} 실패 작업: ${failed.length}`,
    ...failed.map((job) => `- ${job.id} ${job.project ?? "-"} ${job.error ?? ""}`.trimEnd()),
  ].join("\n");
}

function requiredTargetJobId(command: ParsedTelegramCommand): string {
  if (!command.targetJobId) {
    throw new Error(`⚠️ /${command.name} 명령에는 작업 ID가 필요합니다.`);
  }
  return command.targetJobId;
}

function assertJobVisibleToMessage(
  db: DatabaseSync,
  jobId: string,
  requester: ParsedTelegramMessage | undefined,
): StoredJob {
  const job = getJob(db, jobId);
  if (!job) {
    throw new Error(`⚠️ 작업을 찾을 수 없습니다: ${jobId}`);
  }
  if (requester && !jobMatchesRequester(job, requester)) {
    throw new Error(`🔒 이 채팅에서는 해당 작업을 볼 수 없습니다: ${jobId}`);
  }
  return job;
}

function jobMatchesRequester(job: StoredJob, requester: ParsedTelegramMessage): boolean {
  if (job.chatId && job.chatId !== requester.chatId) {
    return false;
  }
  if (job.userId && requester.userId && job.userId !== requester.userId) {
    return false;
  }
  return true;
}
