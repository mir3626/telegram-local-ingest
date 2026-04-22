import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { createIngestJobFromTelegramMessage, createQueuedJobFromTelegramMessage } from "@telegram-local-ingest/capture";
import { type AppConfig, ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  appendJobEvent,
  createSourceBundle,
  getJob,
  getTelegramOffset,
  listJobEvents,
  listJobFiles,
  listJobs,
  migrate,
  mustGetJob,
  mustGetSourceBundleForJob,
  openIngestDatabase,
  requestRetry,
  setTelegramOffset,
  transitionJob,
  type DbHandle,
  type StoredJob,
  type StoredJobEvent,
  type StoredJobFile,
} from "@telegram-local-ingest/db";
import { cleanupTelegramSourceFiles, importTelegramJobFiles, resolveRuntimePath } from "@telegram-local-ingest/importer";
import {
  buildJobCompletionMessage,
  buildJobFailureMessage,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
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

export interface WorkerContext {
  config: AppConfig;
  db: DatabaseSync;
  telegram: TelegramBotApiClient;
  rtzr?: RtzrTranscriber;
  sensevoice?: SenseVoiceTranscriber;
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

interface RtzrPreset {
  key: string;
  label: string;
  emoji: string;
  description: string;
  config: RtzrTranscribeConfig;
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
    ...(rtzr ? { rtzr } : {}),
    ...(sensevoice ? { sensevoice } : {}),
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
            || await handleRtzrPresetCallback(context, callback);
          operatorCommandsHandled += handled ? 1 : 0;
        }
      } finally {
        setTelegramOffset(context.db, botKey, update.update_id);
      }
      continue;
    }

    const parsed = parseTelegramUpdate(update);
    try {
      if (parsed && isTelegramUserAllowed(parsed.userId, context.config.telegram.allowedUserIds)) {
        const command = getMessageCommand(parsed);
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
      logWorker(`STT phase started job=${job.id} provider=${context.config.stt.provider}`, "info", "STT");
      await runConfiguredSttTranscription(context, job);
      logWorker(`STT phase finished job=${job.id} provider=${context.config.stt.provider}`, "info", "STT");
      transitionJob(context.db, job.id, "BUNDLE_WRITING", { message: "Writing Obsidian raw bundle" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "BUNDLE_WRITING") {
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

    if (job.status === "INGESTING") {
      logWorker(`wiki adapter phase started job=${job.id}`, "info", "WIKI");
      await runConfiguredWikiAdapter(context, job);
      logWorker(`wiki adapter phase finished job=${job.id}`, "info", "WIKI");
      transitionJob(context.db, job.id, "NOTIFYING", { message: "Notifying Telegram" });
      job = mustGetJob(context.db, job.id);
    }

    if (job.status === "NOTIFYING") {
      logWorker(`sending completion notification job=${job.id}`, "info", "NOTIFY");
      if (job.chatId) {
        await context.telegram.sendMessage(job.chatId, buildJobCompletionMessage(job, listJobFiles(context.db, job.id)));
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

async function handleRetryCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseRetryCallbackData(callback.data);
  if (!parsed) {
    return false;
  }

  if (!callback.chatId) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 재시도할 작업을 확인할 수 없습니다.");
    return true;
  }

  const job = getJob(context.db, parsed.jobId);
  if (!job) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, `⚠️ 작업을 찾을 수 없습니다: ${parsed.jobId}`);
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "🔒 이 작업을 재시도할 권한이 없습니다.");
    return true;
  }

  if (job.status !== "FAILED") {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, `⏳ 현재 상태에서는 재시도할 수 없습니다: ${job.status}`);
    return true;
  }

  const retryRequested = requestRetry(context.db, job.id, { message: "Retry requested from Telegram button" });
  const queued = transitionJob(context.db, retryRequested.id, "QUEUED", {
    message: "Retry queued from Telegram button",
  });
  await context.telegram.answerCallbackQuery(callback.callbackQueryId, "🔁 재시도 대기열에 넣었습니다.");
  await context.telegram.sendMessage(callback.chatId, `🔁 재시도 대기열에 넣었어요: ${queued.id}`);
  logWorker(`retry queued job=${queued.id} from=telegram_button`, "info", "RETRY");
  return true;
}

async function handleRtzrPresetCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseRtzrPresetCallbackData(callback.data);
  if (!parsed || !callback.chatId) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 처리할 수 없는 선택입니다.");
    return false;
  }

  const preset = RTZR_PRESETS.find((candidate) => candidate.key === parsed.presetKey);
  if (!preset) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 알 수 없는 녹음 환경입니다.");
    return false;
  }

  const job = getJob(context.db, parsed.jobId);
  if (!job) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, `⚠️ 작업을 찾을 수 없습니다: ${parsed.jobId}`);
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "🔒 이 작업을 변경할 권한이 없습니다.");
    return true;
  }

  if (job.status !== "RECEIVED") {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⏳ 이미 처리 중인 작업입니다.");
    return true;
  }

  appendJobEvent(context.db, job.id, "stt.preset_selected", `${preset.emoji} ${preset.label}`, {
    sttProvider: context.config.stt.provider,
    presetKey: preset.key,
    presetLabel: preset.label,
    presetDescription: preset.description,
    rtzrConfig: preset.config,
    sensevoiceConfig: buildSenseVoiceTranscribeOptions(context.config),
    translationDefaultRelation: context.config.translation.defaultRelation,
  });
  const queued = transitionJob(context.db, job.id, "QUEUED", {
    message: `STT preset selected: ${preset.label}`,
  });
  await context.telegram.answerCallbackQuery(callback.callbackQueryId, `${preset.emoji} ${preset.label} 설정을 저장했습니다.`);
  await context.telegram.sendMessage(callback.chatId, buildPresetQueuedMessage(queued.id, preset));
  logWorker(`stt preset selected job=${queued.id} provider=${context.config.stt.provider} preset=${preset.key}`, "info", "STT");
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

function logWorker(message: string, level: "info" | "warn" = "info", tag = "GENERAL"): void {
  const normalizedTag = tag.replace(/[^A-Z0-9_-]/gi, "_").toUpperCase();
  const line = `[WORKER] ${new Date().toISOString()} [${normalizedTag}] ${message}`;
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
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

function buildRetryKeyboard(jobId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: "🔁 다시 처리",
      callback_data: `retry:${jobId}`,
    }]],
  };
}

function buildPresetQueuedMessage(jobId: string, preset: RtzrPreset): string {
  return [
    `✅ ${preset.emoji} ${preset.label} 설정을 저장했어요.`,
    `📥 처리 대기열에 넣었습니다: ${jobId}`,
  ].join("\n");
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

function buildSenseVoiceTranscribeOptions(config: AppConfig): SenseVoiceTranscribeOptions {
  return {
    pythonPath: resolveProjectRelativePath(config.sensevoice.pythonPath),
    scriptPath: resolveProjectRelativePath(config.sensevoice.scriptPath),
    model: config.sensevoice.model,
    device: config.sensevoice.device,
    language: config.sensevoice.language,
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
    return event.data.artifacts.flatMap((artifact) => {
      if (!isRecord(artifact) || typeof artifact.sourcePath !== "string") {
        return [];
      }
      const result: RawBundleArtifactInput = {
        sourcePath: artifact.sourcePath,
      };
      if (typeof artifact.name === "string") {
        result.name = artifact.name;
      }
      return [result];
    });
  });
}

function parseRtzrPresetCallbackData(data: string | undefined): { presetKey: string; jobId: string } | null {
  const match = /^(?:rtzr|stt):([a-z0-9_-]+):(.+)$/.exec(data ?? "");
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { presetKey: match[1], jobId: match[2] };
}

function parseRetryCallbackData(data: string | undefined): { jobId: string } | null {
  const match = /^retry:(.+)$/.exec(data ?? "");
  if (!match?.[1]) {
    return null;
  }
  return { jobId: match[1] };
}

function selectedSttPresetEvent(events: StoredJobEvent[]): StoredJobEvent | undefined {
  return [...events].reverse().find((event) => event.type === "stt.preset_selected" || event.type === "rtzr.preset_selected");
}

function isTranscriptionEvent(type: string): boolean {
  return type === "rtzr.transcribed" || type === "sensevoice.transcribed";
}

function hasAudioOrVoice(files: ParsedTelegramFile[]): boolean {
  return files.some((file) => file.kind === "audio" || file.kind === "voice");
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
