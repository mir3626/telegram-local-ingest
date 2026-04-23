import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import {
  runAgentPostprocess,
  type AgentPostprocessInput,
  type AgentPostprocessResult,
} from "@telegram-local-ingest/agent-adapter";
import { createIngestJobFromTelegramMessage, createQueuedJobFromTelegramMessage } from "@telegram-local-ingest/capture";
import { type AppConfig, ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import {
  appendJobEvent,
  createSourceBundle,
  getJob,
  getTelegramOffset,
  listJobEvents,
  listJobFiles,
  listJobOutputs,
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
  type StoredJobOutput,
} from "@telegram-local-ingest/db";
import { cleanupTelegramSourceFiles, importTelegramJobFiles, resolveRuntimePath } from "@telegram-local-ingest/importer";
import {
  buildJobCompletionMessage,
  buildJobFailureMessage,
  sendOperatorCommandResponse,
} from "@telegram-local-ingest/operator";
import { cleanupExpiredOutputs, createRuntimeOutput, resolveDownloadableOutput } from "@telegram-local-ingest/output-store";
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

export interface WorkerContext {
  config: AppConfig;
  db: DatabaseSync;
  telegram: TelegramBotApiClient;
  rtzr?: RtzrTranscriber;
  sensevoice?: SenseVoiceTranscriber;
  agent?: AgentPostprocessor;
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
    ...(rtzr ? { rtzr } : {}),
    ...(sensevoice ? { sensevoice } : {}),
    ...(agent ? { agent } : {}),
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
      logWorker(`preprocessing phase started job=${job.id}`, "info", "PREPROCESS");
      await runPreprocessingAndLanguageCheck(context, job);
      logWorker(`preprocessing phase finished job=${job.id}`, "info", "PREPROCESS");
      logWorker(`agent postprocess phase started job=${job.id} provider=${context.config.agent.provider}`, "info", "AGENT");
      await runConfiguredAgentPostprocess(context, job);
      logWorker(`agent postprocess phase finished job=${job.id} provider=${context.config.agent.provider}`, "info", "AGENT");
      logWorker(`wiki adapter phase started job=${job.id}`, "info", "WIKI");
      await runConfiguredWikiAdapter(context, job);
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

async function cleanupExpiredOutputFiles(context: WorkerContext): Promise<void> {
  const cleanup = await cleanupExpiredOutputs(context.db, { limit: 50 });
  if (cleanup.deletedOutputs.length > 0) {
    logWorker(`expired output cleanup deleted=${cleanup.deletedOutputs.length}`, "info", "OUTPUT");
  }
  if (cleanup.failedOutputs.length > 0) {
    logWorker(`expired output cleanup failures=${cleanup.failedOutputs.length}`, "warn", "OUTPUT");
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

async function handleDownloadCallback(context: WorkerContext, callback: ParsedTelegramCallback): Promise<boolean> {
  const parsed = parseDownloadCallbackData(callback.data);
  if (!parsed) {
    return false;
  }

  if (!callback.chatId) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 다운로드할 채팅을 확인할 수 없습니다.");
    return true;
  }

  const resolved = resolveDownloadableOutput(context.db, parsed.outputId);
  if (resolved.status === "not_found") {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 다운로드 파일을 찾을 수 없습니다.");
    return true;
  }
  if (resolved.status === "expired" || resolved.status === "deleted") {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⏳ 다운로드 기간이 만료되었습니다.");
    return true;
  }

  const output = resolved.output;
  if (!output) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 다운로드 파일을 확인할 수 없습니다.");
    return true;
  }

  const job = getJob(context.db, output.jobId);
  if (!job) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 원본 작업을 찾을 수 없습니다.");
    return true;
  }

  if ((job.chatId && job.chatId !== callback.chatId) || (job.userId && callback.userId && job.userId !== callback.userId)) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "🔒 이 파일을 다운로드할 권한이 없습니다.");
    return true;
  }

  await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⬇️ 파일을 전송합니다.");
  await context.telegram.sendDocument(callback.chatId, output.filePath, {
    fileName: output.fileName,
    ...(output.mimeType ? { mimeType: output.mimeType } : {}),
    caption: `📎 ${output.fileName}`,
  });
  logWorker(`download sent output=${output.id} job=${output.jobId}`, "info", "OUTPUT");
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

  appendJobEvent(context.db, job.id, "stt.environment_selected", `${preset.emoji} ${preset.label}`, {
    sttProvider: context.config.stt.provider,
    presetKey: preset.key,
    presetLabel: preset.label,
    presetDescription: preset.description,
    translationDefaultRelation: context.config.translation.defaultRelation,
  });
  await context.telegram.answerCallbackQuery(callback.callbackQueryId, `${preset.emoji} ${preset.label} 환경을 저장했습니다.`);
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
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 처리할 수 없는 선택입니다.");
    return false;
  }

  const preset = RTZR_PRESETS.find((candidate) => candidate.key === parsed.presetKey);
  if (!preset) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 알 수 없는 녹음 환경입니다.");
    return false;
  }

  const language = STT_LANGUAGE_PRESETS.find((candidate) => candidate.key === parsed.languageKey);
  if (!language) {
    await context.telegram.answerCallbackQuery(callback.callbackQueryId, "⚠️ 알 수 없는 인식 언어입니다.");
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
  await context.telegram.answerCallbackQuery(callback.callbackQueryId, `${language.emoji} ${language.label} 설정을 저장했습니다.`);
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
  const agent = context.agent ?? { postprocess: (input: AgentPostprocessInput) => runAgentPostprocess(input) };
  const result = await agent.postprocess({
    command: context.config.agent.command,
    jobId: job.id,
    bundlePath: bundle.bundlePath,
    rawRoot: path.resolve(context.config.vault.obsidianVaultPath, context.config.vault.rawRoot),
    outputDir,
    targetLanguage: context.config.translation.targetLanguage,
    defaultRelation: context.config.translation.defaultRelation,
    language,
    artifacts: readPreprocessedArtifacts(events),
    ...(job.instructions ? { instructions: job.instructions } : {}),
    timeoutMs: context.config.agent.timeoutMs,
  });

  const generatedFiles = await listGeneratedFiles(result.outputDir);
  if (generatedFiles.length === 0) {
    throw new Error(`Agent postprocess did not create any output files: ${result.outputDir}`);
  }

  const outputs: StoredJobOutput[] = [];
  for (const file of generatedFiles) {
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

function buildCompletionNotification(job: StoredJob, files: StoredJobFile[], outputs: StoredJobOutput[]): string {
  if (outputs.length === 0) {
    return buildJobCompletionMessage(job, files);
  }
  return [
    `✅ 업로드한 파일의 자동번역이 완료되었습니다: ${job.id}${job.project ? ` (${job.project})` : ""}`,
    ...files.map((file) => `- ${file.originalName ?? file.id}`),
    "",
    "📎 결과 파일은 24시간 동안 다운로드할 수 있습니다.",
  ].join("\n");
}

function buildDownloadKeyboard(outputs: StoredJobOutput[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: outputs.map((output, index) => [{
      text: outputs.length === 1 ? "⬇️ 다운로드 (24시간)" : `⬇️ ${index + 1}. ${truncateButtonLabel(output.fileName)}`,
      callback_data: `download:${output.id}`,
    }]),
  };
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
    return [{
      id: artifact.id,
      kind: typeof artifact.kind === "string" ? artifact.kind : "unknown",
      fileName: typeof artifact.fileName === "string" ? artifact.fileName : artifact.id,
      sourcePath: artifact.sourcePath,
      charCount: typeof artifact.charCount === "number" ? artifact.charCount : 0,
      truncated: typeof artifact.truncated === "boolean" ? artifact.truncated : false,
    }];
  });
}

function listActiveJobOutputs(db: DatabaseSync, jobId: string): StoredJobOutput[] {
  const now = new Date().toISOString();
  return listJobOutputs(db, jobId).filter((output) => !output.deletedAt && output.expiresAt > now);
}

async function listGeneratedFiles(root: string): Promise<Array<{ path: string; relativePath: string }>> {
  const resolvedRoot = path.resolve(root);
  const files: Array<{ path: string; relativePath: string }> = [];
  await collectGeneratedFiles(resolvedRoot, resolvedRoot, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectGeneratedFiles(
  root: string,
  current: string,
  files: Array<{ path: string; relativePath: string }>,
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
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return undefined;
  }
}

function truncateButtonLabel(value: string): string {
  return value.length > 32 ? `${value.slice(0, 29)}...` : value;
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
