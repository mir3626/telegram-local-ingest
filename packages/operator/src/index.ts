import type { DatabaseSync } from "node:sqlite";

import {
  getJob,
  listJobEvents,
  listJobs,
  requestRetry,
  transitionJob,
  type StoredJob,
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
      text: `Retry queued: ${retried.id}`,
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
    text: `Cancelled: ${cancelled.id}`,
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
      `Job ${job.id}`,
      `Status: ${job.status}`,
      `Project: ${job.project ?? "-"}`,
      `Tags: ${job.tags.length > 0 ? job.tags.join(", ") : "-"}`,
      `Updated: ${job.updatedAt}`,
      job.error ? `Error: ${job.error}` : undefined,
      events.length > 0 ? "Recent events:" : undefined,
      ...events.map((event) => `- ${event.createdAt} ${event.type}${event.message ? `: ${event.message}` : ""}`),
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  const jobs = listJobs(db, 5).filter((job) => requester === undefined || jobMatchesRequester(job, requester));
  if (jobs.length === 0) {
    return "No jobs found.";
  }
  return [
    "Recent jobs:",
    ...jobs.map((job) => `${job.id} ${job.status} ${job.project ?? "-"}`),
  ].join("\n");
}

export function buildJobCompletionMessage(job: StoredJob): string {
  return `Completed: ${job.id}${job.project ? ` (${job.project})` : ""}`;
}

export function buildJobFailureMessage(job: StoredJob): string {
  return `Failed: ${job.id}${job.error ? `\n${job.error}` : ""}`;
}

export function buildDailyFailedJobsReport(db: DatabaseSync, date: string): string {
  const failed = listJobs(db, 500).filter((job) => job.status === "FAILED" && job.updatedAt.startsWith(date));
  if (failed.length === 0) {
    return `Failed jobs for ${date}: none`;
  }
  return [
    `Failed jobs for ${date}: ${failed.length}`,
    ...failed.map((job) => `- ${job.id} ${job.project ?? "-"} ${job.error ?? ""}`.trimEnd()),
  ].join("\n");
}

function requiredTargetJobId(command: ParsedTelegramCommand): string {
  if (!command.targetJobId) {
    throw new Error(`/${command.name} requires a job id`);
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
    throw new Error(`Job not found: ${jobId}`);
  }
  if (requester && !jobMatchesRequester(job, requester)) {
    throw new Error(`Job is not visible from this Telegram chat/user: ${jobId}`);
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
