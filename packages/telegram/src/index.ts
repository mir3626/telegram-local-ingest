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
    return { kind: "local-path", path: path.normalize(file.filePath) };
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
