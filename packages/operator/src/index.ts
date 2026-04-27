import type { DatabaseSync } from "node:sqlite";

import {
  getJob,
  listJobEvents,
  listJobOutputs,
  listJobs,
  requestRetry,
  transitionJob,
  type StoredJob,
  type StoredJobFile,
  type StoredJobOutput,
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

export function buildStartResponse(message: ParsedTelegramMessage, allowed: boolean): string {
  return [
    "[안내] 🤖 Telegram Local Ingest Bot",
    "",
    "🔐 이 봇은 인증된 사용자만이 사용가능합니다.",
    `🆔 사용자 ID: ${message.userId ?? "확인 불가"}`,
    `인증 상태: ${allowed ? "✅ 인증됨" : "❌ 미인증"}`,
    allowed
      ? "📎 파일을 업로드하면 자동으로 ingest 작업을 생성합니다."
      : "📝 관리자에게 위 사용자 ID를 전달해 화이트리스트 등록을 요청하세요.",
    allowed ? "" : undefined,
    allowed ? "[사용 가능 명령어]" : undefined,
    allowed ? "📋 /status - 최근 작업 목록과 처리 상태를 확인합니다." : undefined,
    allowed ? "🔎 /status <job_id> - 특정 작업의 상세 상태와 결과 파일을 확인합니다." : undefined,
    allowed ? "🔁 /retry <job_id> - 실패한 작업을 다시 처리합니다." : undefined,
    allowed ? "🛑 /cancel <job_id> - 진행 중인 작업을 취소합니다." : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function handleOperatorCommand(db: DatabaseSync, message: ParsedTelegramMessage, now?: string): OperatorCommandResult {
  const command = getMessageCommand(message);
  if (!command || command.name === "ingest" || command.name === "unknown") {
    return { handled: false, chatId: message.chatId };
  }

  if (command.name === "start") {
    return {
      handled: true,
      chatId: message.chatId,
      text: buildStartResponse(message, true),
    };
  }

  if (command.name === "status") {
    return {
      handled: true,
      chatId: message.chatId,
      text: buildStatusResponse(db, command.targetJobId, message, now),
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

export function buildStatusResponse(
  db: DatabaseSync,
  targetJobId: string | undefined,
  requester?: ParsedTelegramMessage,
  now = new Date().toISOString(),
): string {
  if (targetJobId) {
    const job = assertJobVisibleToMessage(db, targetJobId, requester);
    const events = listJobEvents(db, job.id).slice(-5);
    const outputs = listJobOutputs(db, job.id);
    return [
      `📌 작업 ${job.id}`,
      `상태: ${job.status}`,
      `프로젝트: ${job.project ?? "-"}`,
      `태그: ${job.tags.length > 0 ? job.tags.join(", ") : "-"}`,
      `업데이트: ${job.updatedAt}`,
      job.error ? `오류: ${job.error}` : undefined,
      outputs.length > 0 ? "결과 파일:" : undefined,
      ...formatOutputStatusLines(outputs, now),
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
    ...jobs.map((job) => `${job.id} ${job.status} ${job.project ?? "-"}${formatOutputSummary(listJobOutputs(db, job.id), now)}`),
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

function formatOutputStatusLines(outputs: StoredJobOutput[], now: string): string[] {
  return outputs.map((output) => {
    const status = outputDisplayStatus(output, now);
    return `- ${output.fileName} [${status}] 만료: ${output.expiresAt}`;
  });
}

function formatOutputSummary(outputs: StoredJobOutput[], now: string): string {
  if (outputs.length === 0) {
    return "";
  }
  const counts = countOutputStatuses(outputs, now);
  const parts = [
    counts.active > 0 ? `다운로드 가능 ${counts.active}` : undefined,
    counts.expired > 0 ? `만료 ${counts.expired}` : undefined,
    counts.deleted > 0 ? `폐기 ${counts.deleted}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? ` | 결과: ${parts.join(", ")}` : "";
}

function countOutputStatuses(outputs: StoredJobOutput[], now: string): { active: number; expired: number; deleted: number } {
  const counts = { active: 0, expired: 0, deleted: 0 };
  for (const output of outputs) {
    if (output.deletedAt) {
      counts.deleted += 1;
    } else if (output.expiresAt <= now) {
      counts.expired += 1;
    } else {
      counts.active += 1;
    }
  }
  return counts;
}

function outputDisplayStatus(output: StoredJobOutput, now: string): string {
  if (output.deletedAt) {
    return "폐기됨";
  }
  if (output.expiresAt <= now) {
    return "만료됨";
  }
  return "다운로드 가능";
}
