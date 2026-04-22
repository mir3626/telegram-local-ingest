import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig, loadNearestEnvFile } from "@telegram-local-ingest/core";
import { checkTelegramLocalBotApi, TelegramBotApiClient } from "@telegram-local-ingest/telegram";

export async function main(): Promise<void> {
  loadNearestEnvFile();
  const config = loadConfig();
  const telegramConfig = {
    botToken: config.telegram.botToken,
    baseUrl: config.telegram.botApiBaseUrl,
    ...(config.telegram.localFilesRoot ? { localFilesRoot: config.telegram.localFilesRoot } : {}),
  };
  const client = new TelegramBotApiClient(telegramConfig);
  const health = await checkTelegramLocalBotApi(client);
  if (!health.ok) {
    throw new Error(`Telegram startup check failed: ${health.issues.join("; ")}`);
  }
  console.log(`telegram-local-ingest worker ready: bot=${health.bot?.username ?? health.bot?.first_name ?? "unknown"}`);
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
