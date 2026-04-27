import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import PDFDocument from "pdfkit";

import {
  runAgentPostprocess,
  type AgentPostprocessInput,
  type AgentPostprocessResult,
} from "@telegram-local-ingest/agent-adapter";
import { createIngestJobFromTelegramMessage, createQueuedJobFromTelegramMessage } from "@telegram-local-ingest/capture";
import { type AppConfig, ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  appendJobEvent,
  claimRunnableJobs,
  createSourceBundle,
  getSourceBundleForJob,
  getJob,
  getTelegramOffset,
  getJobOutput,
  listJobEvents,
  listJobFiles,
  listJobOutputs,
  listJobs,
  migrate,
  mustGetJob,
  mustGetSourceBundleForJob,
  openIngestDatabase,
  requestRetry,
  releaseJobClaim,
  renewJobClaim,
  setTelegramOffset,
  transitionJob,
  type DbHandle,
  type StoredJob,
  type StoredJobEvent,
  type StoredJobFile,
  type StoredJobOutput,
} from "@telegram-local-ingest/db";
import { cleanupTelegramSourceFiles, importTelegramJobFiles, resolveRuntimePath } from "@telegram-local-ingest/importer";
import {
  buildStartResponse,
  buildJobCompletionMessage,
  buildJobFailureMessage,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
import {
  cleanupExpiredOutputs,
  createRuntimeOutput,
  discardRuntimeOutput,
  resolveDownloadableOutput,
} from "@telegram-local-ingest/output-store";
import { collectPreprocessedTextArtifacts } from "@telegram-local-ingest/preprocessors";
import { detectLanguageAcrossArtifacts, type DetectedLanguage } from "@telegram-local-ingest/language-detector";
import {
  ensureRtzrSupportedAudio,
  RtzrOpenApiClient,
  writeTranscriptArtifacts,
  type RtzrTranscribeConfig,
  type RtzrTranscript,
  type WaitForTranscriptionOptions,
} from "@telegram-local-ingest/rtzr";
import {
  LocalSenseVoiceClient,
  writeSenseVoiceTranscriptArtifacts,
  type SenseVoiceProgressHandler,
  type SenseVoiceTranscribeOptions,
  type SenseVoiceTranscript,
} from "@telegram-local-ingest/sensevoice";
import {
  checkTelegramLocalBotApi,
  getMessageCommand,
  type InlineKeyboardMarkup,
  isTelegramUserAllowed,
  parseTelegramCallbackQuery,
  parseTelegramUpdate,
  TelegramBotApiClient,
  type ParsedTelegramCallback,
  type ParsedTelegramFile,
} from "@telegram-local-ingest/telegram";
import { type RawBundleArtifactInput, writeRawBundle } from "@telegram-local-ingest/vault";
import { runWikiIngestAdapter } from "@telegram-local-ingest/wiki-adapter";

const execFileAsync = promisify(execFile);
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EML_MIME_TYPES = new Set(["application/eml", "message/rfc822"]);
const IMAGE_EXTENSIONS = new Set([".jpeg", ".jpg", ".png"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

export interface WorkerContext {
  config: AppConfig;
  db: DatabaseSync;
  telegram: TelegramBotApiClient;
  rtzr?: RtzrTranscriber;
  sensevoice?: SenseVoiceTranscriber;
  agent?: AgentPostprocessor;
  runtimeState?: WorkerRuntimeState;
}

export interface RtzrTranscriber {
  transcribeFile(
    filePath: string,
    config: RtzrTranscribeConfig,
    waitOptions: WaitForTranscriptionOptions,
  ): Promise<RtzrTranscript>;
}

export interface SenseVoiceTranscriber {
  transcribeFile(
    filePath: string,
    options: SenseVoiceTranscribeOptions,
    onProgress?: SenseVoiceProgressHandler,
  ): Promise<SenseVoiceTranscript>;
}

export interface AgentPostprocessor {
  postprocess(input: AgentPostprocessInput): Promise<AgentPostprocessResult>;
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

export interface ProcessRunnableJobsOptions {
  waitForCompletion?: boolean;
}

interface WorkerRuntimeState {
  workerId: string;
  runningJobIds: Set<string>;
  runningTasks: Set<Promise<void>>;
  sttSemaphore: Semaphore;
  agentSemaphore: Semaphore;
  lastOutputCleanupAtMs: number;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) {
      throw new Error("Semaphore maxConcurrency must be at least 1");
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

interface RtzrPreset {
  key: string;
  label: string;
  emoji: string;
  description: string;
  config: RtzrTranscribeConfig;
}

interface SttLanguagePreset {
  key: string;
  label: string;
  emoji: string;
  rtzrModelName: NonNullable<RtzrTranscribeConfig["model_name"]>;
  rtzrLanguage: NonNullable<RtzrTranscribeConfig["language"]>;
  rtzrLanguageCandidates?: string[];
  sensevoiceLanguage: string;
}

const RTZR_PRESETS: RtzrPreset[] = [
  {
    key: "meeting",
    label: "회의",
    emoji: "🧑‍💼",
    description: "여러 사람이 회의실/온라인 회의에서 말한 녹음",
    config: {
      model_name: "sommers",
      language: "ko",
      domain: "GENERAL",
      use_diarization: true,
      diarization: { spk_count: 0 },
      use_itn: true,
      use_disfluency_filter: false,
      use_profanity_filter: false,
      use_paragraph_splitter: true,
      paragraph_splitter: { max: 50 },
    },
  },
  {
    key: "call",
    label: "통화",
    emoji: "☎️",
    description: "전화/콜센터처럼 통화 품질에 가까운 녹음",
    config: {
      model_name: "sommers",
      language: "ko",
      domain: "CALL",
      use_diarization: true,
      diarization: { spk_count: 2 },
      use_itn: true,
      use_disfluency_filter: false,
      use_profanity_filter: false,
      use_paragraph_splitter: true,
      paragraph_splitter: { max: 50 },
    },
  },
  {
    key: "memo",
    label: "음성 메모",
    emoji: "🎙️",
    description: "한 사람이 남긴 메모/독백 형태의 녹음",
    config: {
      model_name: "sommers",
      language: "ko",
      domain: "GENERAL",
      use_diarization: false,
      use_itn: true,
      use_disfluency_filter: false,
      use_profanity_filter: false,
      use_paragraph_splitter: true,
      paragraph_splitter: { max: 50 },
    },
  },
];

const STT_LANGUAGE_PRESETS: SttLanguagePreset[] = [
  {
    key: "ko",
    label: "한국어",
    emoji: "🇰🇷",
    rtzrModelName: "sommers",
    rtzrLanguage: "ko",
    sensevoiceLanguage: "ko",
  },
  {
    key: "en",
    label: "영어",
    emoji: "🇺🇸",
    rtzrModelName: "whisper",
    rtzrLanguage: "en",
    sensevoiceLanguage: "en",
  },
  {
    key: "zh",
    label: "중국어",
    emoji: "🇨🇳",
    rtzrModelName: "whisper",
    rtzrLanguage: "zh",
    sensevoiceLanguage: "zh",
  },
  {
    key: "ja",
    label: "일본어",
    emoji: "🇯🇵",
    rtzrModelName: "sommers",
    rtzrLanguage: "ja",
    sensevoiceLanguage: "ja",
  },
  {
    key: "multi",
    label: "혼합/자동",
    emoji: "🌐",
    rtzrModelName: "whisper",
    rtzrLanguage: "multi",
    rtzrLanguageCandidates: ["ko", "en", "ja", "zh"],
    sensevoiceLanguage: "auto",
  },
];

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
  const rtzr = config.rtzr.clientId && config.rtzr.clientSecret
    ? new RtzrOpenApiClient({
      clientId: config.rtzr.clientId,
      clientSecret: config.rtzr.clientSecret,
      apiBaseUrl: config.rtzr.apiBaseUrl,
    })
    : undefined;
  const sensevoice = config.stt.provider === "sensevoice"
    ? new LocalSenseVoiceClient()
    : undefined;
  const agent = config.agent.provider === "none"
    ? undefined
    : { postprocess: (input: AgentPostprocessInput) => runAgentPostprocess(input) };
  const health = await checkTelegramLocalBotApi(telegram);
  if (!health.ok) {
    dbHandle.close();
    throw new Error(`Telegram startup check failed: ${health.issues.join("; ")}`);
  }
  logWorker(`ready bot=${health.bot?.username ?? health.bot?.first_name ?? "unknown"}`, "info", "STARTUP");
  return {
    ...dbHandle,
    config,
    telegram,
    runtimeState: createWorkerRuntimeState(config),
    ...(rtzr ? { rtzr } : {}),
    ...(sensevoice ? { sensevoice } : {}),
    ...(agent ? { agent } : {}),
  };
}

export async function runWorkerLoop(context: WorkerContext, options: WorkerLoopOptions = {}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  while (!options.abortSignal?.aborted) {
    const updateResult = await pollTelegramUpdatesOnce(context);
    const jobsStarted = await processRunnableJobs(context, context.config.worker.jobConcurrency, {
      waitForCompletion: false,
    });
    await cleanupExpiredOutputFilesIfDue(context);
    if (jobsStarted > 0 || updateResult.updatesSeen > 0) {
      const runtime = ensureWorkerRuntimeState(context);
      logWorker(
        `tick updates=${updateResult.updatesSeen} jobsStarted=${jobsStarted} activeJobs=${runtime.runningJobIds.size}`,
        "info",
        "LOOP",
      );
    }
    await sleep(pollIntervalMs, options.abortSignal);
  }
  await waitForRunningJobs(context);
}

export async function runWorkerOnce(context: WorkerContext): Promise<WorkerOnceResult> {
  const updateResult = await pollTelegramUpdatesOnce(context);
  const jobsProcessed = await processRunnableJobs(context);
  await cleanupExpiredOutputFiles(context);
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
    allowedUpdates: ["message", "callback_query"],
    ...(lastOffset === null ? {} : { offset: lastOffset + 1 }),
  });
  if (updates.length > 0) {
    logWorker(`updates received count=${updates.length}`, "info", "TELEGRAM");
  }

  let operatorCommandsHandled = 0;
  let jobsCreated = 0;
  for (const update of updates) {
    const callback = parseTelegramCallbackQuery(update);
    if (callback) {
      try {
        if (isTelegramUserAllowed(callback.userId, context.config.telegram.allowedUserIds)) {
          const handled = await handleRetryCallback(context, callback)
            || await handleOutputLifecycleCallback(context, callback)
            || await handleDownloadCallback(context, callback)
            || await handleSttContextCallback(context, callback);
          operatorCommandsHandled += handled ? 1 : 0;
        }
      } finally {
        setTelegramOffset(context.db, botKey, update.update_id);
      }
      continue;
    }

    const parsed = parseTelegramUpdate(update);
    try {
      if (parsed) {
        const command = getMessageCommand(parsed);
        const isAllowed = isTelegramUserAllowed(parsed.userId, context.config.telegram.allowedUserIds);
        if (command?.name === "start") {
          await context.telegram.sendMessage(parsed.chatId, buildStartResponse(parsed, isAllowed));
          operatorCommandsHandled += 1;
          continue;
        }
        if (!isAllowed) {
          continue;
        }
        if (parsed.files.length === 0 && command && command.name !== "ingest" && command.name !== "unknown") {
          const result = await sendOperatorCommandResponse(context.db, context.telegram, parsed);
          operatorCommandsHandled += result.handled ? 1 : 0;
        } else {
          const needsSttPreset = hasAudioOrVoice(parsed.files);
          const created = needsSttPreset
            ? createIngestJobFromTelegramMessage(context.db, parsed, { queue: false })
            : createQueuedJobFromTelegramMessage(context.db, parsed);
          if (!created) {
            continue;
          }
          jobsCreated += 1;
          logWorker(`job queued id=${created.id} files=${parsed.files.length} command=${created.command ? "yes" : "no"}`, "info", "QUEUE");
          if (needsSttPreset) {
            appendJobEvent(context.db, created.id, "stt.preset_requested", "STT preset selection requested", {
              sttProvider: context.config.stt.provider,
              translationDefaultRelation: context.config.translation.defaultRelation,
            });
            await context.telegram.sendMessage(
              parsed.chatId,
              buildSttPresetPrompt(created.id, parsed.files),
              { replyMarkup: buildSttPresetKeyboard(created.id) },
            );
          } else {
            await context.telegram.sendMessage(parsed.chatId, buildQueuedMessage(created.id, parsed.files.map((file) => file.fileName ?? file.kind)));
          }
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

export async function processRunnableJobs(
  context: WorkerContext,
  limit = context.config.worker.jobConcurrency,
  options: ProcessRunnableJobsOptions = {},
): Promise<number> {
  const runtime = ensureWorkerRuntimeState(context);
  const capacity = Math.max(0, limit - runtime.runningJobIds.size);
  if (capacity === 0) {
    return 0;
  }

  const jobs = claimRunnableJobs(context.db, {
    workerId: runtime.workerId,
    limit: capacity,
    leaseMs: context.config.worker.jobClaimTtlMs,
    excludeJobIds: [...runtime.runningJobIds],
  });
  if (jobs.length === 0) {
    return 0;
  }

  const tasks = jobs.map((job) => startJobTask(context, job.id));
  if (options.waitForCompletion ?? true) {
    await Promise.all(tasks);
  } else {
    for (const [index, task] of tasks.entries()) {
      const job = jobs[index];
      void task.catch((error) => {
        logWorker(`background job failed id=${job?.id ?? "unknown"} error=${errorMessage(error)}`, "warn", "JOB");
      });
    }
  }
  return jobs.length;
}

export async function processJob(context: WorkerContext, jobId: string): Promise<StoredJob> {
  try {
    let job = mustGetJob(context.db, jobId);
    logWorker(`job processing id=${job.id} status=${job.status}`, "info", "JOB");
    if (job.status === "QUEUED") {
      logWorker(`importing Telegram files job=${job.id}`, "info", "IMPORT");
      await importTelegramJobFiles(context.db, context.telegram, job.id, {
        runtimeDir: context.config.runtime.runtimeDir,
        maxFileSizeBytes: context.config.runtime.maxFileSizeBytes,
      });
      job = mustGetJob(context.db, job.id);
      logWorker(`import complete job=${job.id} status=${job.status}`, "info", "IMPORT");
    }

    if (job.status === "NORMALIZING") {
      const audioFiles = listJobFiles(context.db, job.id).filter(isAudioJobFile);
      if (audioFiles.length > 0) {
        logWorker(`STT phase started job=${job.id} provider=${context.config.stt.provider} files=${audioFiles.length}`, "info", "STT");
        await runWithSemaphore(context, "stt", () => runConfiguredSttTranscription(context, job));
        const transcriptOutputs = await registerTranscriptOutputs(context, job);
        if (transcriptOutputs.length > 0) {
          logWorker(`transcript outputs registered job=${job.id} count=${transcriptOutputs.length}`, "info", "OUTPUT");
        }
        const stopped = terminalJobIfStopped(context.db, job.id);
        if (stopped) {
          return stopped;
        }
        logWorker(`STT phase finished job=${job.id} provider=${context.config.stt.provider}`, "info", "STT");
      } else {
        logWorker(`STT skipped job=${job.id} reason=no_audio_files`, "info", "STT");
      }
      const stopped = terminalJobIfStopped(context.db, job.id);
      if (stopped) {
        return stopped;
      }
      transitionJob(context.db, job.id, "BUNDLE_WRITING", { message: "Writing Obsidian raw bundle" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "BUNDLE_WRITING") {
      const existingBundle = getSourceBundleForJob(context.db, job.id);
      if (existingBundle && await isReusableSourceBundle(existingBundle)) {
        appendJobEvent(context.db, job.id, "bundle.reused", existingBundle.bundlePath, {
          bundleId: existingBundle.id,
        });
        logWorker(`reusing existing raw bundle job=${job.id} path=${existingBundle.bundlePath}`, "info", "BUNDLE");
        transitionJob(context.db, job.id, "INGESTING", { message: "Reusing existing Obsidian raw bundle" });
        job = mustGetJob(context.db, job.id);
      } else {
      logWorker(`writing raw bundle job=${job.id}`, "info", "BUNDLE");
      const events = listJobEvents(context.db, job.id);
      const bundle = await writeRawBundle({
        vaultPath: context.config.vault.obsidianVaultPath,
        rawRoot: context.config.vault.rawRoot,
        job,
        files: listJobFiles(context.db, job.id),
        events,
        extractedArtifacts: collectExtractedArtifacts(events),
      });
      createSourceBundle(context.db, {
        id: bundle.id,
        jobId: job.id,
        bundlePath: bundle.paths.root,
        manifestPath: bundle.paths.manifest,
        sourceMarkdownPath: bundle.paths.sourceMarkdown,
        finalizedAt: bundle.finalizedAt,
      });
      logWorker(`bundle written job=${job.id} path=${bundle.paths.root}`, "info", "BUNDLE");
      transitionJob(context.db, job.id, "INGESTING", { message: "Raw bundle ready for wiki ingest" });
      job = mustGetJob(context.db, job.id);
      }
    }

    if (job.status === "INGESTING") {
      logWorker(`preprocessing phase started job=${job.id}`, "info", "PREPROCESS");
      await runPreprocessingAndLanguageCheck(context, job);
      logWorker(`preprocessing phase finished job=${job.id}`, "info", "PREPROCESS");
      logWorker(`agent postprocess phase started job=${job.id} provider=${context.config.agent.provider}`, "info", "AGENT");
      if (shouldUseAgentSemaphore(context, job)) {
        await runWithSemaphore(context, "agent", () => runConfiguredAgentPostprocess(context, job));
      } else {
        await runConfiguredAgentPostprocess(context, job);
      }
      const stopped = terminalJobIfStopped(context.db, job.id);
      if (stopped) {
        return stopped;
      }
      logWorker(`agent postprocess phase finished job=${job.id} provider=${context.config.agent.provider}`, "info", "AGENT");
      logWorker(`wiki adapter phase started job=${job.id}`, "info", "WIKI");
      await runConfiguredWikiAdapter(context, job);
      const wikiStopped = terminalJobIfStopped(context.db, job.id);
      if (wikiStopped) {
        return wikiStopped;
      }
      logWorker(`wiki adapter phase finished job=${job.id}`, "info", "WIKI");
      transitionJob(context.db, job.id, "NOTIFYING", { message: "Notifying Telegram" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "NOTIFYING") {
      logWorker(`sending completion notification job=${job.id}`, "info", "NOTIFY");
      if (job.chatId) {
        const files = listJobFiles(context.db, job.id);
        const outputs = listActiveJobOutputs(context.db, job.id);
        await context.telegram.sendMessage(
          job.chatId,
          buildCompletionNotification(job, files, outputs),
          outputs.length > 0 ? { replyMarkup: buildDownloadKeyboard(outputs) } : {},
        );
      }
      const completed = transitionJob(context.db, job.id, "COMPLETED", { message: "Completed" });
      const cleanup = await cleanupTelegramSourceFiles(context.db, context.telegram, job.id);
      if (cleanup.failedFiles.length > 0) {
        logWorker(`telegram source cleanup incomplete job=${job.id} failures=${cleanup.failedFiles.length}`, "warn", "CLEANUP");
      } else {
        logWorker(`telegram source cleanup complete job=${job.id} deleted=${cleanup.deletedPaths.length}`, "info", "CLEANUP");
      }
      logWorker(`job completed id=${completed.id}`, "info", "JOB");
      return completed;
    }

    return job;
  } catch (error) {
    const failed = transitionToFailedIfPossible(context.db, jobId, error);
    if (failed?.status === "CANCELLED" || failed?.status === "COMPLETED") {
      return failed;
    }
    if (failed?.chatId) {
      await context.telegram.sendMessage(
        failed.chatId,
        buildJobFailureMessage(failed),
        failed.status === "FAILED" ? { replyMarkup: buildRetryKeyboard(failed.id) } : {},
      );
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error));
  }
}

function createWorkerRuntimeState(config: AppConfig): WorkerRuntimeState {
  return {
    workerId: `worker-${process.pid}-${randomUUID()}`,
    runningJobIds: new Set(),
    runningTasks: new Set(),
    sttSemaphore: new Semaphore(config.worker.sttConcurrency),
    agentSemaphore: new Semaphore(config.worker.agentConcurrency),
    lastOutputCleanupAtMs: 0,
  };
}

function ensureWorkerRuntimeState(context: WorkerContext): WorkerRuntimeState {
  if (!context.runtimeState) {
    context.runtimeState = createWorkerRuntimeState(context.config);
  }
  return context.runtimeState;
}

function startJobTask(context: WorkerContext, jobId: string): Promise<void> {
  const runtime = ensureWorkerRuntimeState(context);
  runtime.runningJobIds.add(jobId);
  const stopHeartbeat = startJobClaimHeartbeat(context, jobId);
  const task = (async () => {
    try {
      await processJob(context, jobId);
    } finally {
      stopHeartbeat();
      releaseJobClaim(context.db, jobId, runtime.workerId);
      runtime.runningJobIds.delete(jobId);
    }
  })();
  runtime.runningTasks.add(task);
  task.then(
    () => runtime.runningTasks.delete(task),
    () => runtime.runningTasks.delete(task),
  );
  return task;
}

function startJobClaimHeartbeat(context: WorkerContext, jobId: string): () => void {
  const runtime = ensureWorkerRuntimeState(context);
  const ttlMs = context.config.worker.jobClaimTtlMs;
  const intervalMs = Math.max(1000, Math.min(60_000, Math.floor(ttlMs / 3)));
  const timer = setInterval(() => {
    try {
      const renewed = renewJobClaim(context.db, jobId, runtime.workerId, ttlMs);
      if (!renewed) {
        logWorker(`job claim heartbeat lost job=${jobId} worker=${runtime.workerId}`, "warn", "CLAIM");
      }
    } catch (error) {
      logWorker(`job claim heartbeat failed job=${jobId} error=${errorMessage(error)}`, "warn", "CLAIM");
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function waitForRunningJobs(context: WorkerContext): Promise<void> {
  const runtime = ensureWorkerRuntimeState(context);
  if (runtime.runningTasks.size === 0) {
    return;
  }
  await Promise.allSettled([...runtime.runningTasks]);
}

async function runWithSemaphore<T>(
  context: WorkerContext,
  kind: "stt" | "agent",
  work: () => Promise<T>,
): Promise<T> {
  const runtime = ensureWorkerRuntimeState(context);
  return (kind === "stt" ? runtime.sttSemaphore : runtime.agentSemaphore).run(work);
}

function terminalJobIfStopped(db: DatabaseSync, jobId: string): StoredJob | null {
  const current = mustGetJob(db, jobId);
  if (current.status === "CANCELLED" || current.status === "FAILED" || current.status === "COMPLETED") {
    return current;
  }
  return null;
}

async function isReusableSourceBundle(bundle: { bundlePath: string; manifestPath: string; sourceMarkdownPath: string }): Promise<boolean> {
  const markerPath = path.join(bundle.bundlePath, ".finalized");
  try {
    await Promise.all([
      fs.access(bundle.bundlePath),
      fs.access(bundle.manifestPath),
      fs.access(bundle.sourceMarkdownPath),
      fs.access(markerPath),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function cleanupExpiredOutputFiles(context: WorkerContext): Promise<void> {
  const cleanup = await cleanupExpiredOutputs(context.db, { limit: 50 });
  if (cleanup.deletedOutputs.length > 0) {
    logWorker(`expired output cleanup deleted=${cleanup.deletedOutputs.length}`, "info", "OUTPUT");
  }
  if (cleanup.failedOutputs.length > 0) {
    logWorker(`expired output cleanup failures=${cleanup.failedOutputs.length}`, "warn", "OUTPUT");
  }
}

async function cleanupExpiredOutputFilesIfDue(context: WorkerContext): Promise<void> {
  const runtime = ensureWorkerRuntimeState(context);
  const nowMs = Date.now();
  if (
    runtime.lastOutputCleanupAtMs > 0 &&
    nowMs - runtime.lastOutputCleanupAtMs < context.config.worker.outputCleanupIntervalMs
  ) {
    return;
  }
  runtime.lastOutputCleanupAtMs = nowMs;
  await cleanupExpiredOutputFiles(context);
}

async function answerCallbackQuerySafely(context: WorkerContext, callbackQueryId: string, text: string): Promise<void> {
  try {
    await context.telegram.answerCallbackQuery(callbackQueryId, text);
  } catch (error) {
    logWorker(`answerCallbackQuery failed callback=${callbackQueryId} error=${errorMessage(error)}`, "warn", "TELEGRAM");
  }
}

async function handleRetryCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseRetryCallbackData(callback.data);
  if (!parsed) {
    return false;
  }

  if (!callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 재시도할 작업을 확인할 수 없습니다.");
    return true;
  }

  const job = getJob(context.db, parsed.jobId);
  if (!job) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, `⚠️ 작업을 찾을 수 없습니다: ${parsed.jobId}`);
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "🔒 이 작업을 재시도할 권한이 없습니다.");
    return true;
  }

  if (job.status !== "FAILED") {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, `⏳ 현재 상태에서는 재시도할 수 없습니다: ${job.status}`);
    return true;
  }

  const retryRequested = requestRetry(context.db, job.id, { message: "Retry requested from Telegram button" });
  const queued = transitionJob(context.db, retryRequested.id, "QUEUED", {
    message: "Retry queued from Telegram button",
  });
  await answerCallbackQuerySafely(context, callback.callbackQueryId, "🔁 재시도 대기열에 넣었습니다.");
  await context.telegram.sendMessage(callback.chatId, `🔁 재시도 대기열에 넣었어요: ${queued.id}`);
  logWorker(`retry queued job=${queued.id} from=telegram_button`, "info", "RETRY");
  return true;
}

async function handleDownloadCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseDownloadCallbackData(callback.data);
  if (!parsed) {
    return false;
  }

  if (!callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 다운로드할 채팅을 확인할 수 없습니다.");
    return true;
  }

  const resolved = resolveDownloadableOutput(context.db, parsed.outputId);
  if (resolved.status === "not_found") {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 다운로드 파일을 찾을 수 없습니다.");
    return true;
  }
  if (resolved.status === "expired" || resolved.status === "deleted") {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⏳ 다운로드 기간이 만료되었습니다.");
    return true;
  }

  const output = resolved.output;
  if (!output) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 다운로드 파일을 확인할 수 없습니다.");
    return true;
  }

  const job = getJob(context.db, output.jobId);
  if (!job) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 원본 작업을 찾을 수 없습니다.");
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "🔒 이 파일을 다운로드할 권한이 없습니다.");
    return true;
  }

  await answerCallbackQuerySafely(context, callback.callbackQueryId, "⬇️ 파일을 전송합니다.");
  await context.telegram.sendDocument(callback.chatId, output.filePath, {
    fileName: output.fileName,
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    caption: `📎 ${output.fileName}`,
  });
  logWorker(`download sent output=${output.id} job=${output.jobId}`, "info", "OUTPUT");
  return true;
}

async function handleOutputLifecycleCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const discard = parseOutputDiscardCallbackData(callback.data);
  if (discard) {
    return handleOutputDiscardCallback(context, callback, discard.outputId);
  }
  const regenerate = parseOutputRegenerateCallbackData(callback.data);
  if (regenerate) {
    return handleOutputRegenerateCallback(context, callback, regenerate.outputId);
  }
  return false;
}

async function handleOutputDiscardCallback(
  context: WorkerContext,
  callback: ParsedTelegramCallback,
  outputId: string,
): Promise<boolean> {
  if (!callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 폐기할 채팅을 확인할 수 없습니다.");
    return true;
  }

  const access = getOutputCallbackAccess(context, callback, outputId);
  if ("error" in access) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, access.error);
    return true;
  }

  const discarded = await discardRuntimeOutput(context.db, access.output.id);
  await answerCallbackQuerySafely(context, callback.callbackQueryId, "🗑️ 결과 파일을 폐기했습니다.");
  logWorker(`output discarded output=${discarded.output.id} job=${discarded.output.jobId}`, "info", "OUTPUT");
  return true;
}

async function handleOutputRegenerateCallback(
  context: WorkerContext,
  callback: ParsedTelegramCallback,
  outputId: string,
): Promise<boolean> {
  if (!callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 다시 생성할 채팅을 확인할 수 없습니다.");
    return true;
  }

  const access = getOutputCallbackAccess(context, callback, outputId);
  if ("error" in access) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, access.error);
    return true;
  }

  appendJobEvent(context.db, access.job.id, "output.regenerate_requested", access.output.fileName, {
    outputId: access.output.id,
    status: "interface_only",
  });
  await answerCallbackQuerySafely(
    context,
    callback.callbackQueryId,
    "♻️ 다시 생성 요청을 기록했습니다. 자동 재생성은 아직 비활성화되어 있습니다.",
  );
  logWorker(`output regenerate requested output=${access.output.id} job=${access.job.id} status=interface_only`, "info", "OUTPUT");
  return true;
}

async function handleSttContextCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const languageSelection = parseSttLanguageCallbackData(callback.data);
  if (languageSelection) {
    return handleSttLanguageCallback(context, callback, languageSelection);
  }
  return handleSttEnvironmentCallback(context, callback);
}

async function handleSttEnvironmentCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseSttEnvironmentCallbackData(callback.data);
  if (!parsed || !callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 처리할 수 없는 선택입니다.");
    return false;
  }

  const preset = RTZR_PRESETS.find((candidate) => candidate.key === parsed.presetKey);
  if (!preset) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 알 수 없는 녹음 환경입니다.");
    return false;
  }

  const job = getJob(context.db, parsed.jobId);
  if (!job) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, `⚠️ 작업을 찾을 수 없습니다: ${parsed.jobId}`);
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "🔒 이 작업을 변경할 권한이 없습니다.");
    return true;
  }

  if (job.status !== "RECEIVED") {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⏳ 이미 처리 중인 작업입니다.");
    return true;
  }

  appendJobEvent(context.db, job.id, "stt.environment_selected", `${preset.emoji} ${preset.label}`, {
    sttProvider: context.config.stt.provider,
    presetKey: preset.key,
    presetLabel: preset.label,
    presetDescription: preset.description,
    translationDefaultRelation: context.config.translation.defaultRelation,
  });
  await answerCallbackQuerySafely(context, callback.callbackQueryId, `${preset.emoji} ${preset.label} 환경을 저장했습니다.`);
  await context.telegram.sendMessage(
    callback.chatId,
    buildSttLanguagePrompt(job.id, preset),
    { replyMarkup: buildSttLanguageKeyboard(job.id, preset.key) },
  );
  logWorker(`stt environment selected job=${job.id} provider=${context.config.stt.provider} preset=${preset.key}`, "info", "STT");
  return true;
}

async function handleSttLanguageCallback(
  context: WorkerContext,
  callback: ParsedTelegramCallback,
  parsed: { presetKey: string; languageKey: string; jobId: string },
): Promise<boolean> {
  if (!callback.chatId) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 처리할 수 없는 선택입니다.");
    return false;
  }

  const preset = RTZR_PRESETS.find((candidate) => candidate.key === parsed.presetKey);
  if (!preset) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 알 수 없는 녹음 환경입니다.");
    return false;
  }

  const language = STT_LANGUAGE_PRESETS.find((candidate) => candidate.key === parsed.languageKey);
  if (!language) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⚠️ 알 수 없는 인식 언어입니다.");
    return false;
  }

  const job = getJob(context.db, parsed.jobId);
  if (!job) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, `⚠️ 작업을 찾을 수 없습니다: ${parsed.jobId}`);
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "🔒 이 작업을 변경할 권한이 없습니다.");
    return true;
  }

  if (job.status !== "RECEIVED") {
    await answerCallbackQuerySafely(context, callback.callbackQueryId, "⏳ 이미 처리 중인 작업입니다.");
    return true;
  }

  const rtzrConfig = buildRtzrTranscribeConfig(preset, language);
  const sensevoiceConfig = buildSenseVoiceTranscribeOptions(context.config, language);
  appendJobEvent(context.db, job.id, "stt.preset_selected", `${preset.emoji} ${preset.label}`, {
    sttProvider: context.config.stt.provider,
    presetKey: preset.key,
    presetLabel: preset.label,
    presetDescription: preset.description,
    languageKey: language.key,
    languageLabel: language.label,
    languageCode: language.rtzrLanguage,
    rtzrModelName: language.rtzrModelName,
    ...(language.rtzrLanguageCandidates ? { languageCandidates: language.rtzrLanguageCandidates } : {}),
    rtzrConfig,
    sensevoiceConfig,
    translationDefaultRelation: context.config.translation.defaultRelation,
  });
  const queued = transitionJob(context.db, job.id, "QUEUED", {
    message: `STT preset selected: ${preset.label}, ${language.label}`,
  });
  await answerCallbackQuerySafely(context, callback.callbackQueryId, `${language.emoji} ${language.label} 설정을 저장했습니다.`);
  await context.telegram.sendMessage(callback.chatId, buildPresetQueuedMessage(queued.id, preset, language));
  logWorker(
    `stt preset selected job=${queued.id} provider=${context.config.stt.provider} preset=${preset.key} language=${language.key} model=${language.rtzrModelName}`,
    "info",
    "STT",
  );
  return true;
}

async function runConfiguredSttTranscription(context: WorkerContext, job: StoredJob): Promise<void> {
  if (context.config.stt.provider === "sensevoice") {
    await runConfiguredSenseVoiceTranscription(context, job);
    return;
  }
  if (context.config.stt.provider === "rtzr") {
    await runConfiguredRtzrTranscription(context, job);
    return;
  }

  const files = listJobFiles(context.db, job.id).filter(isAudioJobFile);
  if (files.length > 0) {
    appendJobEvent(context.db, job.id, "stt.skipped", "STT_PROVIDER is none");
  }
}

async function runConfiguredRtzrTranscription(context: WorkerContext, job: StoredJob): Promise<void> {
  const files = listJobFiles(context.db, job.id).filter(isAudioJobFile);
  if (files.length === 0) {
    return;
  }

  const events = listJobEvents(context.db, job.id);
  if (!context.rtzr) {
    if (!events.some((event) => event.type === "rtzr.skipped")) {
      appendJobEvent(context.db, job.id, "rtzr.skipped", "RTZR credentials are not configured");
    }
    logWorker(`RTZR skipped job=${job.id} reason=credentials_missing`, "warn", "RTZR");
    return;
  }

  const alreadyTranscribedFileIds = new Set(
    events
      .filter((event) => event.type === "rtzr.transcribed" && isRecord(event.data) && typeof event.data.fileId === "string")
      .map((event) => (event.data as { fileId: string }).fileId),
  );
  const config = selectedRtzrConfig(events);

  for (const file of files) {
    if (alreadyTranscribedFileIds.has(file.id)) {
      logWorker(`RTZR skip already transcribed job=${job.id} file=${file.id}`, "info", "RTZR");
      continue;
    }
    const inputPath = file.localPath ?? file.archivePath;
    if (!inputPath) {
      appendJobEvent(context.db, job.id, "rtzr.skipped_file", file.originalName ?? file.id, {
        fileId: file.id,
        reason: "Imported file path is missing",
      });
      logWorker(`RTZR skipped file job=${job.id} file=${file.id} reason=missing_path`, "warn", "RTZR");
      continue;
    }

    logWorker(`RTZR normalizing audio job=${job.id} file=${file.id}`, "info", "RTZR");
    const normalized = await ensureRtzrSupportedAudio({
      inputPath,
      outputDir: resolveRuntimePath(context.config.runtime.runtimeDir, "normalized", job.id, file.id),
      ffmpegPath: context.config.rtzr.ffmpegPath,
    });
    logWorker(`RTZR transcribe start job=${job.id} file=${file.id} audio=${normalized.audioPath}`, "info", "RTZR");
    const transcript = await context.rtzr.transcribeFile(normalized.audioPath, config, buildRtzrWaitOptions(context.config));
    logWorker(`RTZR transcribe complete job=${job.id} file=${file.id} transcribeId=${transcript.id}`, "info", "RTZR");
    const artifactDir = resolveRuntimePath(context.config.runtime.runtimeDir, "extracted", job.id, file.id);
    const artifacts = await writeTranscriptArtifacts(transcript, artifactDir);
    const stem = artifactStem(file.originalName ?? file.id);
    appendJobEvent(context.db, job.id, "rtzr.transcribed", file.originalName ?? file.id, {
      fileId: file.id,
      originalName: file.originalName,
      inputPath,
      audioPath: normalized.audioPath,
      converted: normalized.converted,
      transcribeId: transcript.id,
      config,
      artifacts: [
        { kind: "rtzr_json", sourcePath: artifacts.rtzrJsonPath, name: `${stem}.rtzr.json` },
        { kind: "transcript_markdown", sourcePath: artifacts.transcriptMarkdownPath, name: `${stem}.transcript.md` },
      ],
    });
    logWorker(`RTZR artifacts written job=${job.id} file=${file.id}`, "info", "RTZR");
  }
}

async function runConfiguredSenseVoiceTranscription(context: WorkerContext, job: StoredJob): Promise<void> {
  const files = listJobFiles(context.db, job.id).filter(isAudioJobFile);
  if (files.length === 0) {
    return;
  }

  const events = listJobEvents(context.db, job.id);
  if (!context.sensevoice) {
    if (!events.some((event) => event.type === "sensevoice.skipped")) {
      appendJobEvent(context.db, job.id, "sensevoice.skipped", "SenseVoice is not configured");
    }
    logWorker(`SenseVoice skipped job=${job.id} reason=not_configured`, "warn", "SENSEVOICE");
    return;
  }

  const alreadyTranscribedFileIds = new Set(
    events
      .filter((event) => event.type === "sensevoice.transcribed" && isRecord(event.data) && typeof event.data.fileId === "string")
      .map((event) => (event.data as { fileId: string }).fileId),
  );
  const config = selectedSenseVoiceConfig(context.config, events);

  for (const file of files) {
    if (alreadyTranscribedFileIds.has(file.id)) {
      logWorker(`SenseVoice skip already transcribed job=${job.id} file=${file.id}`, "info", "SENSEVOICE");
      continue;
    }
    const inputPath = file.localPath ?? file.archivePath;
    if (!inputPath) {
      appendJobEvent(context.db, job.id, "sensevoice.skipped_file", file.originalName ?? file.id, {
        fileId: file.id,
        reason: "Imported file path is missing",
      });
      logWorker(`SenseVoice skipped file job=${job.id} file=${file.id} reason=missing_path`, "warn", "SENSEVOICE");
      continue;
    }

    logWorker(`SenseVoice normalizing audio job=${job.id} file=${file.id}`, "info", "SENSEVOICE");
    const normalized = await ensureRtzrSupportedAudio({
      inputPath,
      outputDir: resolveRuntimePath(context.config.runtime.runtimeDir, "normalized", job.id, file.id),
      ffmpegPath: context.config.rtzr.ffmpegPath,
    });
    const artifactDir = resolveRuntimePath(context.config.runtime.runtimeDir, "extracted", job.id, file.id);
    const startedAt = Date.now();
    logWorker(
      `SenseVoice transcribe start job=${job.id} file=${file.id} device=${config.device} audio=${normalized.audioPath}`,
      "info",
      "SENSEVOICE",
    );
    const transcript = await context.sensevoice.transcribeFile(normalized.audioPath, config, (progress) => {
      const percent = progress.percent === undefined ? "" : `progress=${progress.percent}% `;
      logWorker(`job=${job.id} file=${file.id} ${percent}stage=${progress.stage} ${progress.message}`, "info", "SENSEVOICE");
    });
    logWorker(
      `SenseVoice transcribe complete job=${job.id} file=${file.id} transcriptId=${transcript.id} elapsedMs=${Date.now() - startedAt}`,
      "info",
      "SENSEVOICE",
    );
    const artifacts = await writeSenseVoiceTranscriptArtifacts(transcript, artifactDir);
    const stem = artifactStem(file.originalName ?? file.id);
    appendJobEvent(context.db, job.id, "sensevoice.transcribed", file.originalName ?? file.id, {
      fileId: file.id,
      originalName: file.originalName,
      inputPath,
      audioPath: normalized.audioPath,
      converted: normalized.converted,
      transcriptId: transcript.id,
      config,
      artifacts: [
        { kind: "sensevoice_json", sourcePath: artifacts.senseVoiceJsonPath, name: `${stem}.sensevoice.json` },
        { kind: "transcript_markdown", sourcePath: artifacts.transcriptMarkdownPath, name: `${stem}.transcript.md` },
      ],
    });
    logWorker(`SenseVoice artifacts written job=${job.id} file=${file.id}`, "info", "SENSEVOICE");
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

async function runConfiguredAgentPostprocess(context: WorkerContext, job: StoredJob): Promise<StoredJobOutput[]> {
  const events = listJobEvents(context.db, job.id);
  if (events.some((event) => event.type === "agent.postprocess.completed")) {
    logWorker(`agent postprocess already completed job=${job.id}`, "info", "AGENT");
    return listActiveJobOutputs(context.db, job.id);
  }
  if (events.some((event) => event.type === "agent.postprocess.skipped")) {
    logWorker(`agent postprocess already skipped job=${job.id}`, "info", "AGENT");
    return [];
  }

  const language = readLanguageDetection(events);
  if (!language) {
    appendJobEvent(context.db, job.id, "agent.postprocess.skipped", "Language detection result is not available");
    logWorker(`agent postprocess skipped job=${job.id} reason=no_language_detection`, "warn", "AGENT");
    return [];
  }
  if (!language.translationNeeded) {
    appendJobEvent(context.db, job.id, "agent.postprocess.skipped", "Translation is not needed", {
      primaryLanguage: language.primaryLanguage,
      targetLanguage: language.targetLanguage,
      reason: language.reason,
    });
    logWorker(`agent postprocess skipped job=${job.id} reason=translation_not_needed`, "info", "AGENT");
    return [];
  }
  if (context.config.agent.provider === "none") {
    appendJobEvent(context.db, job.id, "agent.postprocess.skipped", "AGENT_POSTPROCESS_PROVIDER is none", {
      primaryLanguage: language.primaryLanguage,
      targetLanguage: language.targetLanguage,
    });
    logWorker(`agent postprocess skipped job=${job.id} reason=provider_none`, "info", "AGENT");
    return [];
  }
  if (!context.config.agent.command) {
    throw new Error("AGENT_POSTPROCESS_COMMAND is required when agent postprocess is enabled");
  }

  const bundle = mustGetSourceBundleForJob(context.db, job.id);
  const outputDir = resolveRuntimePath(context.config.runtime.runtimeDir, "agent-postprocess", job.id, "outputs");
  await fs.rm(outputDir, { recursive: true, force: true });
  const artifacts = readPreprocessedArtifacts(events);
  const originalSections = await readOriginalPdfSections(artifacts);
  const agent = context.agent ?? { postprocess: (input: AgentPostprocessInput) => runAgentPostprocess(input) };
  let result: AgentPostprocessResult;
  try {
    result = await agent.postprocess({
      command: context.config.agent.command,
      jobId: job.id,
      bundlePath: bundle.bundlePath,
      rawRoot: path.resolve(context.config.vault.obsidianVaultPath, context.config.vault.rawRoot),
      outputDir,
      projectRoot: process.env.INIT_CWD ?? process.cwd(),
      targetLanguage: context.config.translation.targetLanguage,
      defaultRelation: context.config.translation.defaultRelation,
      language,
      artifacts,
      ...(job.instructions ? { instructions: job.instructions } : {}),
      timeoutMs: context.config.agent.timeoutMs,
    });
  } catch (error) {
    appendAgentPostprocessFailedEvent(context, job, {
      error: errorMessage(error),
      reason: "agent_command_failed",
    });
    throw error;
  }

  const generatedFiles = await listGeneratedFiles(result.outputDir);
  if (generatedFiles.length === 0) {
    const error = `Agent postprocess did not create any output files: ${result.outputDir}`;
    appendAgentPostprocessFailedEvent(context, job, {
      result,
      error,
      reason: "no_output_files",
    });
    throw new Error(error);
  }

  const files = listJobFiles(context.db, job.id);
  const downloadableFiles = [
    await createDownloadableAgentFile({
      job,
      files,
      artifacts,
      originalSections,
      generatedFiles,
      outputDir: result.outputDir,
    }),
  ];

  const outputs: StoredJobOutput[] = [];
  for (const file of downloadableFiles) {
    const mimeType = inferMimeType(file.relativePath);
    outputs.push(await createRuntimeOutput({
      db: context.db,
      jobId: job.id,
      runtimeDir: context.config.runtime.runtimeDir,
      sourcePath: file.path,
      kind: "agent_translation",
      fileName: file.relativePath,
      ...(mimeType ? { mimeType } : {}),
    }));
  }
  appendJobEvent(context.db, job.id, "agent.postprocess.completed", "Agent postprocess completed", {
    provider: context.config.agent.provider,
    command: result.command,
    args: result.args,
    promptPath: result.promptPath,
    outputDir: result.outputDir,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: outputs.map((output) => ({
      outputId: output.id,
      fileName: output.fileName,
      expiresAt: output.expiresAt,
    })),
  });
  logWorker(`agent outputs registered job=${job.id} count=${outputs.length}`, "info", "OUTPUT");
  return outputs;
}

function appendAgentPostprocessFailedEvent(
  context: WorkerContext,
  job: StoredJob,
  input: {
    error: string;
    reason: string;
    result?: AgentPostprocessResult;
  },
): void {
  appendJobEvent(context.db, job.id, "agent.postprocess.failed", "Agent postprocess failed", {
    provider: context.config.agent.provider,
    reason: input.reason,
    error: input.error,
    ...(input.result
      ? {
          command: input.result.command,
          args: input.result.args,
          promptPath: input.result.promptPath,
          outputDir: input.result.outputDir,
          stdout: input.result.stdout,
          stderr: input.result.stderr,
        }
      : {}),
  });
}

function shouldUseAgentSemaphore(context: WorkerContext, job: StoredJob): boolean {
  if (context.config.agent.provider === "none" || !context.config.agent.command) {
    return false;
  }
  const events = listJobEvents(context.db, job.id);
  if (
    events.some((event) => event.type === "agent.postprocess.completed" || event.type === "agent.postprocess.skipped")
  ) {
    return false;
  }
  return readLanguageDetection(events)?.translationNeeded === true;
}

async function runPreprocessingAndLanguageCheck(context: WorkerContext, job: StoredJob): Promise<void> {
  const events = listJobEvents(context.db, job.id);
  if (events.some((event) => event.type === "language.detected")) {
    logWorker(`language check already recorded job=${job.id}`, "info", "LANGUAGE");
    return;
  }

  const bundle = mustGetSourceBundleForJob(context.db, job.id);
  const preprocessing = await collectPreprocessedTextArtifacts({
    job,
    files: listJobFiles(context.db, job.id),
    sourceBundle: bundle,
    artifactRoot: resolveRuntimePath(context.config.runtime.runtimeDir, "extracted", job.id, "preprocess"),
  });
  appendJobEvent(context.db, job.id, "preprocess.completed", "Preprocessing text collection completed", {
    artifactCount: preprocessing.artifacts.length,
    skippedCount: preprocessing.skippedFiles.length,
    artifacts: preprocessing.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      fileId: artifact.fileId,
      fileName: artifact.fileName,
      sourcePath: artifact.sourcePath,
      structurePath: artifact.structurePath,
      charCount: artifact.charCount,
      truncated: artifact.truncated,
    })),
    skippedFiles: preprocessing.skippedFiles,
  });
  logWorker(
    `text artifacts collected job=${job.id} count=${preprocessing.artifacts.length} skipped=${preprocessing.skippedFiles.length}`,
    "info",
    "PREPROCESS",
  );
  const blockingPreprocessSkip = findBlockingPreprocessSkip(preprocessing.skippedFiles);
  if (context.config.agent.provider !== "none" && blockingPreprocessSkip) {
    throw new Error(
      `Source text extraction is required for agent postprocess but failed for ${blockingPreprocessSkip.fileName}: ${blockingPreprocessSkip.reason}`,
    );
  }

  const detection = detectLanguageAcrossArtifacts(
    preprocessing.artifacts.map((artifact) => ({ id: artifact.id, text: artifact.text })),
    { targetLanguage: normalizedTranslationTargetLanguage(context.config.translation.targetLanguage) },
  );
  appendJobEvent(context.db, job.id, "language.detected", "Language and translation need checked", {
    primaryLanguage: detection.primaryLanguage,
    confidence: detection.confidence,
    translationNeeded: detection.translationNeeded,
    targetLanguage: detection.targetLanguage,
    artifactCount: detection.artifactCount,
    textCharCount: detection.textCharCount,
    signals: detection.signals,
    reason: detection.reason,
  });
  logWorker(
    `detected job=${job.id} language=${detection.primaryLanguage} confidence=${detection.confidence} translationNeeded=${detection.translationNeeded}`,
    "info",
    "LANGUAGE",
  );
}

function findBlockingPreprocessSkip(skippedFiles: Array<{ fileName: string; reason: string }>): { fileName: string; reason: string } | null {
  return skippedFiles.find((file) =>
    file.reason === "eml_no_text" ||
    file.reason === "image_ocr_failed" ||
    file.reason === "image_ocr_no_text" ||
    file.reason === "image_ocr_tool_missing" ||
    file.reason === "pdf_ocr_failed" ||
    file.reason === "pdf_ocr_no_text" ||
    file.reason === "pdf_ocr_tool_missing" ||
    file.reason === "pdf_tool_missing" ||
    file.reason === "pdf_text_extraction_failed" ||
    file.reason === "pdf_no_text"
  ) ?? null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWorker(message: string, level: "info" | "warn" = "info", tag = "GENERAL"): void {
  const normalizedTag = tag.replace(/[^A-Z0-9_-]/gi, "_").toUpperCase();
  const line = `[WORKER] ${new Date().toISOString()} [${normalizedTag}] ${message}`;
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function buildCompletionNotification(job: StoredJob, files: StoredJobFile[], outputs: StoredJobOutput[]): string {
  if (outputs.length === 0) {
    return buildJobCompletionMessage(job, files);
  }
  const hasAgentTranslation = outputs.some((output) => output.kind === "agent_translation");
  const hasTranscript = outputs.some((output) => output.kind === "stt_transcript");
  const title = hasAgentTranslation && hasTranscript
    ? "✅ 업로드한 파일의 전사/자동번역이 완료되었습니다"
    : hasTranscript
      ? "✅ 음성 전사가 완료되었습니다"
      : "✅ 업로드한 파일의 자동번역이 완료되었습니다";
  return [
    `${title}: ${job.id}${job.project ? ` (${job.project})` : ""}`,
    ...files.map((file) => `- ${file.originalName ?? file.id}`),
    "",
    "📎 결과 파일은 아래 만료 시각까지 다운로드할 수 있습니다.",
    ...outputs.map((output) => `- ${output.fileName}: ${formatKstDateTime(output.expiresAt)}`),
  ].join("\n");
}

function buildDownloadKeyboard(outputs: StoredJobOutput[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: outputs.map((output, index) => [{
      text: outputs.length === 1
        ? `⬇️ ${downloadTypeLabel(output.fileName)} 다운로드 (${formatKstCompact(output.expiresAt)}까지)`
        : `⬇️ ${index + 1}. ${truncateButtonLabel(output.fileName)} (${formatKstCompact(output.expiresAt)}까지)`,
      callback_data: `download:${output.id}`,
    }]),
  };
}

function formatKstDateTime(iso: string): string {
  const date = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`,
    "KST",
  ].join(" ");
}

function formatKstCompact(iso: string): string {
  const date = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function buildQueuedMessage(jobId: string, fileNames: string[]): string {
  return [`📥 접수했어요: ${jobId}`, ...fileNames.map((name) => `- ${name}`)].join("\n");
}

function buildSttPresetPrompt(jobId: string, files: ParsedTelegramFile[]): string {
  return [
    `🎧 음성 파일 업로드를 감지했어요: ${jobId}`,
    ...files.map((file) => `- ${file.fileName ?? file.kind}`),
    "",
    "어떤 환경에서 녹음된 파일인가요?",
    "선택값은 전사 품질 개선과 이후 번역/후처리 컨텍스트에 함께 저장됩니다.",
  ].join("\n");
}

function buildSttPresetKeyboard(jobId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: RTZR_PRESETS.map((preset) => [{
      text: `${preset.emoji} ${preset.label}`,
      callback_data: `stt:${preset.key}:${jobId}`,
    }]),
  };
}

function buildSttLanguagePrompt(jobId: string, preset: RtzrPreset): string {
  return [
    `🌐 ${preset.emoji} ${preset.label} 환경을 저장했어요: ${jobId}`,
    "",
    "어떤 언어로 인식할까요?",
    "언어 선택에 따라 리턴제로 모델을 자동으로 분기합니다.",
  ].join("\n");
}

function buildSttLanguageKeyboard(jobId: string, presetKey: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      STT_LANGUAGE_PRESETS.slice(0, 3).map((language) => ({
        text: `${language.emoji} ${language.label}`,
        callback_data: `stt-lang:${presetKey}:${language.key}:${jobId}`,
      })),
      STT_LANGUAGE_PRESETS.slice(3).map((language) => ({
        text: `${language.emoji} ${language.label}`,
        callback_data: `stt-lang:${presetKey}:${language.key}:${jobId}`,
      })),
    ],
  };
}

function buildRetryKeyboard(jobId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: "🔁 다시 처리",
      callback_data: `retry:${jobId}`,
    }]],
  };
}

function buildPresetQueuedMessage(jobId: string, preset: RtzrPreset, language: SttLanguagePreset): string {
  return [
    `✅ ${preset.emoji} ${preset.label} / ${language.emoji} ${language.label} 설정을 저장했어요.`,
    `📥 처리 대기열에 넣었습니다: ${jobId}`,
  ].join("\n");
}

function buildRtzrTranscribeConfig(preset: RtzrPreset, language: SttLanguagePreset): RtzrTranscribeConfig {
  return {
    ...preset.config,
    model_name: language.rtzrModelName,
    language: language.rtzrLanguage,
    ...(language.rtzrLanguageCandidates ? { language_candidates: language.rtzrLanguageCandidates } : {}),
  };
}

function selectedRtzrConfig(events: StoredJobEvent[]): RtzrTranscribeConfig {
  const selected = selectedSttPresetEvent(events);
  if (!selected || !isRecord(selected.data) || !isRecord(selected.data.rtzrConfig)) {
    return {};
  }
  return selected.data.rtzrConfig as RtzrTranscribeConfig;
}

function selectedSenseVoiceConfig(config: AppConfig, events: StoredJobEvent[]): SenseVoiceTranscribeOptions {
  const selected = selectedSttPresetEvent(events);
  if (selected && isRecord(selected.data) && isRecord(selected.data.sensevoiceConfig)) {
    return selected.data.sensevoiceConfig as unknown as SenseVoiceTranscribeOptions;
  }
  return buildSenseVoiceTranscribeOptions(config);
}

function buildSenseVoiceTranscribeOptions(config: AppConfig, language?: SttLanguagePreset): SenseVoiceTranscribeOptions {
  return {
    pythonPath: resolveProjectRelativePath(config.sensevoice.pythonPath),
    scriptPath: resolveProjectRelativePath(config.sensevoice.scriptPath),
    model: config.sensevoice.model,
    device: config.sensevoice.device,
    language: language?.sensevoiceLanguage ?? config.sensevoice.language,
    useItn: config.sensevoice.useItn,
    batchSizeSeconds: config.sensevoice.batchSizeSeconds,
    mergeVad: config.sensevoice.mergeVad,
    mergeLengthSeconds: config.sensevoice.mergeLengthSeconds,
    maxSingleSegmentTimeMs: config.sensevoice.maxSingleSegmentTimeMs,
    timeoutMs: config.sensevoice.timeoutMs,
    ...(config.sensevoice.vadModel ? { vadModel: config.sensevoice.vadModel } : {}),
    ...(config.sensevoice.torchNumThreads !== undefined ? { torchNumThreads: config.sensevoice.torchNumThreads } : {}),
  };
}

function buildRtzrWaitOptions(config: AppConfig): WaitForTranscriptionOptions {
  return {
    pollIntervalMs: config.rtzr.pollIntervalMs,
    timeoutMs: config.rtzr.timeoutMs,
    rateLimitBackoffMs: config.rtzr.rateLimitBackoffMs,
  };
}

function collectExtractedArtifacts(events: StoredJobEvent[]): RawBundleArtifactInput[] {
  return events.flatMap((event) => {
    if (!isTranscriptionEvent(event.type) || !isRecord(event.data) || !Array.isArray(event.data.artifacts)) {
      return [];
    }
    const data = event.data;
    const artifacts = data.artifacts;
    if (!Array.isArray(artifacts)) {
      return [];
    }
    return artifacts.flatMap((artifact: unknown) => {
      if (!isRecord(artifact) || typeof artifact.sourcePath !== "string") {
        return [];
      }
      const result: RawBundleArtifactInput = {
        sourcePath: artifact.sourcePath,
      };
      if (typeof artifact.name === "string") {
        result.name = artifact.name;
      }
      if (typeof artifact.kind === "string") {
        result.kind = artifact.kind;
      }
      if (typeof data.fileId === "string") {
        result.sourceFileId = data.fileId;
      }
      return [result];
    });
  });
}

async function registerTranscriptOutputs(context: WorkerContext, job: StoredJob): Promise<StoredJobOutput[]> {
  const events = listJobEvents(context.db, job.id);
  const registeredSources = new Set(
    events.flatMap((event) => {
      if (event.type !== "stt.transcript_output_registered" || !isRecord(event.data) || typeof event.data.sourcePath !== "string") {
        return [];
      }
      return [path.resolve(event.data.sourcePath)];
    }),
  );
  const existingOutputNames = new Set(
    listJobOutputs(context.db, job.id)
      .filter((output) => output.kind === "stt_transcript" && !output.deletedAt)
      .map((output) => output.fileName),
  );
  const outputs: StoredJobOutput[] = [];

  for (const artifact of collectTranscriptOutputCandidates(events)) {
    const sourcePath = path.resolve(artifact.sourcePath);
    if (
      registeredSources.has(sourcePath)
      || existingOutputNames.has(artifact.fileName)
      || existingOutputNames.has(buildTranscriptOutputFileName(artifact.fileName))
    ) {
      continue;
    }
    try {
      await fs.access(sourcePath);
    } catch {
      appendJobEvent(context.db, job.id, "stt.transcript_output_skipped", artifact.fileName, {
        provider: artifact.provider,
        sourcePath,
        reason: "source_missing",
      });
      continue;
    }
    const downloadSource = await createTranscriptDownloadSource(context, job, artifact);
    const output = await createRuntimeOutput({
      db: context.db,
      jobId: job.id,
      runtimeDir: context.config.runtime.runtimeDir,
      sourcePath: downloadSource.sourcePath,
      kind: "stt_transcript",
      fileName: downloadSource.fileName,
      mimeType: downloadSource.mimeType,
    });
    appendJobEvent(context.db, job.id, "stt.transcript_output_registered", artifact.fileName, {
      provider: artifact.provider,
      sourcePath,
      renderedPath: downloadSource.sourcePath,
      format: downloadSource.format,
      outputId: output.id,
      fileName: output.fileName,
      expiresAt: output.expiresAt,
    });
    registeredSources.add(sourcePath);
    existingOutputNames.add(output.fileName);
    outputs.push(output);
  }

  return outputs;
}

interface TranscriptOutputCandidate {
  provider: string;
  sourcePath: string;
  fileName: string;
}

interface TranscriptDownloadSource {
  sourcePath: string;
  fileName: string;
  mimeType: string;
  format: "docx" | "markdown";
}

async function createTranscriptDownloadSource(
  context: WorkerContext,
  job: StoredJob,
  artifact: TranscriptOutputCandidate,
): Promise<TranscriptDownloadSource> {
  const pandocBin = await findExecutable(process.env.PANDOC_BIN, "pandoc");
  if (!pandocBin) {
    appendJobEvent(context.db, job.id, "stt.transcript_docx_skipped", artifact.fileName, {
      provider: artifact.provider,
      sourcePath: artifact.sourcePath,
      reason: "pandoc_missing",
    });
    logWorker(`transcript docx render skipped job=${job.id} reason=missing_tool pandoc=missing source=${artifact.fileName}`, "warn", "OUTPUT");
    return {
      sourcePath: artifact.sourcePath,
      fileName: artifact.fileName,
      mimeType: "text/markdown",
      format: "markdown",
    };
  }

  const renderDir = resolveRuntimePath(context.config.runtime.runtimeDir, "rendered-transcripts", job.id);
  await fs.mkdir(renderDir, { recursive: true });
  const docxName = buildTranscriptOutputFileName(artifact.fileName);
  const markdownPath = path.join(renderDir, `${path.parse(docxName).name}.md`);
  const docxPath = path.join(renderDir, docxName);
  const transcriptMarkdown = await fs.readFile(artifact.sourcePath, "utf8");
  await fs.writeFile(markdownPath, renderTranscriptDownloadMarkdown(job, transcriptMarkdown), "utf8");

  try {
    await execFileAsync(pandocBin, [
      markdownPath,
      "--from",
      "markdown+raw_tex",
      "--to",
      "docx",
      "--output",
      docxPath,
    ], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    await normalizeDocxOutputFormatting(docxPath);
    await validateDocxOutput(docxPath);
    return {
      sourcePath: docxPath,
      fileName: docxName,
      mimeType: DOCX_MIME_TYPE,
      format: "docx",
    };
  } catch (error) {
    appendJobEvent(context.db, job.id, "stt.transcript_docx_failed", artifact.fileName, {
      provider: artifact.provider,
      sourcePath: artifact.sourcePath,
      docxPath,
      error: errorMessage(error),
    });
    logWorker(`transcript docx render failed job=${job.id} source=${artifact.fileName} error=${errorMessage(error)}`, "warn", "OUTPUT");
    return {
      sourcePath: artifact.sourcePath,
      fileName: artifact.fileName,
      mimeType: "text/markdown",
      format: "markdown",
    };
  }
}

function renderTranscriptDownloadMarkdown(job: StoredJob, transcriptMarkdown: string): string {
  return [
    formatOutputJobMetadata(job),
    "",
    normalizeMarkdownText(transcriptMarkdown),
    "",
  ].join("\n");
}

function buildTranscriptOutputFileName(transcriptFileName: string): string {
  const parsed = path.parse(path.basename(transcriptFileName).replace(/\u0000/g, ""));
  const stem = sanitizeOutputFileStem(parsed.name.replace(/\.transcript$/i, "") || parsed.name || "transcript");
  return `${stem}_transcript.docx`;
}

function collectTranscriptOutputCandidates(events: StoredJobEvent[]): TranscriptOutputCandidate[] {
  return events.flatMap((event) => {
    if (!isTranscriptionEvent(event.type) || !isRecord(event.data) || !Array.isArray(event.data.artifacts)) {
      return [];
    }
    const provider = event.type === "sensevoice.transcribed" ? "sensevoice" : "rtzr";
    return event.data.artifacts.flatMap((artifact) => {
      if (!isRecord(artifact) || typeof artifact.sourcePath !== "string") {
        return [];
      }
      const kind = typeof artifact.kind === "string" ? artifact.kind : "";
      const name = typeof artifact.name === "string" ? artifact.name : path.basename(artifact.sourcePath);
      if (kind !== "transcript_markdown" && !name.toLowerCase().endsWith(".transcript.md")) {
        return [];
      }
      return [{ provider, sourcePath: artifact.sourcePath, fileName: name }];
    });
  });
}

function parseSttEnvironmentCallbackData(data: string | undefined): { presetKey: string; jobId: string } | null {
  const match = /^(?:rtzr|stt):([a-z0-9_-]+):(.+)$/.exec(data ?? "");
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { presetKey: match[1], jobId: match[2] };
}

function parseSttLanguageCallbackData(data: string | undefined): { presetKey: string; languageKey: string; jobId: string } | null {
  const match = /^stt-lang:([a-z0-9_-]+):([a-z0-9_-]+):(.+)$/.exec(data ?? "");
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return { presetKey: match[1], languageKey: match[2], jobId: match[3] };
}

function parseRetryCallbackData(data: string | undefined): { jobId: string } | null {
  const match = /^retry:(.+)$/.exec(data ?? "");
  if (!match?.[1]) {
    return null;
  }
  return { jobId: match[1] };
}

function parseDownloadCallbackData(data: string | undefined): { outputId: string } | null {
  const match = /^download:([a-zA-Z0-9._-]+)$/.exec(data ?? "");
  if (!match?.[1]) {
    return null;
  }
  return { outputId: match[1] };
}

function parseOutputDiscardCallbackData(data: string | undefined): { outputId: string } | null {
  const match = /^output-discard:([a-zA-Z0-9._-]+)$/.exec(data ?? "");
  if (!match?.[1]) {
    return null;
  }
  return { outputId: match[1] };
}

function parseOutputRegenerateCallbackData(data: string | undefined): { outputId: string } | null {
  const match = /^output-regenerate:([a-zA-Z0-9._-]+)$/.exec(data ?? "");
  if (!match?.[1]) {
    return null;
  }
  return { outputId: match[1] };
}

function selectedSttPresetEvent(events: StoredJobEvent[]): StoredJobEvent | undefined {
  return [...events].reverse().find((event) => event.type === "stt.preset_selected" || event.type === "rtzr.preset_selected");
}

function isTranscriptionEvent(type: string): boolean {
  return type === "rtzr.transcribed" || type === "sensevoice.transcribed";
}

function hasAudioOrVoice(files: ParsedTelegramFile[]): boolean {
  return files.some((file) => isAudioParsedFile(file));
}

function isAudioParsedFile(file: ParsedTelegramFile): boolean {
  if (file.kind === "audio" || file.kind === "voice") {
    return true;
  }
  const mimeType = file.mimeType?.toLowerCase();
  if (mimeType?.startsWith("audio/")) {
    return true;
  }
  const extension = path.extname(file.fileName ?? "").toLowerCase();
  return [".mp4", ".m4a", ".mp3", ".amr", ".flac", ".wav", ".ogg", ".opus"].includes(extension);
}

function isAudioJobFile(file: StoredJobFile): boolean {
  const mimeType = file.mimeType?.toLowerCase();
  if (mimeType?.startsWith("audio/")) {
    return true;
  }
  if (file.id.includes("_audio_") || file.id.includes("_voice_")) {
    return true;
  }
  const extension = path.extname(file.originalName ?? "").toLowerCase();
  return [".mp4", ".m4a", ".mp3", ".amr", ".flac", ".wav", ".ogg", ".opus"].includes(extension);
}

function artifactStem(value: string): string {
  const baseName = path.basename(value, path.extname(value));
  const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  return sanitized.length > 0 ? sanitized.slice(0, 120) : "audio";
}

function normalizedTranslationTargetLanguage(value: string): Exclude<DetectedLanguage, "mixed" | "unknown"> {
  return value === "en" || value === "zh" || value === "ja" ? value : "ko";
}

function readLanguageDetection(events: StoredJobEvent[]): AgentPostprocessInput["language"] | null {
  const event = [...events].reverse().find((candidate) => candidate.type === "language.detected");
  if (!event || !isRecord(event.data)) {
    return null;
  }
  const data = event.data;
  if (typeof data.primaryLanguage !== "string" || typeof data.translationNeeded !== "boolean") {
    return null;
  }
  return {
    primaryLanguage: data.primaryLanguage,
    confidence: typeof data.confidence === "number" ? data.confidence : 0,
    translationNeeded: data.translationNeeded,
    targetLanguage: typeof data.targetLanguage === "string" ? data.targetLanguage : "ko",
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
  };
}

function readPreprocessedArtifacts(events: StoredJobEvent[]): AgentPostprocessInput["artifacts"] {
  const event = [...events].reverse().find((candidate) => candidate.type === "preprocess.completed");
  if (!event || !isRecord(event.data) || !Array.isArray(event.data.artifacts)) {
    return [];
  }
  return event.data.artifacts.flatMap((artifact): AgentPostprocessInput["artifacts"] => {
    if (!isRecord(artifact) || typeof artifact.id !== "string" || typeof artifact.sourcePath !== "string") {
      return [];
    }
    const result: AgentPostprocessInput["artifacts"][number] = {
      id: artifact.id,
      kind: typeof artifact.kind === "string" ? artifact.kind : "unknown",
      fileName: typeof artifact.fileName === "string" ? artifact.fileName : artifact.id,
      sourcePath: artifact.sourcePath,
      charCount: typeof artifact.charCount === "number" ? artifact.charCount : 0,
      truncated: typeof artifact.truncated === "boolean" ? artifact.truncated : false,
    };
    if (typeof artifact.structurePath === "string") {
      result.structurePath = artifact.structurePath;
    }
    return [result];
  });
}

interface GeneratedFile {
  path: string;
  relativePath: string;
}

interface PdfTextSection {
  title: string;
  text: string;
}

type DocumentSourceKind = "docx" | "eml" | "hwp" | "pdf";

interface DocumentSourceFile {
  kind: DocumentSourceKind;
  path: string;
  fileName: string;
}

interface ImageSourceFile {
  path: string;
  fileName: string;
}

interface ImageOcrBlock {
  id: string;
  text: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence?: number;
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageOverlayBox {
  rect: PdfRect;
  text: string;
  padding: number;
  fontSize: number;
  lineHeight: number;
}

const WORD_TABLE_BORDERS_XML = '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/></w:tblBorders>';
const WORD_TABLE_CELL_MARGINS_XML = '<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>';
const WORD_TABLE_HEADER_SHADING_XML = '<w:shd w:val="clear" w:fill="D9EAF7"/>';

function listActiveJobOutputs(db: DatabaseSync, jobId: string): StoredJobOutput[] {
  const now = new Date().toISOString();
  return listJobOutputs(db, jobId).filter((output) => !output.deletedAt && output.expiresAt > now);
}

function getOutputCallbackAccess(
  context: WorkerContext,
  callback: ParsedTelegramCallback,
  outputId: string,
): { output: StoredJobOutput; job: StoredJob; error?: never } | { error: string; output?: never; job?: never } {
  const output = getJobOutput(context.db, outputId);
  if (!output) {
    return { error: "⚠️ 결과 파일을 찾을 수 없습니다." };
  }
  const job = getJob(context.db, output.jobId);
  if (!job) {
    return { error: "⚠️ 원본 작업을 찾을 수 없습니다." };
  }
  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    return { error: "🔒 이 결과 파일을 변경할 권한이 없습니다." };
  }
  return { output, job };
}

async function createDownloadableAgentFile(input: {
  job: StoredJob;
  files: StoredJobFile[];
  artifacts: AgentPostprocessInput["artifacts"];
  originalSections: PdfTextSection[];
  generatedFiles: GeneratedFile[];
  outputDir: string;
}): Promise<GeneratedFile> {
  let downloadableFile: GeneratedFile;
  const documentSource = findDocumentSourceFile(input.files);
  if (documentSource) {
    const documentOutput = await createDocumentTranslationDocx({
      job: input.job,
      artifacts: input.artifacts,
      originalSections: input.originalSections,
      generatedFiles: input.generatedFiles,
      documentSource,
      outputDir: input.outputDir,
    });
    if (documentOutput) {
      downloadableFile = documentOutput;
      await removeIntermediateGeneratedFiles(input.outputDir, input.generatedFiles, downloadableFile.path);
      return downloadableFile;
    }
  }

  const imageSource = findImageSourceFile(input.files);
  if (imageSource) {
    const imageOutput = await createImageOverlayTranslationPdf({
      job: input.job,
      artifacts: input.artifacts,
      generatedFiles: input.generatedFiles,
      outputDir: input.outputDir,
      imageSource,
    });
    if (imageOutput) {
      downloadableFile = imageOutput;
      await removeIntermediateGeneratedFiles(input.outputDir, input.generatedFiles, downloadableFile.path);
      return downloadableFile;
    }
  }

  downloadableFile = await createOriginalAndTranslationPdf({
    job: input.job,
    artifacts: input.artifacts,
    originalSections: input.originalSections,
    generatedFiles: input.generatedFiles,
    outputDir: input.outputDir,
    sourceFileName: primaryOutputSourceFileName(input.files, input.job),
  });
  await removeIntermediateGeneratedFiles(input.outputDir, input.generatedFiles, downloadableFile.path);
  return downloadableFile;
}

async function createOriginalAndTranslationPdf(input: {
  job: StoredJob;
  artifacts: AgentPostprocessInput["artifacts"];
  originalSections: PdfTextSection[];
  generatedFiles: GeneratedFile[];
  outputDir: string;
  sourceFileName: string;
}): Promise<GeneratedFile> {
  const translationFile = findTranslationFile(input.generatedFiles);
  if (!translationFile) {
    throw new Error(`Agent postprocess did not create translated markdown/text output in ${input.outputDir}`);
  }

  const [translationText, fontPath] = await Promise.all([
    fs.readFile(translationFile.path, "utf8"),
    findPdfFontPath(),
  ]);
  const pdfName = buildTranslatedOutputFileName(input.sourceFileName, ".pdf");
  const pdfPath = path.join(input.outputDir, pdfName);

  await writeOriginalAndTranslationPdf({
    pdfPath,
    job: input.job,
    originalSections: input.originalSections,
    translation: {
      title: path.basename(translationFile.relativePath),
      text: translationText,
    },
    fontPath,
  });
  return {
    path: pdfPath,
    relativePath: path.basename(pdfPath),
  };
}

async function createImageOverlayTranslationPdf(input: {
  job: StoredJob;
  artifacts: AgentPostprocessInput["artifacts"];
  generatedFiles: GeneratedFile[];
  outputDir: string;
  imageSource: ImageSourceFile;
}): Promise<GeneratedFile | null> {
  const translationFile = findTranslationFile(input.generatedFiles);
  const translationsFile = findDocxTranslationsFile(input.generatedFiles);
  const structureArtifact = input.artifacts.find((artifact) =>
    artifact.kind === "image_ocr_text" && typeof artifact.structurePath === "string");
  if (!translationFile || !translationsFile || !structureArtifact?.structurePath) {
    return null;
  }

  const pdfName = buildTranslatedOutputFileName(input.imageSource.fileName, ".pdf");
  const pdfPath = path.join(input.outputDir, pdfName);
  try {
    const [supportSections, translations, blocks, fontPath] = await Promise.all([
      readTemplatePreservedSupportSections(translationFile.path),
      readDocxBlockTranslations(translationsFile.path),
      readImageOcrBlocks(structureArtifact.structurePath),
      findPdfFontPath(),
    ]);
    if (blocks.length === 0 || translations.size === 0) {
      return null;
    }
    await writeImageOverlayPdf({
      pdfPath,
      job: input.job,
      imageSource: input.imageSource,
      blocks,
      translations,
      supportSections,
      fontPath,
    });
    logWorker(`image overlay render complete job=${input.job.id} source=${input.imageSource.fileName}`, "info", "OUTPUT");
    return {
      path: pdfPath,
      relativePath: pdfName,
    };
  } catch (error) {
    logWorker(`image overlay render failed job=${input.job.id} source=${input.imageSource.fileName} error=${errorMessage(error)}`, "warn", "OUTPUT");
    return null;
  }
}

function findDocumentSourceFile(files: StoredJobFile[]): DocumentSourceFile | null {
  for (const file of files) {
    const candidatePath = file.archivePath ?? file.localPath;
    if (!candidatePath) {
      continue;
    }
    const fileName = file.originalName ?? path.basename(candidatePath);
    const extension = path.extname(fileName).toLowerCase();
    const mimeType = file.mimeType?.toLowerCase();
    if (extension === ".docx" || mimeType === DOCX_MIME_TYPE) {
      return {
        kind: "docx",
        path: candidatePath,
        fileName,
      };
    }
    if (extension === ".eml" || (mimeType && EML_MIME_TYPES.has(mimeType))) {
      return {
        kind: "eml",
        path: candidatePath,
        fileName,
      };
    }
    if (extension === ".hwp" || extension === ".hwpx" || mimeType?.includes("hwp") || mimeType?.includes("hwpx")) {
      return {
        kind: "hwp",
        path: candidatePath,
        fileName,
      };
    }
    if (extension === ".pdf" || mimeType === "application/pdf") {
      return {
        kind: "pdf",
        path: candidatePath,
        fileName,
      };
    }
  }
  return null;
}

function findImageSourceFile(files: StoredJobFile[]): ImageSourceFile | null {
  for (const file of files) {
    const candidatePath = file.archivePath ?? file.localPath;
    if (!candidatePath) {
      continue;
    }
    const fileName = file.originalName ?? path.basename(candidatePath);
    const extension = path.extname(fileName).toLowerCase();
    const mimeType = file.mimeType?.toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension) || (mimeType !== undefined && IMAGE_MIME_TYPES.has(mimeType))) {
      return {
        path: candidatePath,
        fileName,
      };
    }
  }
  return null;
}

async function createDocumentTranslationDocx(input: {
  job: StoredJob;
  artifacts: AgentPostprocessInput["artifacts"];
  originalSections: PdfTextSection[];
  generatedFiles: GeneratedFile[];
  documentSource: DocumentSourceFile;
  outputDir: string;
}): Promise<GeneratedFile | null> {
  const translationFile = findTranslationFile(input.generatedFiles);
  if (!translationFile) {
    throw new Error(`Agent postprocess did not create translated markdown/text output in ${input.outputDir}`);
  }

  const workDir = path.join(path.dirname(input.outputDir), ".render-work");
  const translationMarkdownPath = path.join(workDir, "translation.md");
  const fallbackMarkdownPath = path.join(workDir, "original-and-translated.md");
  const docxName = buildTranslatedOutputFileName(input.documentSource.fileName, ".docx");
  const docxPath = path.join(input.outputDir, docxName);
  const translatedOnlyDocxPath = path.join(workDir, docxName);
  await fs.mkdir(workDir, { recursive: true });
  const translationsFile = findDocxTranslationsFile(input.generatedFiles);
  if (input.documentSource.kind === "docx" && translationsFile) {
    try {
      await createTemplatePreservedDocx({
        job: input.job,
        originalDocxPath: input.documentSource.path,
        translationsPath: translationsFile.path,
        supportMarkdownPath: translationFile.path,
        workDir,
        outputPath: docxPath,
      });
      await validateDocxOutput(docxPath);
      logWorker(`template-preserved docx render complete job=${input.job.id} source=${input.documentSource.fileName}`, "info", "OUTPUT");
      return {
        path: docxPath,
        relativePath: docxName,
      };
    } catch (error) {
      logWorker(`template-preserved docx render failed job=${input.job.id} source=${input.documentSource.fileName} error=${errorMessage(error)}`, "warn", "OUTPUT");
    }
  }

  const pandocBin = await findExecutable(process.env.PANDOC_BIN, "pandoc");
  if (!pandocBin) {
    logWorker(
      `document render skipped job=${input.job.id} reason=missing_tool pandoc=missing source=${input.documentSource.fileName}`,
      "warn",
      "OUTPUT",
    );
    return await copyGeneratedFileWithTranslatedName(
      translationFile.path,
      input.outputDir,
      buildTranslatedOutputFileName(input.documentSource.fileName, path.extname(translationFile.relativePath) || ".md"),
    );
  }

  const translationText = await fs.readFile(translationFile.path, "utf8");
  await fs.writeFile(translationMarkdownPath, renderTranslationOnlyMarkdown({
    job: input.job,
    translation: {
      title: path.basename(translationFile.relativePath),
      text: translationText,
    },
  }), "utf8");
  await fs.writeFile(fallbackMarkdownPath, renderOriginalAndTranslationMarkdown({
    job: input.job,
    originalSections: input.originalSections,
    translation: {
      title: path.basename(translationFile.relativePath),
      text: translationText,
    },
  }), "utf8");
  try {
    const args = [
      translationMarkdownPath,
      "--from",
      "markdown+raw_tex",
      "--to",
      "docx",
      "--output",
      translatedOnlyDocxPath,
    ];
    if (input.documentSource.kind === "docx") {
      args.push("--reference-doc", input.documentSource.path);
    }
    await execFileAsync(pandocBin, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    await normalizeDocxOutputFormatting(translatedOnlyDocxPath);
    try {
      if (input.documentSource.kind === "docx") {
        await appendOriginalDocxSection({
          translatedDocxPath: translatedOnlyDocxPath,
          originalDocxPath: input.documentSource.path,
          outputPath: docxPath,
        });
      } else if (input.documentSource.kind === "pdf") {
        await appendOriginalPdfPageImagesDocxSection({
          translatedDocxPath: translatedOnlyDocxPath,
          pdfPath: input.documentSource.path,
          workDir,
          outputPath: docxPath,
        });
      } else {
        await appendOriginalTextDocxSection({
          translatedDocxPath: translatedOnlyDocxPath,
          originalSections: input.originalSections,
          outputPath: docxPath,
        });
      }
    } catch (error) {
      logWorker(`docx source append failed job=${input.job.id} source=${input.documentSource.fileName} error=${errorMessage(error)}`, "warn", "OUTPUT");
      await renderCombinedMarkdownDocx({
        pandocBin,
        markdownPath: fallbackMarkdownPath,
        outputPath: docxPath,
        documentSource: input.documentSource,
      });
      await normalizeDocxOutputFormatting(docxPath);
    }
    await validateDocxOutput(docxPath);
    logWorker(`document render complete job=${input.job.id} source=${input.documentSource.fileName}`, "info", "OUTPUT");
    return {
      path: docxPath,
      relativePath: docxName,
    };
  } catch (error) {
    logWorker(`document render failed job=${input.job.id} source=${input.documentSource.fileName} error=${errorMessage(error)}`, "warn", "OUTPUT");
    return await copyGeneratedFileWithTranslatedName(
      translationFile.path,
      input.outputDir,
      buildTranslatedOutputFileName(input.documentSource.fileName, path.extname(translationFile.relativePath) || ".md"),
    );
  }
}

async function renderCombinedMarkdownDocx(input: {
  pandocBin: string;
  markdownPath: string;
  outputPath: string;
  documentSource: DocumentSourceFile;
}): Promise<void> {
  const args = [
    input.markdownPath,
    "--from",
    "markdown+raw_tex",
    "--to",
    "docx",
    "--output",
    input.outputPath,
  ];
  if (input.documentSource.kind === "docx") {
    args.push("--reference-doc", input.documentSource.path);
  }
  await execFileAsync(input.pandocBin, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function createTemplatePreservedDocx(input: {
  job: StoredJob;
  originalDocxPath: string;
  translationsPath: string;
  supportMarkdownPath: string;
  workDir: string;
  outputPath: string;
}): Promise<void> {
  const [entries, translations, supportSections] = await Promise.all([
    readZipEntries(input.originalDocxPath),
    readDocxBlockTranslations(input.translationsPath),
    readTemplatePreservedSupportSections(input.supportMarkdownPath),
  ]);
  const originalDocument = entries.get("word/document.xml");
  if (!originalDocument) {
    throw new Error("DOCX document.xml is missing");
  }
  const translatedXml = insertTemplateSupportSections(
    applyBlockTranslationsToWordDocumentXml(originalDocument.toString("utf8"), translations),
    supportSections,
    formatOutputJobMetadata(input.job),
  );
  entries.set("word/document.xml", Buffer.from(translatedXml, "utf8"));
  const translatedOnlyPath = path.join(input.workDir, "template-preserved-translated.docx");
  await writeZipEntries(translatedOnlyPath, entries);
  await appendOriginalDocxSection({
    translatedDocxPath: translatedOnlyPath,
    originalDocxPath: input.originalDocxPath,
    outputPath: input.outputPath,
  });
}

async function validateDocxOutput(filePath: string): Promise<void> {
  const entries = await readZipEntries(filePath);
  if (!entries.has("[Content_Types].xml") || !entries.has("word/document.xml")) {
    throw new Error("Rendered DOCX is missing required package entries");
  }
}

async function normalizeDocxOutputFormatting(filePath: string): Promise<void> {
  const entries = await readZipEntries(filePath);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) {
    throw new Error("Rendered DOCX is missing word/document.xml");
  }
  const xml = documentXml.toString("utf8");
  const normalized = normalizeWordOutputFormatting(xml);
  if (normalized === xml) {
    return;
  }
  entries.set("word/document.xml", Buffer.from(normalized, "utf8"));
  await writeZipEntries(filePath, entries);
}

function normalizeWordOutputFormatting(xml: string): string {
  return normalizeWordJobMetadataFormatting(normalizeWordTableFormatting(xml));
}

function normalizeWordTableFormatting(xml: string): string {
  return xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/g, (tableXml) =>
    shadeFirstWordTableRow(ensureWordTableProperties(tableXml)));
}

function normalizeWordJobMetadataFormatting(xml: string): string {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const text = extractWordParagraphText(paragraphXml).trim();
    return isOutputJobMetadataLine(text) ? renderJobMetadataWordXml(text) : paragraphXml;
  });
}

function ensureWordTableProperties(tableXml: string): string {
  const tableProperties = [
    '<w:tblW w:w="9360" w:type="dxa"/>',
    WORD_TABLE_BORDERS_XML,
    WORD_TABLE_CELL_MARGINS_XML,
  ].join("");
  if (!/<w:tblPr\b/.test(tableXml)) {
    return tableXml.replace(/(<w:tbl\b[^>]*>)/, `$1<w:tblPr>${tableProperties}</w:tblPr>`);
  }
  return tableXml.replace(/<w:tblPr\b[^>]*>[\s\S]*?<\/w:tblPr>/, (tblPr) => {
    let normalized = tblPr;
    if (!/<w:tblW\b/.test(normalized)) {
      normalized = normalized.replace(/(<w:tblPr\b[^>]*>)/, '$1<w:tblW w:w="9360" w:type="dxa"/>');
    }
    if (!/<w:tblBorders\b/.test(normalized)) {
      normalized = normalized.replace("</w:tblPr>", `${WORD_TABLE_BORDERS_XML}</w:tblPr>`);
    }
    if (!/<w:tblCellMar\b/.test(normalized)) {
      normalized = normalized.replace("</w:tblPr>", `${WORD_TABLE_CELL_MARGINS_XML}</w:tblPr>`);
    }
    return normalized;
  });
}

function shadeFirstWordTableRow(tableXml: string): string {
  return tableXml.replace(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/, (rowXml) =>
    rowXml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, shadeWordTableHeaderCell));
}

function shadeWordTableHeaderCell(cellXml: string): string {
  if (/<w:shd\b/.test(cellXml)) {
    return cellXml;
  }
  if (/<w:tcPr\b/.test(cellXml)) {
    return cellXml.replace(/<w:tcPr\b[^>]*>[\s\S]*?<\/w:tcPr>/, (tcPr) =>
      tcPr.replace("</w:tcPr>", `${WORD_TABLE_HEADER_SHADING_XML}</w:tcPr>`));
  }
  return cellXml.replace(/(<w:tc\b[^>]*>)/, `$1<w:tcPr>${WORD_TABLE_HEADER_SHADING_XML}</w:tcPr>`);
}

async function copyGeneratedFileWithTranslatedName(sourcePath: string, outputDir: string, fileName: string): Promise<GeneratedFile> {
  const destinationPath = path.join(outputDir, fileName);
  if (path.resolve(sourcePath) !== path.resolve(destinationPath)) {
    await fs.copyFile(sourcePath, destinationPath);
  }
  return {
    path: destinationPath,
    relativePath: fileName,
  };
}

function findDocxTranslationsFile(files: GeneratedFile[]): GeneratedFile | null {
  const sorted = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return sorted.find((file) => file.relativePath.toLowerCase() === "translations.json") ?? null;
}

function renderTranslationOnlyMarkdown(input: {
  job: StoredJob;
  translation: PdfTextSection;
}): string {
  return [
    formatOutputJobMetadata(input.job),
    "",
    normalizeMarkdownText(input.translation.text),
    "",
  ].join("\n");
}

function renderOriginalAndTranslationMarkdown(input: {
  job: StoredJob;
  originalSections: PdfTextSection[];
  translation: PdfTextSection;
}): string {
  const lines = [
    formatOutputJobMetadata(input.job),
    "",
    normalizeMarkdownText(input.translation.text),
    "",
    "\\newpage",
    "",
    "# [원문]",
    "",
  ];
  for (const section of input.originalSections) {
    lines.push(`## ${section.title}`, "", preserveOriginalText(section.text), "");
  }
  return lines.join("\n");
}

function formatOutputJobMetadata(job: Pick<StoredJob, "id">, iso = new Date().toISOString()): string {
  return `Job: ${job.id} (${formatKstDateTime(iso)})`;
}

function normalizeMarkdownText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function preserveOriginalText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

async function appendOriginalDocxSection(input: {
  translatedDocxPath: string;
  originalDocxPath: string;
  outputPath: string;
}): Promise<void> {
  const [translatedEntries, originalEntries] = await Promise.all([
    readZipEntries(input.translatedDocxPath),
    readZipEntries(input.originalDocxPath),
  ]);
  const translatedDocument = translatedEntries.get("word/document.xml");
  const originalDocument = originalEntries.get("word/document.xml");
  if (!translatedDocument || !originalDocument) {
    throw new Error("DOCX document.xml is missing");
  }
  translatedEntries.set(
    "word/document.xml",
    Buffer.from(
      appendOriginalDocumentXml(translatedDocument.toString("utf8"), originalDocument.toString("utf8")),
      "utf8",
    ),
  );
  await writeZipEntries(input.outputPath, translatedEntries);
}

async function appendOriginalTextDocxSection(input: {
  translatedDocxPath: string;
  originalSections: PdfTextSection[];
  outputPath: string;
}): Promise<void> {
  const translatedEntries = await readZipEntries(input.translatedDocxPath);
  const translatedDocument = translatedEntries.get("word/document.xml");
  if (!translatedDocument) {
    throw new Error("DOCX document.xml is missing");
  }
  translatedEntries.set(
    "word/document.xml",
    Buffer.from(
      appendOriginalTextSectionsDocumentXml(translatedDocument.toString("utf8"), input.originalSections),
      "utf8",
    ),
  );
  await writeZipEntries(input.outputPath, translatedEntries);
}

async function appendOriginalPdfPageImagesDocxSection(input: {
  translatedDocxPath: string;
  pdfPath: string;
  workDir: string;
  outputPath: string;
}): Promise<void> {
  const imageDir = path.join(input.workDir, "original-pdf-pages");
  const pages = await renderPdfPagesAsImages({
    pdfPath: input.pdfPath,
    outputDir: imageDir,
  });
  if (pages.length === 0) {
    throw new Error("PDF original page rendering produced no images");
  }

  const entries = await readZipEntries(input.translatedDocxPath);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) {
    throw new Error("DOCX document.xml is missing");
  }
  const embeddedPages = await embedDocxImages(entries, pages);
  entries.set(
    "word/document.xml",
    Buffer.from(
      appendOriginalPdfPageImagesDocumentXml(documentXml.toString("utf8"), embeddedPages),
      "utf8",
    ),
  );
  ensureDocxPngContentType(entries);
  await writeZipEntries(input.outputPath, entries);
}

interface PdfPageImage {
  pageNumber: number;
  path: string;
}

interface EmbeddedDocxImage {
  relId: string;
  pageNumber: number;
  widthEmu: number;
  heightEmu: number;
}

async function renderPdfPagesAsImages(input: {
  pdfPath: string;
  outputDir: string;
}): Promise<PdfPageImage[]> {
  const pdftoppmBin = await findExecutable(process.env.PDFTOPPM_BIN, "pdftoppm");
  if (!pdftoppmBin) {
    throw new Error("pdftoppm is required to preserve PDF original pages");
  }
  await fs.rm(input.outputDir, { recursive: true, force: true });
  await fs.mkdir(input.outputDir, { recursive: true });
  const outputPrefix = path.join(input.outputDir, "page");
  const args = [
    "-png",
    "-r",
    String(readPositiveIntegerEnv("PDF_ORIGINAL_RENDER_DPI", 150)),
    ...pdfPageLimitArgs(),
    input.pdfPath,
    outputPrefix,
  ];
  await execFileAsync(pdftoppmBin, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 512 * 1024,
  });
  return (await fs.readdir(input.outputDir))
    .map((entry) => {
      const match = /^page-(\d+)\.png$/i.exec(entry);
      if (!match?.[1]) {
        return null;
      }
      return {
        pageNumber: Number.parseInt(match[1], 10),
        path: path.join(input.outputDir, entry),
      };
    })
    .filter((page): page is PdfPageImage => page !== null)
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

function pdfPageLimitArgs(): string[] {
  const maxPages = readOptionalPositiveIntegerEnv("PDF_ORIGINAL_MAX_PAGES");
  return maxPages ? ["-f", "1", "-l", String(maxPages)] : [];
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readOptionalPositiveIntegerEnv(name: string): number | null {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function embedDocxImages(entries: Map<string, Buffer>, pages: PdfPageImage[]): Promise<EmbeddedDocxImage[]> {
  const existingRelationships = entries.get("word/_rels/document.xml.rels")?.toString("utf8");
  let relsXml = existingRelationships ?? createEmptyDocumentRelationshipsXml();
  let nextRelationshipId = nextDocxRelationshipId(relsXml);
  const embedded: EmbeddedDocxImage[] = [];
  for (const page of pages) {
    const image = await fs.readFile(page.path);
    const dimensions = readPngDimensions(image);
    const displaySize = fitImageToDocxPage(dimensions);
    const mediaPath = uniqueDocxMediaPath(entries, `original-pdf-page-${page.pageNumber}.png`);
    entries.set(mediaPath, image);
    const relId = `rId${nextRelationshipId}`;
    nextRelationshipId += 1;
    relsXml = appendDocxRelationship(relsXml, {
      id: relId,
      target: mediaPath.replace(/^word\//, ""),
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    });
    embedded.push({
      relId,
      pageNumber: page.pageNumber,
      widthEmu: displaySize.widthEmu,
      heightEmu: displaySize.heightEmu,
    });
  }
  entries.set("word/_rels/document.xml.rels", Buffer.from(relsXml, "utf8"));
  return embedded;
}

function createEmptyDocumentRelationshipsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    "</Relationships>",
  ].join("");
}

function nextDocxRelationshipId(relsXml: string): number {
  const ids = [...relsXml.matchAll(/\bId="rId(\d+)"/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((value) => Number.isFinite(value));
  return Math.max(0, ...ids) + 1;
}

function appendDocxRelationship(
  relsXml: string,
  relationship: { id: string; type: string; target: string },
): string {
  const xml = `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${escapeXmlAttribute(relationship.target)}"/>`;
  return relsXml.replace("</Relationships>", `${xml}</Relationships>`);
}

function uniqueDocxMediaPath(entries: Map<string, Buffer>, preferredPath: string): string {
  const parsed = path.posix.parse(preferredPath);
  let candidate = path.posix.join("word/media", preferredPath);
  let suffix = 2;
  while (entries.has(candidate)) {
    candidate = path.posix.join("word/media", `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 24 ||
    buffer.readUInt32BE(0) !== 0x89504e47 ||
    buffer.readUInt32BE(4) !== 0x0d0a1a0a ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("PDF page renderer did not produce a valid PNG image");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function fitImageToDocxPage(dimensions: { width: number; height: number }): { widthEmu: number; heightEmu: number } {
  const maxWidthEmu = 9360 * 635;
  const maxHeightEmu = 12400 * 635;
  const widthRatio = maxWidthEmu / dimensions.width;
  const heightRatio = maxHeightEmu / dimensions.height;
  const ratio = Math.min(widthRatio, heightRatio);
  return {
    widthEmu: Math.max(1, Math.round(dimensions.width * ratio)),
    heightEmu: Math.max(1, Math.round(dimensions.height * ratio)),
  };
}

function appendOriginalPdfPageImagesDocumentXml(translatedXml: string, images: EmbeddedDocxImage[]): string {
  const xml = ensureWordDrawingNamespaces(translatedXml);
  const translatedBody = splitWordBodyXml(xml);
  const headingXml = [
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>[원문]</w:t></w:r></w:p>',
  ].join("");
  return [
    translatedBody.prefix,
    translatedBody.contentWithoutSectPr,
    headingXml,
    images.map((image, index) => renderOriginalPdfPageImageWordXml(image, index < images.length - 1)).join(""),
    translatedBody.sectPr,
    translatedBody.suffix,
  ].join("");
}

function ensureWordDrawingNamespaces(xml: string): string {
  return xml.replace(/<w:document\b[^>]*>/, (tag) => {
    let normalized = tag;
    const namespaces = [
      ['xmlns:r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
      ['xmlns:wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'],
      ['xmlns:a', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
      ['xmlns:pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture'],
    ] as const;
    for (const [name, value] of namespaces) {
      if (!new RegExp(`\\b${name}=`).test(normalized)) {
        normalized = normalized.replace(/>$/, ` ${name}="${value}">`);
      }
    }
    return normalized;
  });
}

function renderOriginalPdfPageImageWordXml(image: EmbeddedDocxImage, addPageBreak: boolean): string {
  const docPrId = 1000 + image.pageNumber;
  const imageXml = [
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>',
    `<wp:inline distT="0" distB="0" distL="0" distR="0">`,
    `<wp:extent cx="${image.widthEmu}" cy="${image.heightEmu}"/>`,
    `<wp:docPr id="${docPrId}" name="Original PDF page ${image.pageNumber}"/>`,
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    '<pic:pic><pic:nvPicPr>',
    `<pic:cNvPr id="${docPrId}" name="Original PDF page ${image.pageNumber}.png"/>`,
    '<pic:cNvPicPr/>',
    '</pic:nvPicPr><pic:blipFill>',
    `<a:blip r:embed="${image.relId}"/>`,
    '<a:stretch><a:fillRect/></a:stretch>',
    '</pic:blipFill><pic:spPr>',
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${image.widthEmu}" cy="${image.heightEmu}"/></a:xfrm>`,
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</pic:spPr></pic:pic>',
    '</a:graphicData></a:graphic>',
    '</wp:inline>',
    '</w:drawing></w:r></w:p>',
  ].join("");
  return addPageBreak ? `${imageXml}${renderWordPageBreak()}` : imageXml;
}

function ensureDocxPngContentType(entries: Map<string, Buffer>): void {
  const contentTypes = entries.get("[Content_Types].xml");
  if (!contentTypes) {
    throw new Error("DOCX [Content_Types].xml is missing");
  }
  const xml = contentTypes.toString("utf8");
  if (/<Default\b[^>]*\bExtension="png"\b/i.test(xml)) {
    return;
  }
  entries.set(
    "[Content_Types].xml",
    Buffer.from(
      xml.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'),
      "utf8",
    ),
  );
}

function escapeXmlAttribute(value: string): string {
  return sanitizeXmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function appendOriginalDocumentXml(translatedXml: string, originalXml: string): string {
  const translatedBody = splitWordBodyXml(translatedXml);
  const originalBody = splitWordBodyXml(originalXml);
  const headingXml = [
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>[원문]</w:t></w:r></w:p>',
  ].join("");
  return [
    translatedBody.prefix,
    translatedBody.contentWithoutSectPr,
    headingXml,
    originalBody.contentWithoutSectPr,
    translatedBody.sectPr,
    translatedBody.suffix,
  ].join("");
}

interface TemplateSupportSections {
  beforeTranslation: string;
  afterTranslation: string;
}

async function readTemplatePreservedSupportSections(markdownPath: string): Promise<TemplateSupportSections> {
  return extractTemplatePreservedSupportSections(await fs.readFile(markdownPath, "utf8"));
}

function extractTemplatePreservedSupportSections(markdown: string): TemplateSupportSections {
  const lines = normalizeMarkdownText(markdown).split("\n");
  const translatedHeadingIndex = lines.findIndex((line) => isTranslatedDocumentHeading(line));
  if (translatedHeadingIndex >= 0) {
    const notesIndex = lines.findIndex((line, index) => index > translatedHeadingIndex && isTranslatorNotesHeading(line));
    return {
      beforeTranslation: cleanSupportMarkdown(lines.slice(0, translatedHeadingIndex).join("\n")),
      afterTranslation: notesIndex >= 0 ? cleanSupportMarkdown(lines.slice(notesIndex).join("\n")) : "",
    };
  }
  return {
    beforeTranslation: extractKnownSupportMarkdownSections(lines),
    afterTranslation: "",
  };
}

function extractKnownSupportMarkdownSections(lines: string[]): string {
  const sections: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isKnownSupportHeading(lines[index] ?? "")) {
      continue;
    }
    const end = findNextMarkdownHeadingIndex(lines, index + 1);
    sections.push(lines.slice(index, end < 0 ? lines.length : end).join("\n"));
    index = end < 0 ? lines.length : end - 1;
  }
  return cleanSupportMarkdown(sections.join("\n\n"));
}

function cleanSupportMarkdown(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function findNextMarkdownHeadingIndex(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s{0,3}#{1,6}\s+\S/.test(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
}

function isTranslatedDocumentHeading(line: string): boolean {
  const heading = normalizeMarkdownHeading(line);
  return /^(?:\d+\.\s*)?(?:translated document|translated text|final translation|번역문|번역\s*문서|최종\s*번역)\b/i.test(heading);
}

function isTranslatorNotesHeading(line: string): boolean {
  const heading = normalizeMarkdownHeading(line);
  return /^(?:\d+\.\s*)?(?:translator'?s notes?|translation notes?|번역자\s*주|번역\s*노트|주석)\b/i.test(heading);
}

function isKnownSupportHeading(line: string): boolean {
  const heading = normalizeMarkdownHeading(line);
  return /(?:translation metadata|metadata|glossary|terminology|용어|메타정보|메타데이터)/i.test(heading);
}

function normalizeMarkdownHeading(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

function insertTemplateSupportSections(
  xml: string,
  support: TemplateSupportSections,
  jobMetadataLine = "",
): string {
  if (!jobMetadataLine && !support.beforeTranslation && !support.afterTranslation) {
    return xml;
  }
  const body = splitWordBodyXml(xml);
  const metadataXml = jobMetadataLine ? renderJobMetadataWordXml(jobMetadataLine) : "";
  const frontMatterXml = support.beforeTranslation
    ? `${metadataXml}${renderSupportMarkdownWordXml(support.beforeTranslation)}${renderWordPageBreak()}`
    : metadataXml;
  const translatorNotesXml = support.afterTranslation
    ? `${renderWordPageBreak()}${renderSupportMarkdownWordXml(support.afterTranslation)}`
    : "";
  return [
    body.prefix,
    frontMatterXml,
    body.contentWithoutSectPr,
    translatorNotesXml,
    body.sectPr,
    body.suffix,
  ].join("");
}

function renderJobMetadataWordXml(text: string): string {
  return [
    '<w:p><w:pPr><w:jc w:val="left"/><w:spacing w:after="80"/></w:pPr>',
    '<w:r><w:rPr><w:color w:val="666666"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>',
    `<w:t xml:space="preserve">${escapeWordXmlText(text)}</w:t>`,
    '</w:r></w:p>',
  ].join("");
}

function isOutputJobMetadataLine(text: string): boolean {
  return /^Job: \S+ \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\)$/.test(text);
}

function renderSupportMarkdownWordXml(markdown: string): string {
  const lines = cleanSupportMarkdown(markdown).split("\n");
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isMarkdownTableStart(lines, index)) {
      const rows = [parseMarkdownTableRow(lines[index] ?? "")];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        rows.push(parseMarkdownTableRow(lines[index] ?? ""));
        index += 1;
      }
      chunks.push(renderSupportMarkdownTableWordXml(rows));
      index -= 1;
      continue;
    }
    chunks.push(renderSupportMarkdownLineWordXml(lines[index] ?? ""));
  }
  return chunks.join("");
}

function renderSupportMarkdownLineWordXml(line: string): string {
  const headingMatch = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (headingMatch) {
    const level = headingMatch[1]?.length ?? 1;
    const style = level <= 1 ? "Heading1" : level === 2 ? "Heading2" : "Heading3";
    return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${escapeWordXmlText(headingMatch[2] ?? "")}</w:t></w:r></w:p>`;
  }
  if (line.trim().length === 0) {
    return "<w:p/>";
  }
  return `<w:p><w:r><w:t xml:space="preserve">${escapeWordXmlText(line)}</w:t></w:r></w:p>`;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  return isMarkdownTableRow(lines[index] ?? "") && isMarkdownTableSeparator(lines[index + 1] ?? "");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && !isMarkdownTableSeparator(trimmed);
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderSupportMarkdownTableWordXml(rows: string[][]): string {
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const tableWidth = 9360;
  const columnWidth = Math.floor(tableWidth / columnCount);
  const gridXml = Array.from({ length: columnCount }, () => `<w:gridCol w:w="${columnWidth}"/>`).join("");
  const rowXml = rows.map((row, index) => renderSupportMarkdownTableRowWordXml(row, columnCount, columnWidth, index === 0)).join("");
  return [
    "<w:tbl>",
    "<w:tblPr>",
    `<w:tblW w:w="${tableWidth}" w:type="dxa"/>`,
    WORD_TABLE_BORDERS_XML,
    WORD_TABLE_CELL_MARGINS_XML,
    "</w:tblPr>",
    `<w:tblGrid>${gridXml}</w:tblGrid>`,
    rowXml,
    "</w:tbl>",
  ].join("");
}

function renderSupportMarkdownTableRowWordXml(row: string[], columnCount: number, columnWidth: number, isHeader: boolean): string {
  const cells = Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
  return `<w:tr>${cells.map((cell) => renderSupportMarkdownTableCellWordXml(cell, columnWidth, isHeader)).join("")}</w:tr>`;
}

function renderSupportMarkdownTableCellWordXml(cell: string, columnWidth: number, isHeader: boolean): string {
  const shading = isHeader ? WORD_TABLE_HEADER_SHADING_XML : "";
  const boldStart = isHeader ? "<w:rPr><w:b/></w:rPr>" : "";
  return [
    "<w:tc>",
    `<w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>${shading}</w:tcPr>`,
    `<w:p><w:r>${boldStart}<w:t xml:space="preserve">${escapeWordXmlText(stripInlineMarkdown(cell))}</w:t></w:r></w:p>`,
    "</w:tc>",
  ].join("");
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function renderWordPageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function applyBlockTranslationsToWordDocumentXml(xml: string, translations: Map<string, string>): string {
  const blocks = extractTranslatableWordParagraphBlocks(xml);
  if (blocks.length === 0) {
    throw new Error("DOCX has no translatable text blocks");
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    const translation = translations.get(block.id);
    if (translation === undefined || translation.trim().length === 0) {
      throw new Error(`translations.json is missing translated text for block ${block.id}`);
    }
    chunks.push(xml.slice(cursor, block.start));
    chunks.push(replaceParagraphText(block.xml, translation));
    cursor = block.end;
  }
  chunks.push(xml.slice(cursor));
  return chunks.join("");
}

interface WordParagraphBlock {
  id: string;
  text: string;
  xml: string;
  start: number;
  end: number;
}

function extractTranslatableWordParagraphBlocks(xml: string): WordParagraphBlock[] {
  const blocks: WordParagraphBlock[] = [];
  for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0];
    const start = match.index ?? 0;
    const text = extractWordParagraphText(paragraph).trim();
    if (text.length === 0) {
      continue;
    }
    blocks.push({
      id: `b${String(blocks.length + 1).padStart(4, "0")}`,
      text,
      xml: paragraph,
      start,
      end: start + paragraph.length,
    });
  }
  return blocks;
}

function extractWordParagraphText(paragraphXml: string): string {
  const normalized = paragraphXml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n");
  return [...normalized.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeXmlText(match[1] ?? ""))
    .join("");
}

function replaceParagraphText(paragraphXml: string, text: string): string {
  let replaced = "";
  let cursor = 0;
  let wroteTranslation = false;
  for (const match of paragraphXml.matchAll(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g)) {
    const token = match[0];
    const start = match.index ?? 0;
    const openEnd = token.indexOf(">");
    if (openEnd < 0) {
      continue;
    }
    let openTag = token.slice(0, openEnd + 1);
    const replacement = wroteTranslation ? "" : renderWordTextContent(text);
    if (!wroteTranslation && needsPreserveSpace(text) && !/\bxml:space=/.test(openTag)) {
      openTag = openTag.replace("<w:t", '<w:t xml:space="preserve"');
    }
    replaced += paragraphXml.slice(cursor, start);
    replaced += `${openTag}${replacement}</w:t>`;
    cursor = start + token.length;
    wroteTranslation = true;
  }
  if (!wroteTranslation) {
    return paragraphXml;
  }
  return `${replaced}${paragraphXml.slice(cursor)}`;
}

function renderWordTextContent(text: string): string {
  return sanitizeXmlText(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => escapeWordXmlText(line))
    .join('</w:t><w:br/><w:t xml:space="preserve">');
}

function needsPreserveSpace(text: string): boolean {
  return /^\s|\s$/.test(text);
}

async function readDocxBlockTranslations(filePath: string): Promise<Map<string, string>> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) {
    throw new Error("translations.json must contain a blocks array");
  }
  const translations = new Map<string, string>();
  for (const block of parsed.blocks) {
    if (!isRecord(block) || typeof block.id !== "string" || typeof block.text !== "string") {
      throw new Error("translations.json blocks must contain string id and text");
    }
    translations.set(block.id, block.text);
  }
  return translations;
}

async function readImageOcrBlocks(filePath: string): Promise<ImageOcrBlock[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.blocks)) {
    throw new Error("image OCR structure must contain a blocks array");
  }
  return parsed.blocks.flatMap((block): ImageOcrBlock[] => {
    if (
      !isRecord(block) ||
      typeof block.id !== "string" ||
      typeof block.text !== "string" ||
      !isRecord(block.bbox)
    ) {
      return [];
    }
    const x = numberFromUnknown(block.bbox.x);
    const y = numberFromUnknown(block.bbox.y);
    const width = numberFromUnknown(block.bbox.width);
    const height = numberFromUnknown(block.bbox.height);
    if (width <= 0 || height <= 0) {
      return [];
    }
    const confidence = numberFromUnknown(block.confidence);
    return [{
      id: block.id,
      text: block.text,
      bbox: { x, y, width, height },
      ...(Number.isFinite(confidence) ? { confidence } : {}),
    }];
  });
}

function numberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function appendOriginalTextSectionsDocumentXml(translatedXml: string, originalSections: PdfTextSection[]): string {
  const translatedBody = splitWordBodyXml(translatedXml);
  const headingXml = [
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>[원문]</w:t></w:r></w:p>',
  ].join("");
  return [
    translatedBody.prefix,
    translatedBody.contentWithoutSectPr,
    headingXml,
    renderOriginalSectionsWordXml(originalSections),
    translatedBody.sectPr,
    translatedBody.suffix,
  ].join("");
}

function renderOriginalSectionsWordXml(originalSections: PdfTextSection[]): string {
  if (originalSections.length === 0) {
    return '<w:p><w:r><w:t xml:space="preserve">전처리된 원문 텍스트가 없습니다.</w:t></w:r></w:p>';
  }
  return originalSections.map((section) => renderOriginalSectionWordXml(section)).join("");
}

function renderOriginalSectionWordXml(section: PdfTextSection): string {
  const lines = preserveOriginalText(section.text).split("\n");
  const paragraphs = [
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escapeWordXmlText(section.title)}</w:t></w:r></w:p>`,
  ];
  for (const line of lines) {
    if (line.length === 0) {
      paragraphs.push("<w:p/>");
      continue;
    }
    paragraphs.push(
      `<w:p><w:r><w:t xml:space="preserve">${escapeWordXmlText(line)}</w:t></w:r></w:p>`,
    );
  }
  return paragraphs.join("");
}

function escapeWordXmlText(value: string): string {
  return sanitizeXmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function sanitizeXmlText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      sanitized += char;
    }
  }
  return sanitized;
}

function splitWordBodyXml(xml: string): {
  prefix: string;
  contentWithoutSectPr: string;
  sectPr: string;
  suffix: string;
} {
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  if (!bodyMatch || bodyMatch.index === undefined) {
    throw new Error("DOCX body is missing");
  }
  const bodyOpenIndex = xml.indexOf("<w:body", bodyMatch.index);
  const bodyStartIndex = xml.indexOf(">", bodyOpenIndex);
  const bodyCloseIndex = xml.indexOf("</w:body>", bodyStartIndex);
  const prefix = xml.slice(0, bodyStartIndex + 1);
  const bodyContent = xml.slice(bodyStartIndex + 1, bodyCloseIndex);
  const sectPrMatch = /(\s*<w:sectPr\b[\s\S]*<\/w:sectPr>\s*)$/.exec(bodyContent);
  return {
    prefix,
    contentWithoutSectPr: sectPrMatch ? bodyContent.slice(0, sectPrMatch.index).trim() : bodyContent.trim(),
    sectPr: sectPrMatch?.[1] ?? "",
    suffix: xml.slice(bodyCloseIndex),
  };
}

async function readZipEntries(filePath: string): Promise<Map<string, Buffer>> {
  const buffer = await fs.readFile(filePath);
  return parseZipEntries(buffer);
}

function parseZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const endOffset = findZipEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  let centralOffset = buffer.readUInt32LE(endOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory header");
    }
    const compressionMethod = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const fileName = buffer.toString("utf8", centralOffset + 46, centralOffset + 46 + fileNameLength);
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(fileName, unzipEntryPayload(compressionMethod, compressed));
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function unzipEntryPayload(compressionMethod: number, payload: Buffer): Buffer {
  if (compressionMethod === 0) {
    return Buffer.from(payload);
  }
  if (compressionMethod === 8) {
    return inflateRawSync(payload);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  throw new Error("ZIP end of central directory not found");
}

async function writeZipEntries(filePath: string, entries: Map<string, Buffer>): Promise<void> {
  const files = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(localHeader, 30);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBuffer.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);

  await fs.writeFile(filePath, Buffer.concat([...localParts, centralDirectory, endRecord]));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findExecutable(preferred: string | undefined, ...fallbacks: string[]): Promise<string | null> {
  const candidates = [
    ...(preferred && preferred.trim().length > 0 ? [preferred.trim()] : []),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function resolveExecutable(candidate: string): Promise<string | null> {
  if (candidate.includes(path.sep) || (path.sep === "\\" && candidate.includes("/"))) {
    return await canExecute(candidate) ? candidate : null;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const resolved = path.join(directory, candidate);
    if (await canExecute(resolved)) {
      return resolved;
    }
  }
  return null;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findTranslationFile(files: GeneratedFile[]): GeneratedFile | null {
  const sorted = [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return sorted.find((file) => file.relativePath.toLowerCase() === "translated.md")
    ?? sorted.find((file) => path.extname(file.relativePath).toLowerCase() === ".md")
    ?? sorted.find((file) => path.extname(file.relativePath).toLowerCase() === ".txt")
    ?? null;
}

function primaryOutputSourceFileName(files: StoredJobFile[], job: StoredJob): string {
  if (files.length === 1) {
    const file = files[0];
    if (file?.originalName) {
      return file.originalName;
    }
    if (file?.archivePath || file?.localPath) {
      return path.basename(file.archivePath ?? file.localPath ?? "");
    }
  }
  return job.id;
}

function buildTranslatedOutputFileName(sourceFileName: string, extension: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const sourceBaseName = path.basename(sourceFileName).replace(/\u0000/g, "");
  const parsed = path.parse(sourceBaseName);
  const stem = sanitizeOutputFileStem(parsed.name || sourceBaseName || "document");
  return `${stem}_translated${normalizedExtension.toLowerCase()}`;
}

function sanitizeOutputFileStem(value: string): string {
  const sanitized = value
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return sanitized.length > 0 ? sanitized : "document";
}

async function readOriginalPdfSections(artifacts: AgentPostprocessInput["artifacts"]): Promise<PdfTextSection[]> {
  if (artifacts.length === 0) {
    return [{ title: "원문", text: "전처리된 원문 텍스트가 없습니다." }];
  }

  const sections: PdfTextSection[] = [];
  for (const artifact of artifacts) {
    try {
      sections.push({
        title: artifact.fileName,
        text: await fs.readFile(artifact.sourcePath, "utf8"),
      });
    } catch (error) {
      sections.push({
        title: artifact.fileName,
        text: `원문 텍스트를 읽을 수 없습니다: ${errorMessage(error)}`,
      });
    }
  }
  return sections;
}

async function findPdfFontPath(): Promise<string | null> {
  const candidates = [
    process.env.PDF_FONT_PATH,
    "/mnt/c/Windows/Fonts/malgun.ttf",
    "/mnt/c/Windows/Fonts/malgunbd.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function writeOriginalAndTranslationPdf(input: {
  pdfPath: string;
  job: StoredJob;
  originalSections: PdfTextSection[];
  translation: PdfTextSection;
  fontPath: string | null;
}): Promise<void> {
  await fs.mkdir(path.dirname(input.pdfPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: `Original and Translation - ${input.job.id}`,
        Subject: "Telegram Local Ingest output",
        Author: "telegram-local-ingest",
      },
    });
    const stream = createWriteStream(input.pdfPath);
    const done = (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    doc.on("error", reject);
    stream.on("error", reject);
    stream.on("finish", () => done());
    doc.pipe(stream);

    if (input.fontPath) {
      doc.font(input.fontPath);
    }
    writePdfJobMetadata(doc, input.job);

    doc.fontSize(15).text("번역문", { underline: true });
    doc.moveDown(0.5);
    writeMarkdownLikePdfText(doc, input.translation.text);
    doc.addPage();
    if (input.fontPath) {
      doc.font(input.fontPath);
    }
    doc.fontSize(15).text("[원문]", { underline: true });
    doc.moveDown(0.5);
    for (const section of input.originalSections) {
      doc.fontSize(12).text(section.title, { underline: true });
      doc.moveDown(0.25);
      writeOriginalPdfText(doc, section.text);
      doc.moveDown(0.75);
    }
    doc.end();
  });
}

async function writeImageOverlayPdf(input: {
  pdfPath: string;
  job: StoredJob;
  imageSource: ImageSourceFile;
  blocks: ImageOcrBlock[];
  translations: Map<string, string>;
  supportSections: TemplateSupportSections;
  fontPath: string | null;
}): Promise<void> {
  const imageBuffer = await fs.readFile(input.imageSource.path);
  const dimensions = readImageDimensions(imageBuffer);
  if (!dimensions) {
    throw new Error("Only PNG and JPEG images can be rendered with translated overlay output");
  }
  await fs.mkdir(path.dirname(input.pdfPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 48,
      info: {
        Title: `Image Translation - ${input.job.id}`,
        Subject: "Telegram Local Ingest image translation output",
        Author: "telegram-local-ingest",
      },
    });
    const stream = createWriteStream(input.pdfPath);
    const done = (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    doc.on("error", reject);
    stream.on("error", reject);
    stream.on("finish", () => done());
    doc.pipe(stream);

    if (input.fontPath) {
      doc.font(input.fontPath);
    }
    writePdfJobMetadata(doc, input.job);

    if (input.supportSections.beforeTranslation) {
      writeMarkdownLikePdfText(doc, input.supportSections.beforeTranslation);
      doc.addPage();
      if (input.fontPath) {
        doc.font(input.fontPath);
      }
    }

    doc.fontSize(15).text("번역문", { underline: true });
    doc.moveDown(0.5);
    drawTranslatedImagePage({
      doc,
      imagePath: input.imageSource.path,
      dimensions,
      blocks: input.blocks,
      translations: input.translations,
    });

    if (input.supportSections.afterTranslation) {
      doc.addPage();
      if (input.fontPath) {
        doc.font(input.fontPath);
      }
      writeMarkdownLikePdfText(doc, input.supportSections.afterTranslation);
    }

    doc.addPage();
    if (input.fontPath) {
      doc.font(input.fontPath);
    }
    doc.fontSize(15).text("[원문]", { underline: true });
    doc.moveDown(0.5);
    drawImageFitToCurrentPage(doc, input.imageSource.path, dimensions);
    doc.end();
  });
}

function writePdfJobMetadata(doc: PDFKit.PDFDocument, job: Pick<StoredJob, "id">): void {
  doc
    .fontSize(8)
    .fillColor("#666666")
    .text(formatOutputJobMetadata(job), { align: "left" });
  doc.fillColor("#000000");
  doc.moveDown(0.6);
}

function drawTranslatedImagePage(input: {
  doc: PDFKit.PDFDocument;
  imagePath: string;
  dimensions: ImageDimensions;
  blocks: ImageOcrBlock[];
  translations: Map<string, string>;
}): void {
  const placement = drawImageFitToCurrentPage(input.doc, input.imagePath, input.dimensions);
  const overlayBoxes = layoutTranslatedImageBoxes({
    doc: input.doc,
    placement,
    imageDimensions: input.dimensions,
    blocks: input.blocks,
    translations: input.translations,
  });
  for (const box of overlayBoxes) {
    drawTranslatedImageBlockBackground(input.doc, box.rect);
  }
  for (const box of overlayBoxes) {
    drawTranslatedImageBlockText(input.doc, box);
  }
}

function drawImageFitToCurrentPage(
  doc: PDFKit.PDFDocument,
  imagePath: string,
  dimensions: ImageDimensions,
): { x: number; y: number; width: number; height: number } {
  const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxHeight = doc.page.height - doc.y - doc.page.margins.bottom;
  const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height);
  const width = Math.max(1, dimensions.width * scale);
  const height = Math.max(1, dimensions.height * scale);
  const x = doc.page.margins.left + Math.max(0, (maxWidth - width) / 2);
  const y = doc.y;
  doc.image(imagePath, x, y, { width, height });
  doc.y = y + height;
  return { x, y, width, height };
}

function layoutTranslatedImageBoxes(input: {
  doc: PDFKit.PDFDocument;
  placement: PdfRect;
  imageDimensions: ImageDimensions;
  blocks: ImageOcrBlock[];
  translations: Map<string, string>;
}): ImageOverlayBox[] {
  const scale = input.placement.width / input.imageDimensions.width;
  const boxes = input.blocks.flatMap((block): ImageOverlayBox[] => {
    const text = input.translations.get(block.id)?.trim();
    if (!text) {
      return [];
    }
    const sourceRect = {
      x: input.placement.x + block.bbox.x * scale,
      y: input.placement.y + block.bbox.y * scale,
      width: block.bbox.width * scale,
      height: block.bbox.height * scale,
    };
    return [buildImageOverlayBox(input.doc, input.placement, sourceRect, text)];
  });
  return resolveImageOverlayCollisions(boxes, input.placement);
}

function buildImageOverlayBox(
  doc: PDFKit.PDFDocument,
  placement: PdfRect,
  sourceRect: PdfRect,
  text: string,
): ImageOverlayBox {
  const preferredFontSize = Math.max(6, Math.min(10, sourceRect.height * 0.55));
  const fontSize = fitSingleLinePdfTextFontSize(doc, text, placement.width, preferredFontSize);
  const lineHeight = Math.max(8, fontSize * 1.18);
  const padding = Math.max(1.5, Math.min(3, fontSize * 0.24));
  const measuredTextWidth = doc.fontSize(fontSize).widthOfString(text);
  const desiredWidth = clampNumber(
    Math.max(sourceRect.width, Math.min(Math.max(sourceRect.width * 2.2, 72), measuredTextWidth + padding * 2, placement.width)),
    Math.min(36, placement.width),
    placement.width,
  );
  const centeredX = sourceRect.x + sourceRect.width / 2 - desiredWidth / 2;
  const x = clampNumber(centeredX, placement.x, placement.x + placement.width - desiredWidth);
  const y = clampNumber(
    sourceRect.y + sourceRect.height / 2 - lineHeight / 2,
    placement.y,
    placement.y + placement.height - lineHeight,
  );
  return {
    rect: {
      x,
      y,
      width: desiredWidth,
      height: lineHeight,
    },
    text,
    padding,
    fontSize,
    lineHeight,
  };
}

function resolveImageOverlayCollisions(boxes: ImageOverlayBox[], placement: PdfRect): ImageOverlayBox[] {
  const sorted = [...boxes].sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  const placed: ImageOverlayBox[] = [];
  const gap = 2;
  for (const box of sorted) {
    const rect = { ...box.rect };
    let moved = true;
    while (moved) {
      moved = false;
      for (const previous of placed) {
        if (!rectsOverlap(rect, previous.rect, gap)) {
          continue;
        }
        rect.y = previous.rect.y + previous.rect.height + gap;
        moved = true;
      }
    }
    if (rect.y + rect.height > placement.y + placement.height) {
      rect.y = Math.max(placement.y, placement.y + placement.height - rect.height);
    }
    placed.push({
      ...box,
      rect,
    });
  }
  return placed;
}

function rectsOverlap(left: PdfRect, right: PdfRect, gap = 0): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function drawTranslatedImageBlockBackground(doc: PDFKit.PDFDocument, rect: PdfRect): void {
  doc.save();
  doc.fillOpacity(0.84).rect(rect.x, rect.y, rect.width, rect.height).fill("#FFFFFF");
  doc.restore();
}

function drawTranslatedImageBlockText(doc: PDFKit.PDFDocument, box: ImageOverlayBox): void {
  const textWidth = Math.max(4, box.rect.width - box.padding * 2);
  const textHeight = Math.max(4, box.lineHeight);
  doc
    .fillColor("#000000")
    .fontSize(box.fontSize)
    .text(box.text, box.rect.x + box.padding, box.rect.y, {
      width: textWidth,
      height: textHeight,
      lineGap: 0,
      ellipsis: true,
    });
}

function fitSingleLinePdfTextFontSize(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  preferredFontSize: number,
): number {
  for (let fontSize = preferredFontSize; fontSize >= 5; fontSize -= 0.5) {
    doc.fontSize(fontSize);
    if (doc.widthOfString(text) <= maxWidth) {
      return fontSize;
    }
  }
  return 5;
}

function fitPdfTextFontSize(doc: PDFKit.PDFDocument, text: string, width: number, height: number): number {
  const maxFontSize = Math.max(6, Math.min(16, height * 0.55));
  for (let fontSize = maxFontSize; fontSize >= 6; fontSize -= 0.5) {
    doc.fontSize(fontSize);
    if (doc.heightOfString(text, { width, lineGap: Math.max(0, Math.min(2, fontSize * 0.14)) }) <= height) {
      return fontSize;
    }
  }
  return 6;
}

function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  try {
    return readPngDimensions(buffer);
  } catch {
    return readJpegDimensions(buffer);
  }
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === undefined) {
      return null;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return null;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      return null;
    }
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function writeMarkdownLikePdfText(doc: PDFKit.PDFDocument, markdown: string): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isMarkdownTableStart(lines, index)) {
      const rows = [parseMarkdownTableRow(line)];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        rows.push(parseMarkdownTableRow(lines[index] ?? ""));
        index += 1;
      }
      writeMarkdownPdfTable(doc, rows);
      index -= 1;
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      doc.moveDown(0.35);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const headingLevel = heading[1]?.length ?? 1;
      const headingText = heading[2] ?? "";
      doc.moveDown(0.25);
      doc.fontSize(headingLevel <= 2 ? 13 : 12).text(headingText, {
        paragraphGap: 2,
      });
      continue;
    }
    doc.fontSize(10).text(trimmed, {
      align: "left",
      lineGap: 2,
      paragraphGap: 1,
    });
  }
}

function writeMarkdownPdfTable(doc: PDFKit.PDFDocument, rows: string[][]): void {
  if (rows.length === 0) {
    return;
  }
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const tableLeft = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidth = tableWidth / columnCount;
  const cellPadding = 5;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
  let y = doc.y + 4;

  doc.fontSize(9);
  for (const [rowIndex, row] of rows.entries()) {
    const cells = Array.from({ length: columnCount }, (_, index) => stripInlineMarkdown(row[index] ?? ""));
    const rowHeight = Math.max(
      22,
      ...cells.map((cell) =>
        doc.heightOfString(cell || " ", {
          width: Math.max(24, columnWidth - cellPadding * 2),
          lineGap: 1,
        }) + cellPadding * 2),
    );
    if (y + rowHeight > bottomLimit()) {
      doc.addPage();
      y = doc.y;
    }
    const isHeader = rowIndex === 0;
    for (const [cellIndex, cell] of cells.entries()) {
      const x = tableLeft + cellIndex * columnWidth;
      doc.save();
      if (isHeader) {
        doc.rect(x, y, columnWidth, rowHeight).fillAndStroke("#D9EAF7", "#CCCCCC");
      } else {
        doc.rect(x, y, columnWidth, rowHeight).stroke("#CCCCCC");
      }
      doc.restore();
      doc
        .fillColor("#000000")
        .fontSize(9)
        .text(cell, x + cellPadding, y + cellPadding, {
          width: Math.max(24, columnWidth - cellPadding * 2),
          lineGap: 1,
        });
    }
    y += rowHeight;
  }

  doc.x = tableLeft;
  doc.y = y + 8;
  doc.fillColor("#000000").fontSize(10);
}

function writeOriginalPdfText(doc: PDFKit.PDFDocument, text: string): void {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (line.length === 0) {
      doc.moveDown(0.35);
      continue;
    }
    doc.fontSize(10).text(line, {
      align: "left",
      lineGap: 2,
      paragraphGap: 1,
    });
  }
}

async function removeIntermediateGeneratedFiles(outputDir: string, generatedFiles: GeneratedFile[], keepPath: string): Promise<void> {
  const resolvedOutputDir = path.resolve(outputDir);
  const resolvedKeepPath = path.resolve(keepPath);
  for (const file of generatedFiles) {
    const resolvedFilePath = path.resolve(file.path);
    if (resolvedFilePath === resolvedKeepPath) {
      continue;
    }
    if (!isPathInside(resolvedOutputDir, resolvedFilePath)) {
      continue;
    }
    await fs.rm(resolvedFilePath, { force: true });
    await removeEmptyDirectories(path.dirname(resolvedFilePath), resolvedOutputDir);
  }
}

async function removeEmptyDirectories(current: string, stopDir: string): Promise<void> {
  let directory = path.resolve(current);
  const resolvedStopDir = path.resolve(stopDir);
  while (isPathInside(resolvedStopDir, directory) && directory !== resolvedStopDir) {
    const entries = await fs.readdir(directory);
    if (entries.length > 0) {
      return;
    }
    await fs.rmdir(directory);
    directory = path.dirname(directory);
  }
}

async function listGeneratedFiles(root: string): Promise<GeneratedFile[]> {
  const resolvedRoot = path.resolve(root);
  const files: GeneratedFile[] = [];
  await collectGeneratedFiles(resolvedRoot, resolvedRoot, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectGeneratedFiles(
  root: string,
  current: string,
  files: GeneratedFile[],
): Promise<void> {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectGeneratedFiles(root, fullPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push({
        path: fullPath,
        relativePath: path.relative(root, fullPath).replace(/\\/g, "/"),
      });
    }
  }
}

function inferMimeType(fileName: string): string | undefined {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".eml":
      return "message/rfc822";
    case ".hwp":
      return "application/x-hwp";
    case ".hwpx":
      return "application/vnd.hancom.hwpx";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return undefined;
  }
}

function truncateButtonLabel(value: string): string {
  return value.length > 32 ? `${value.slice(0, 29)}...` : value;
}

function downloadTypeLabel(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (isTranscriptOutputFileName(fileName)) {
    return "전사 스크립트";
  }
  switch (extension) {
    case ".pdf":
      return "PDF";
    case ".docx":
      return "DOCX";
    case ".hwp":
      return "HWP";
    case ".hwpx":
      return "HWPX";
    case ".md":
      return "MD";
    default:
      return "파일";
  }
}

function isTranscriptOutputFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".transcript.md") || lower.endsWith(".transcript.docx") || lower.endsWith("_transcript.docx");
}

function resolveProjectRelativePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
