import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { createQueuedJobFromTelegramMessage } from "@telegram-local-ingest/capture";
import { type AppConfig, ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  appendJobEvent,
  createSourceBundle,
  getTelegramOffset,
  listJobEvents,
  listJobFiles,
  listJobs,
  migrate,
  mustGetJob,
  mustGetSourceBundleForJob,
  openIngestDatabase,
  setTelegramOffset,
  transitionJob,
  type DbHandle,
  type StoredJob,
} from "@telegram-local-ingest/db";
import { cleanupTelegramSourceFiles, importTelegramJobFiles } from "@telegram-local-ingest/importer";
import {
  buildJobCompletionMessage,
  buildJobFailureMessage,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
import {
  checkTelegramLocalBotApi,
  getMessageCommand,
  isTelegramUserAllowed,
  parseTelegramUpdate,
  TelegramBotApiClient,
} from "@telegram-local-ingest/telegram";
import { writeRawBundle } from "@telegram-local-ingest/vault";
import { runWikiIngestAdapter } from "@telegram-local-ingest/wiki-adapter";

export interface WorkerContext {
  config: AppConfig;
  db: DatabaseSync;
  telegram: TelegramBotApiClient;
}

export interface WorkerOnceResult {
  updatesSeen: number;
  operatorCommandsHandled: number;
  jobsCreated: number;
  jobsProcessed: number;
}

export interface WorkerLoopOptions {
  pollIntervalMs?: number;
  abortSignal?: AbortSignal;
}

export async function main(): Promise<void> {
  loadNearestEnvFile();
  const context = await createWorkerContext(loadConfig());
  try {
    await runWorkerLoop(context);
  } finally {
    context.close();
  }
}

export async function createWorkerContext(config: AppConfig): Promise<WorkerContext & DbHandle> {
  const dbHandle = openIngestDatabase(config.runtime.sqliteDbPath);
  migrate(dbHandle.db);
  const telegram = new TelegramBotApiClient({
    botToken: config.telegram.botToken,
    baseUrl: config.telegram.botApiBaseUrl,
    ...(config.telegram.localFilesRoot ? { localFilesRoot: config.telegram.localFilesRoot } : {}),
  });
  const health = await checkTelegramLocalBotApi(telegram);
  if (!health.ok) {
    dbHandle.close();
    throw new Error(`Telegram startup check failed: ${health.issues.join("; ")}`);
  }
  logWorker(`ready bot=${health.bot?.username ?? health.bot?.first_name ?? "unknown"}`);
  return {
    ...dbHandle,
    config,
    telegram,
  };
}

export async function runWorkerLoop(context: WorkerContext, options: WorkerLoopOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  while (!options.abortSignal?.aborted) {
    await runWorkerOnce(context);
    await sleep(pollIntervalMs, options.abortSignal);
  }
}

export async function runWorkerOnce(context: WorkerContext): Promise<WorkerOnceResult> {
  const updateResult = await pollTelegramUpdatesOnce(context);
  const jobsProcessed = await processRunnableJobs(context);
  return {
    ...updateResult,
    jobsProcessed,
  };
}

export async function pollTelegramUpdatesOnce(context: WorkerContext): Promise<Omit<WorkerOnceResult, "jobsProcessed">> {
  const botKey = context.config.telegram.botToken.slice(0, 16);
  const lastOffset = getTelegramOffset(context.db, botKey);
  const updates = await context.telegram.getUpdates({
    timeout: context.config.telegram.pollTimeoutSeconds,
    allowedUpdates: ["message"],
    ...(lastOffset === null ? {} : { offset: lastOffset + 1 }),
  });
  if (updates.length > 0) {
    logWorker(`updates received count=${updates.length}`);
  }

  let operatorCommandsHandled = 0;
  let jobsCreated = 0;
  for (const update of updates) {
    const parsed = parseTelegramUpdate(update);
    try {
      if (parsed && isTelegramUserAllowed(parsed.userId, context.config.telegram.allowedUserIds)) {
        const command = getMessageCommand(parsed);
        if (parsed.files.length === 0 && command && command.name !== "ingest" && command.name !== "unknown") {
          const result = await sendOperatorCommandResponse(context.db, context.telegram, parsed);
          operatorCommandsHandled += result.handled ? 1 : 0;
        } else {
          const created = createQueuedJobFromTelegramMessage(context.db, parsed);
          if (!created) {
            continue;
          }
          jobsCreated += 1;
          logWorker(`job queued id=${created.id} files=${parsed.files.length} command=${created.command ? "yes" : "no"}`);
          await context.telegram.sendMessage(parsed.chatId, buildQueuedMessage(created.id, parsed.files.map((file) => file.fileName ?? file.kind)));
        }
      }
    } catch (error) {
      if (parsed) {
        await context.telegram.sendMessage(parsed.chatId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      setTelegramOffset(context.db, botKey, update.update_id);
    }
  }

  return {
    updatesSeen: updates.length,
    operatorCommandsHandled,
    jobsCreated,
  };
}

export async function processRunnableJobs(context: WorkerContext, limit = 5): Promise<number> {
  let processed = 0;
  for (const job of listJobs(context.db, 100)) {
    if (processed >= limit) {
      break;
    }
    if (job.status !== "QUEUED" && job.status !== "NORMALIZING") {
      continue;
    }
    await processJob(context, job.id);
    processed += 1;
  }
  return processed;
}

export async function processJob(context: WorkerContext, jobId: string): Promise<StoredJob> {
  try {
    let job = mustGetJob(context.db, jobId);
    logWorker(`job processing id=${job.id} status=${job.status}`);
    if (job.status === "QUEUED") {
      await importTelegramJobFiles(context.db, context.telegram, job.id, {
        runtimeDir: context.config.runtime.runtimeDir,
        maxFileSizeBytes: context.config.runtime.maxFileSizeBytes,
      });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "NORMALIZING") {
      transitionJob(context.db, job.id, "BUNDLE_WRITING", { message: "Writing Obsidian raw bundle" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "BUNDLE_WRITING") {
      const bundle = await writeRawBundle({
        vaultPath: context.config.vault.obsidianVaultPath,
        rawRoot: context.config.vault.rawRoot,
        job,
        files: listJobFiles(context.db, job.id),
        events: listJobEvents(context.db, job.id),
      });
      createSourceBundle(context.db, {
        id: bundle.id,
        jobId: job.id,
        bundlePath: bundle.paths.root,
        manifestPath: bundle.paths.manifest,
        sourceMarkdownPath: bundle.paths.sourceMarkdown,
        finalizedAt: bundle.finalizedAt,
      });
      logWorker(`bundle written job=${job.id} path=${bundle.paths.root}`);
      transitionJob(context.db, job.id, "INGESTING", { message: "Raw bundle ready for wiki ingest" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "INGESTING") {
      await runConfiguredWikiAdapter(context, job);
      transitionJob(context.db, job.id, "NOTIFYING", { message: "Notifying Telegram" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "NOTIFYING") {
      if (job.chatId) {
        await context.telegram.sendMessage(job.chatId, buildJobCompletionMessage(job, listJobFiles(context.db, job.id)));
      }
      const completed = transitionJob(context.db, job.id, "COMPLETED", { message: "Completed" });
      const cleanup = await cleanupTelegramSourceFiles(context.db, context.telegram, job.id);
      if (cleanup.failedFiles.length > 0) {
        logWorker(`telegram source cleanup incomplete job=${job.id} failures=${cleanup.failedFiles.length}`, "warn");
      } else {
        logWorker(`telegram source cleanup complete job=${job.id} deleted=${cleanup.deletedPaths.length}`);
      }
      logWorker(`job completed id=${completed.id}`);
      return completed;
    }

    return job;
  } catch (error) {
    const failed = transitionToFailedIfPossible(context.db, jobId, error);
    if (failed?.chatId) {
      await context.telegram.sendMessage(failed.chatId, buildJobFailureMessage(failed));
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

async function runConfiguredWikiAdapter(context: WorkerContext, job: StoredJob): Promise<void> {
  if (!context.config.wiki.ingestCommand) {
    appendJobEvent(context.db, job.id, "wiki.skipped", "WIKI_INGEST_COMMAND is not configured");
    return;
  }
  const bundle = mustGetSourceBundleForJob(context.db, job.id);
  const result = await runWikiIngestAdapter({
    command: context.config.wiki.ingestCommand,
    bundlePath: bundle.bundlePath,
    rawRoot: path.resolve(context.config.vault.obsidianVaultPath, context.config.vault.rawRoot),
    wikiRoot: path.resolve(context.config.vault.obsidianVaultPath, "wiki"),
    lockPath: context.config.runtime.wikiWriteLockPath,
    jobId: job.id,
    ...(job.project ? { project: job.project } : {}),
    tags: job.tags,
    ...(job.instructions ? { instructions: job.instructions } : {}),
  });
  appendJobEvent(context.db, job.id, "wiki.adapter", "Wiki ingest adapter completed", {
    command: result.command,
    args: result.args,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function transitionToFailedIfPossible(db: DatabaseSync, jobId: string, error: unknown): StoredJob | null {
  const job = mustGetJob(db, jobId);
  if (job.status === "FAILED" || job.status === "COMPLETED" || job.status === "CANCELLED") {
    return job;
  }
  return transitionJob(db, jobId, "FAILED", {
    message: "Worker job failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

function logWorker(message: string, level: "info" | "warn" = "info"): void {
  const line = `[worker] ${new Date().toISOString()} ${message}`;
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function buildQueuedMessage(jobId: string, fileNames: string[]): string {
  return [`Queued: ${jobId}`, ...fileNames.map((name) => `- ${name}`)].join("\n");
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    abortSignal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
