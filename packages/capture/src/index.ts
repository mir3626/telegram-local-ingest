import type { DatabaseSync } from "node:sqlite";

import {
  addJobFile,
  createJob,
  getTelegramOffset,
  setTelegramOffset,
  transitionJob,
  type StoredJob,
} from "@telegram-local-ingest/db";
import {
  getMessageCommand,
  isTelegramUserAllowed,
  parseTelegramUpdate,
  type ParsedTelegramFile,
  type ParsedTelegramMessage,
  type TelegramBotApiClient,
  type TelegramUpdate,
} from "@telegram-local-ingest/telegram";

export interface CaptureOptions {
  botKey: string;
  allowedUserIds: string[];
  pollTimeoutSeconds: number;
  now?: string;
}

export interface CaptureResult {
  updatesSeen: number;
  jobsCreated: number;
  ignored: number;
  unauthorized: number;
  lastUpdateId?: number;
}

export async function pollAndCaptureTelegramUpdates(
  db: DatabaseSync,
  client: TelegramBotApiClient,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const lastOffset = getTelegramOffset(db, options.botKey);
  const getUpdatesOptions = {
    timeout: options.pollTimeoutSeconds,
    allowedUpdates: ["message"],
    ...(lastOffset === null ? {} : { offset: lastOffset + 1 }),
  };
  const updates = await client.getUpdates(getUpdatesOptions);
  return captureTelegramUpdates(db, updates, options);
}

export function captureTelegramUpdates(
  db: DatabaseSync,
  updates: TelegramUpdate[],
  options: CaptureOptions,
): CaptureResult {
  const result: CaptureResult = {
    updatesSeen: updates.length,
    jobsCreated: 0,
    ignored: 0,
    unauthorized: 0,
  };

  for (const update of updates) {
    const message = parseTelegramUpdate(update);
    if (!message) {
      result.ignored += 1;
      setOffset(db, options, update.update_id);
      result.lastUpdateId = update.update_id;
      continue;
    }

    if (!isTelegramUserAllowed(message.userId, options.allowedUserIds)) {
      result.unauthorized += 1;
      setOffset(db, options, update.update_id);
      result.lastUpdateId = update.update_id;
      continue;
    }

    const created = createQueuedJobFromTelegramMessage(db, message, options.now);
    if (created) {
      result.jobsCreated += 1;
    } else {
      result.ignored += 1;
    }
    setOffset(db, options, update.update_id);
    result.lastUpdateId = update.update_id;
  }

  return result;
}

export function createQueuedJobFromTelegramMessage(
  db: DatabaseSync,
  message: ParsedTelegramMessage,
  now?: string,
): StoredJob | null {
  return createIngestJobFromTelegramMessage(db, message, {
    queue: true,
    ...(now ? { now } : {}),
  });
}

export function createIngestJobFromTelegramMessage(
  db: DatabaseSync,
  message: ParsedTelegramMessage,
  options: { queue: boolean; now?: string },
): StoredJob | null {
  const command = getMessageCommand(message);
  if (command && command.name !== "ingest") {
    return null;
  }
  if (message.files.length === 0) {
    return null;
  }

  const instructions = command?.instructions ?? plainTextInstructions(message);
  const jobInput = {
    id: buildTelegramJobId(message),
    source: "telegram-local-bot-api",
    chatId: message.chatId,
    ...(command ? { command: command.raw } : {}),
    tags: command?.tags ?? [],
    ...(message.userId ? { userId: message.userId } : {}),
    ...(command?.project ? { project: command.project } : {}),
    ...(instructions ? { instructions } : {}),
    ...(options.now ? { now: options.now } : {}),
  } as const;
  const job = createJob(db, jobInput);

  for (const file of message.files) {
    const fileInput = {
      id: buildTelegramJobFileId(message, file),
      jobId: job.id,
      sourceFileId: file.fileId,
      ...(file.fileUniqueId ? { fileUniqueId: file.fileUniqueId } : {}),
      ...(file.fileName ? { originalName: file.fileName } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.fileSize !== undefined ? { sizeBytes: file.fileSize } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
    addJobFile(db, fileInput);
  }

  if (!options.queue) {
    return job;
  }

  return transitionJob(db, job.id, "QUEUED", {
    message: command ? "Queued from Telegram /ingest command" : "Queued from Telegram file upload",
    ...(options.now ? { now: options.now } : {}),
  });
}

export function buildTelegramJobId(message: ParsedTelegramMessage): string {
  return sanitizeId(`tg_${message.chatId}_${message.messageId}`);
}

export function buildTelegramJobFileId(message: ParsedTelegramMessage, file: ParsedTelegramFile): string {
  return sanitizeId(`${buildTelegramJobId(message)}_${file.kind}_${file.fileUniqueId ?? file.fileId}`);
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

function plainTextInstructions(message: ParsedTelegramMessage): string | undefined {
  const value = message.caption ?? message.text;
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return undefined;
  }
  return trimmed;
}

function setOffset(db: DatabaseSync, options: CaptureOptions, updateId: number): void {
  if (options.now) {
    setTelegramOffset(db, options.botKey, updateId, options.now);
    return;
  }
  setTelegramOffset(db, options.botKey, updateId);
}
