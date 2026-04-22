import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addJobFile,
  createJob,
  getJob,
  listJobEvents,
  listJobFiles,
  migrate,
  openIngestDatabase,
  transitionJob,
} from "@telegram-local-ingest/db";
import { FileImportError, importTelegramJobFiles } from "@telegram-local-ingest/importer";
import { TelegramBotApiClient, type FetchLike, type TelegramGetFileResult } from "@telegram-local-ingest/telegram";

const NOW = "2026-04-22T10:00:00.000Z";

test("importTelegramJobFiles copies Telegram local files into staging and archive", async () => {
  const fixture = createFixture();
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    const sourcePath = writeFixtureFile(fixture.botRoot, "documents/lead.txt", "hello lead");
    createQueuedJobWithFiles(handle.db, [
      { id: "file-1", sourceFileId: "tg-file-1", originalName: "lead.txt" },
    ]);
    const client = mockTelegramClient(fixture.botRoot, {
      "tg-file-1": {
        file_id: "tg-file-1",
        file_unique_id: "uniq-1",
        file_size: 10,
        file_path: "documents/lead.txt",
      },
    });

    const result = await importTelegramJobFiles(handle.db, client, "job-1", {
      runtimeDir: fixture.runtimeDir,
      maxFileSizeBytes: 1024,
      now: NOW,
    });

    assert.equal(result.importedFiles.length, 1);
    assert.equal(getJob(handle.db, "job-1")?.status, "NORMALIZING");

    const imported = listJobFiles(handle.db, "job-1")[0];
    assert.ok(imported?.sha256);
    assert.equal(imported.sha256, sha256("hello lead"));
    assert.ok(imported.localPath?.startsWith(path.join(fixture.runtimeDir, "staging")));
    assert.ok(imported.archivePath?.startsWith(path.join(fixture.runtimeDir, "archive", "originals")));
    assert.notEqual(imported.localPath, sourcePath);
    assert.equal(fs.readFileSync(imported.localPath!, "utf8"), "hello lead");
    assert.equal(fs.readFileSync(imported.archivePath!, "utf8"), "hello lead");

    assert.ok(listJobEvents(handle.db, "job-1").some((event) => event.type === "file.imported"));
  } finally {
    handle.close();
  }
});

test("importTelegramJobFiles detects duplicate content by sha256", async () => {
  const fixture = createFixture();
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    writeFixtureFile(fixture.botRoot, "documents/first.txt", "same content");
    writeFixtureFile(fixture.botRoot, "documents/second.txt", "same content");
    createQueuedJobWithFiles(handle.db, [
      { id: "file-1", sourceFileId: "tg-file-1", originalName: "first.txt" },
      { id: "file-2", sourceFileId: "tg-file-2", originalName: "second.txt" },
    ]);
    const client = mockTelegramClient(fixture.botRoot, {
      "tg-file-1": { file_id: "tg-file-1", file_size: 12, file_path: "documents/first.txt" },
      "tg-file-2": { file_id: "tg-file-2", file_size: 12, file_path: "documents/second.txt" },
    });

    const result = await importTelegramJobFiles(handle.db, client, "job-1", {
      runtimeDir: fixture.runtimeDir,
      maxFileSizeBytes: 1024,
      now: NOW,
    });

    assert.equal(result.importedFiles[1]?.duplicateOfFileId, "file-1");
    const files = listJobFiles(handle.db, "job-1");
    assert.equal(files[0]?.sha256, files[1]?.sha256);
    assert.equal(files[0]?.archivePath, files[1]?.archivePath);
    assert.ok(listJobEvents(handle.db, "job-1").some((event) => event.type === "file.duplicate"));
  } finally {
    handle.close();
  }
});

test("importTelegramJobFiles fails oversized files and marks the job failed", async () => {
  const fixture = createFixture();
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    writeFixtureFile(fixture.botRoot, "documents/large.bin", "too large");
    createQueuedJobWithFiles(handle.db, [
      { id: "file-1", sourceFileId: "tg-file-1", originalName: "large.bin" },
    ]);
    const client = mockTelegramClient(fixture.botRoot, {
      "tg-file-1": { file_id: "tg-file-1", file_size: 9, file_path: "documents/large.bin" },
    });

    await assert.rejects(
      () =>
        importTelegramJobFiles(handle.db, client, "job-1", {
          runtimeDir: fixture.runtimeDir,
          maxFileSizeBytes: 4,
          now: NOW,
        }),
      FileImportError,
    );
    assert.equal(getJob(handle.db, "job-1")?.status, "FAILED");
    assert.match(getJob(handle.db, "job-1")?.error ?? "", /max size policy/);
  } finally {
    handle.close();
  }
});

test("importTelegramJobFiles rejects absolute paths outside localFilesRoot", async () => {
  const fixture = createFixture();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-local-outside-"));
  const outsidePath = writeFixtureFile(outsideDir, "secret.txt", "secret");
  const handle = openIngestDatabase(":memory:");
  try {
    migrate(handle.db);
    createQueuedJobWithFiles(handle.db, [
      { id: "file-1", sourceFileId: "tg-file-1", originalName: "secret.txt" },
    ]);
    const client = mockTelegramClient(fixture.botRoot, {
      "tg-file-1": { file_id: "tg-file-1", file_size: 6, file_path: outsidePath },
    });

    await assert.rejects(
      () =>
        importTelegramJobFiles(handle.db, client, "job-1", {
          runtimeDir: fixture.runtimeDir,
          maxFileSizeBytes: 1024,
          now: NOW,
        }),
      /outside TELEGRAM_LOCAL_FILES_ROOT/,
    );
    assert.equal(getJob(handle.db, "job-1")?.status, "FAILED");
  } finally {
    handle.close();
  }
});

function createQueuedJobWithFiles(
  db: Parameters<typeof createJob>[0],
  files: Array<{ id: string; sourceFileId: string; originalName: string }>,
): void {
  createJob(db, { id: "job-1", source: "telegram-local-bot-api", now: NOW });
  transitionJob(db, "job-1", "QUEUED", { now: NOW });
  for (const file of files) {
    addJobFile(db, {
      id: file.id,
      jobId: "job-1",
      sourceFileId: file.sourceFileId,
      originalName: file.originalName,
      now: NOW,
    });
  }
}

function createFixture(): { botRoot: string; runtimeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-importer-"));
  return {
    botRoot: path.join(root, "bot-root"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function writeFixtureFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function mockTelegramClient(botRoot: string, files: Record<string, TelegramGetFileResult>): TelegramBotApiClient {
  return new TelegramBotApiClient(
    { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: botRoot },
    mockFetch((method, body) => {
      if (method !== "getFile") {
        return { ok: false, description: "unexpected method", error_code: 400 };
      }
      const fileId = (body as { file_id?: string }).file_id;
      const result = fileId ? files[fileId] : undefined;
      return result
        ? { ok: true, result }
        : { ok: false, description: "file not found", error_code: 404 };
    }),
  );
}

function mockFetch(handler: (method: string, body: unknown) => unknown): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    assert.ok(method);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return jsonResponse(handler(method, body));
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
