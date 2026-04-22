import path from "node:path";

export interface TelegramLocalBotApiConfig {
  botToken: string;
  baseUrl: string;
  localFilesRoot?: string;
}

export interface TelegramLocalFile {
  fileId: string;
  fileUniqueId?: string;
  filePath: string;
  fileSize?: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
}

export interface TelegramGetFileResult {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramFilePayload {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramFilePayload;
  audio?: TelegramFilePayload;
  voice?: TelegramFilePayload;
  video?: TelegramFilePayload;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface GetUpdatesOptions {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowedUpdates?: string[];
}

export type ParsedTelegramFileKind = "photo" | "document" | "audio" | "voice" | "video";

export interface ParsedTelegramFile {
  kind: ParsedTelegramFileKind;
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
}

export interface ParsedTelegramMessage {
  updateId: number;
  messageId: number;
  chatId: string;
  userId?: string;
  date: number;
  text?: string;
  caption?: string;
  files: ParsedTelegramFile[];
}

export interface ParsedTelegramCallback {
  updateId: number;
  callbackQueryId: string;
  chatId?: string;
  messageId?: number;
  userId?: string;
  data?: string;
}

export type TelegramCommandName = "ingest" | "status" | "retry" | "cancel" | "unknown";

export interface ParsedTelegramCommand {
  name: TelegramCommandName;
  raw: string;
  args: string[];
  project?: string;
  tags: string[];
  targetJobId?: string;
  instructions?: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramHealthReport {
  ok: boolean;
  bot?: TelegramUser;
  webhookInfo?: TelegramWebhookInfo;
  localBaseUrlLikely: boolean;
  issues: string[];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageOptions {
  replyMarkup?: InlineKeyboardMarkup;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode?: number;

  constructor(method: string, description: string, errorCode?: number) {
    super(`Telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
    this.method = method;
    if (errorCode !== undefined) {
      this.errorCode = errorCode;
    }
  }
}

export class TelegramBotApiClient {
  readonly config: TelegramLocalBotApiConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: TelegramLocalBotApiConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.config = {
      ...config,
      baseUrl: normalizeBaseUrl(config.baseUrl),
    };
    this.fetchImpl = fetchImpl;
  }

  async getMe(): Promise<TelegramUser> {
    return this.request<TelegramUser>("getMe");
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.request<TelegramWebhookInfo>("getWebhookInfo");
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.request<boolean>("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  async logOut(): Promise<boolean> {
    return this.request<boolean>("logOut");
  }

  async getFile(fileId: string): Promise<TelegramLocalFile> {
    const result = await this.request<TelegramGetFileResult>("getFile", { file_id: fileId });
    if (!result.file_path) {
      throw new TelegramApiError("getFile", "response did not include file_path");
    }
    return normalizeTelegramFile(result);
  }

  async getUpdates(options: GetUpdatesOptions = {}): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {};
    if (options.offset !== undefined) {
      payload.offset = options.offset;
    }
    if (options.limit !== undefined) {
      payload.limit = options.limit;
    }
    if (options.timeout !== undefined) {
      payload.timeout = options.timeout;
    }
    if (options.allowedUpdates !== undefined) {
      payload.allowed_updates = options.allowedUpdates;
    }
    return this.request<TelegramUpdate[]>("getUpdates", payload);
  }

  async sendMessage(chatId: string, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.request<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.request<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  buildFileDownloadUrl(filePath: string): string {
    return `${this.config.baseUrl}/file/bot${this.config.botToken}/${filePath.replace(/^\/+/, "")}`;
  }

  private async request<T>(method: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.config.baseUrl}/bot${this.config.botToken}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload ? JSON.stringify(payload) : "{}",
    });
    const body = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new TelegramApiError(method, body.description ?? response.statusText, body.error_code);
    }
    return body.result;
  }
}

export function normalizeTelegramFile(result: TelegramGetFileResult): TelegramLocalFile {
  if (!result.file_path) {
    throw new TelegramApiError("getFile", "response did not include file_path");
  }
  const file: TelegramLocalFile = {
    fileId: result.file_id,
    filePath: result.file_path,
  };
  if (result.file_unique_id !== undefined) {
    file.fileUniqueId = result.file_unique_id;
  }
  if (result.file_size !== undefined) {
    file.fileSize = result.file_size;
  }
  return file;
}

export type TelegramFileLocation =
  | { kind: "local-path"; path: string }
  | { kind: "download-url"; url: string };

export function resolveTelegramFileLocation(
  file: TelegramLocalFile,
  config: TelegramLocalBotApiConfig,
): TelegramFileLocation {
  if (isAbsoluteFilePath(file.filePath)) {
    const resolved = path.resolve(file.filePath);
    if (config.localFilesRoot) {
      const root = path.resolve(config.localFilesRoot);
      if (!isPathInside(root, resolved)) {
        throw new TelegramApiError("getFile", `absolute file_path is outside TELEGRAM_LOCAL_FILES_ROOT: ${file.filePath}`);
      }
    }
    return { kind: "local-path", path: resolved };
  }

  if (config.localFilesRoot) {
    const root = path.resolve(config.localFilesRoot);
    const resolved = path.resolve(root, file.filePath);
    if (!isPathInside(root, resolved)) {
      throw new TelegramApiError("getFile", `unsafe relative file_path: ${file.filePath}`);
    }
    return { kind: "local-path", path: resolved };
  }

  const client = new TelegramBotApiClient(config);
  return { kind: "download-url", url: client.buildFileDownloadUrl(file.filePath) };
}

export async function checkTelegramLocalBotApi(client: TelegramBotApiClient): Promise<TelegramHealthReport> {
  const issues: string[] = [];
  let bot: TelegramUser | undefined;
  let webhookInfo: TelegramWebhookInfo | undefined;
  try {
    bot = await client.getMe();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "getMe failed");
  }

  try {
    webhookInfo = await client.getWebhookInfo();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "getWebhookInfo failed");
  }

  const localBaseUrlLikely = !isCloudTelegramBaseUrl(client.config.baseUrl);
  if (!localBaseUrlLikely) {
    issues.push("TELEGRAM_BOT_API_BASE_URL points to api.telegram.org; use Telegram Local Bot API Server for large files");
  }

  return {
    ok: issues.length === 0,
    localBaseUrlLikely,
    issues,
    ...(bot ? { bot } : {}),
    ...(webhookInfo ? { webhookInfo } : {}),
  };
}

export function parseTelegramUpdate(update: TelegramUpdate): ParsedTelegramMessage | null {
  const message = update.message;
  if (!message) {
    return null;
  }
  const parsed: ParsedTelegramMessage = {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: String(message.chat.id),
    date: message.date,
    files: collectMessageFiles(message),
  };
  if (message.from?.id !== undefined) {
    parsed.userId = String(message.from.id);
  }
  if (message.text !== undefined) {
    parsed.text = message.text;
  }
  if (message.caption !== undefined) {
    parsed.caption = message.caption;
  }
  return parsed;
}

export function parseTelegramCallbackQuery(update: TelegramUpdate): ParsedTelegramCallback | null {
  const callback = update.callback_query;
  if (!callback) {
    return null;
  }
  const parsed: ParsedTelegramCallback = {
    updateId: update.update_id,
    callbackQueryId: callback.id,
  };
  if (callback.from.id !== undefined) {
    parsed.userId = String(callback.from.id);
  }
  if (callback.message?.chat.id !== undefined) {
    parsed.chatId = String(callback.message.chat.id);
  }
  if (callback.message?.message_id !== undefined) {
    parsed.messageId = callback.message.message_id;
  }
  if (callback.data !== undefined) {
    parsed.data = callback.data;
  }
  return parsed;
}

export function parseTelegramCommand(value: string | undefined): ParsedTelegramCommand | null {
  const raw = value?.trim();
  if (!raw?.startsWith("/")) {
    return null;
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  const commandToken = tokens[0];
  if (!commandToken) {
    return null;
  }
  const commandName = commandToken.slice(1).split("@")[0]?.toLowerCase() ?? "";
  const name = toCommandName(commandName);
  const args = tokens.slice(1);
  const tags: string[] = [];
  let project: string | undefined;
  let targetJobId: string | undefined;
  const instructionTokens: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("project:")) {
      project = arg.slice("project:".length);
      continue;
    }
    if (arg.startsWith("tag:")) {
      const tag = arg.slice("tag:".length);
      if (tag) {
        tags.push(tag);
      }
      continue;
    }
    if (arg.startsWith("tags:")) {
      for (const tag of arg.slice("tags:".length).split(",")) {
        if (tag.trim()) {
          tags.push(tag.trim());
        }
      }
      continue;
    }
    if ((name === "status" || name === "retry" || name === "cancel") && targetJobId === undefined) {
      targetJobId = arg;
      continue;
    }
    instructionTokens.push(arg);
  }

  const command: ParsedTelegramCommand = {
    name,
    raw,
    args,
    tags,
  };
  assignDefined(command, "project", project);
  assignDefined(command, "targetJobId", targetJobId);
  assignDefined(command, "instructions", instructionTokens.length > 0 ? instructionTokens.join(" ") : undefined);
  return command;
}

export function getMessageCommand(message: ParsedTelegramMessage): ParsedTelegramCommand | null {
  return parseTelegramCommand(message.caption) ?? parseTelegramCommand(message.text);
}

export function isTelegramUserAllowed(userId: string | undefined, allowedUserIds: string[]): boolean {
  if (!userId || allowedUserIds.length === 0) {
    return false;
  }
  return allowedUserIds.includes(userId);
}

export function isAbsoluteFilePath(filePath: string): boolean {
  return path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath);
}

function isCloudTelegramBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "api.telegram.org";
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function collectMessageFiles(message: TelegramMessage): ParsedTelegramFile[] {
  const files: ParsedTelegramFile[] = [];
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    files.push(fileFromPayload("photo", photo));
  }
  if (message.document) {
    files.push(fileFromPayload("document", message.document));
  }
  if (message.audio) {
    files.push(fileFromPayload("audio", message.audio));
  }
  if (message.voice) {
    files.push(fileFromPayload("voice", message.voice));
  }
  if (message.video) {
    files.push(fileFromPayload("video", message.video));
  }
  return files;
}

function selectLargestPhoto(photos: TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  if (!photos || photos.length === 0) {
    return undefined;
  }
  return [...photos].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function fileFromPayload(kind: ParsedTelegramFileKind, payload: TelegramFilePayload | TelegramPhotoSize): ParsedTelegramFile {
  const file: ParsedTelegramFile = {
    kind,
    fileId: payload.file_id,
  };
  assignDefined(file, "fileUniqueId", payload.file_unique_id);
  assignDefined(file, "fileName", "file_name" in payload ? payload.file_name : undefined);
  assignDefined(file, "mimeType", "mime_type" in payload ? payload.mime_type : undefined);
  assignDefined(file, "fileSize", payload.file_size);
  return file;
}

function toCommandName(value: string): TelegramCommandName {
  if (value === "ingest" || value === "status" || value === "retry" || value === "cancel") {
    return value;
  }
  return "unknown";
}

function assignDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
