import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import zlib from "node:zlib";

import type { AgentPostprocessInput, AgentPostprocessResult } from "@telegram-local-ingest/agent-adapter";
import type { AppConfig } from "@telegram-local-ingest/core";
import {
  addJobFile,
  createJob,
  createSourceBundle,
  createJobOutput,
  getJob,
  getJobOutput,
  getTelegramOffset,
  listJobEvents,
  listJobOutputs,
  migrate,
  mustGetSourceBundleForJob,
  openIngestDatabase,
  requestRetry,
  transitionJob,
} from "@telegram-local-ingest/db";
import type { RtzrTranscribeConfig, RtzrTranscript, WaitForTranscriptionOptions } from "@telegram-local-ingest/rtzr";
import type { SenseVoiceTranscribeOptions, SenseVoiceTranscript } from "@telegram-local-ingest/sensevoice";
import { TelegramBotApiClient, type FetchLike } from "@telegram-local-ingest/telegram";

import {
  pollTelegramUpdatesOnce,
  processJob,
  processRunnableJobs,
  runWorkerLoop,
  runWorkerOnce,
  type AgentPostprocessor,
  type RtzrTranscriber,
  type SenseVoiceTranscriber,
  type WorkerContext,
} from "../apps/worker/src/index.js";

test("runWorkerOnce captures, imports, bundles, completes, and notifies", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/lead.txt", "This customer contract requires translation.");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.deepEqual(result, {
      updatesSeen: 1,
      operatorCommandsHandled: 0,
      jobsCreated: 1,
      jobsProcessed: 1,
    });
    assert.equal(getTelegramOffset(dbHandle.db, "123:abc"), 11);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "documents", "lead.txt")), false);
    const bundle = mustGetSourceBundleForJob(dbHandle.db, "tg_300_21");
    assert.ok(fs.existsSync(bundle.manifestPath));
    assert.equal(bundle.sourceMarkdownPath.endsWith("source.md"), true);
    assert.deepEqual(sentMessages.map((message) => message.text), [
      "📥 접수했어요: tg_300_21\n- lead.txt",
      "✅ 처리 완료: tg_300_21 (sales)\n- lead.txt",
    ]);
    const events = listJobEvents(dbHandle.db, "tg_300_21");
    const languageEvent = events.find((event) => event.type === "language.detected");
    assert.ok(events.some((event) => event.type === "preprocess.completed"));
    assert.ok(languageEvent);
    assert.equal((languageEvent.data as { primaryLanguage: string }).primaryLanguage, "en");
    assert.equal((languageEvent.data as { translationNeeded: boolean }).translationNeeded, true);
    assert.ok(events.some((event) => event.type === "wiki.skipped"));
    assert.ok(events.some((event) => event.type === "telegram_source.deleted"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce runs agent postprocess for translation-needed text and sends a download button", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/lead.txt", "This vendor agreement needs translation and business formatting.");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages),
      ),
      agent: mockAgentPostprocessor(agentInputs),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(agentInputs.length, 1);
    assert.equal(agentInputs[0]?.language.translationNeeded, true);
    assert.equal(agentInputs[0]?.targetLanguage, "ko");
    assert.equal(agentInputs[0]?.defaultRelation, "business");
    assert.ok(agentInputs[0]?.artifacts.some((artifact) => artifact.fileName === "lead.txt"));
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.kind, "agent_translation");
    assert.equal(outputs[0]?.fileName, "lead_translated.pdf");
    assert.equal(outputs[0]?.mimeType, "application/pdf");
    assert.equal(fs.readFileSync(outputs[0]?.filePath ?? "").subarray(0, 4).toString("utf8"), "%PDF");
    assert.equal(fs.existsSync(path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "translated.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "lead_translated.pdf")), true);
    const completion = sentMessages.at(-1);
    assert.match(completion?.text ?? "", /자동번역이 완료되었습니다/);
    assert.match(completion?.text ?? "", /만료 시각/);
    assert.match(completion?.text ?? "", /lead_translated\.pdf: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST/);
    assert.match(JSON.stringify(completion?.reply_markup), /download:/);
    assert.match(JSON.stringify(completion?.reply_markup), /PDF 다운로드/);
    assert.match(JSON.stringify(completion?.reply_markup), /까지/);
    const events = listJobEvents(dbHandle.db, "tg_300_21");
    assert.ok(events.some((event) => event.type === "agent.postprocess.completed"));
    assert.ok(events.some((event) => event.type === "output.created"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce preserves DOCX templates by replacing structured text blocks", async () => {
  const fixture = createFixture();
  writeMinimalDocx(
    fixture.botRoot,
    "documents/vendor-template.docx",
    "This vendor agreement needs translation and business formatting.",
  );
  const toolRoot = path.join(fixture.root, "tools");
  const failingPandoc = writeExecutable(toolRoot, "pandoc", [
    "#!/bin/sh",
    "echo 'pandoc should not run for template-preserved DOCX' >&2",
    "exit 99",
  ].join("\n"));
  const oldPandoc = process.env.PANDOC_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    process.env.PANDOC_BIN = failingPandoc;
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales tag:lead", "documents/vendor-template.docx"),
      ),
      agent: mockAgentPostprocessor(agentInputs),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.ok(agentInputs[0]?.artifacts.some((artifact) => artifact.structurePath?.endsWith("vendor-template.blocks.json")));
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.fileName, "vendor-template_translated.docx");
    assert.equal(outputs[0]?.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const documentXml = extractZipEntry(fs.readFileSync(outputs[0]?.filePath ?? ""), "word/document.xml")?.toString("utf8") ?? "";
    assert.match(documentXml, /번역 결과/);
    assert.match(documentXml, /w:pStyle w:val="TemplateBody"/);
    assert.match(documentXml, /\[원문\]/);
    assert.match(documentXml, /This vendor agreement needs translation/);
    const renderedDocx = path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "vendor-template_translated.docx");
    assert.ok(extractZipEntry(fs.readFileSync(renderedDocx), "word/document.xml"));
    assert.equal(fs.existsSync(path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "translated.md")), false);
    assert.equal(fs.existsSync(path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "translations.json")), false);
    assert.match(JSON.stringify(sentMessages.at(-1)?.reply_markup), /DOCX 다운로드/);
  } finally {
    restoreEnv("PANDOC_BIN", oldPandoc);
    dbHandle.close();
  }
});

test("runWorkerOnce renders PDF uploads as DOCX downloads when extracted text needs translation", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/chinese-food-law.pdf", "%PDF-1.4\n");
  const toolRoot = path.join(fixture.root, "tools");
  const fakePandoc = writeFakePandoc(toolRoot);
  const fakePdftotext = writeExecutable(toolRoot, "pdftotext", [
    "#!/bin/sh",
    "printf 'Chinese food law requires Korean translation.\\nArticle 1. Scope\\n'",
  ].join("\n"));
  const oldPandoc = process.env.PANDOC_BIN;
  const oldPdftotext = process.env.PDFTOTEXT_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    process.env.PANDOC_BIN = fakePandoc;
    process.env.PDFTOTEXT_BIN = fakePdftotext;
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales", "documents/chinese-food-law.pdf"),
      ),
      agent: mockAgentPostprocessor(agentInputs),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(agentInputs.length, 1);
    assert.ok(agentInputs[0]?.artifacts.some((artifact) => artifact.kind === "pdf_text"));
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.fileName, "chinese-food-law_translated.docx");
    assert.equal(outputs[0]?.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const documentXml = extractZipEntry(fs.readFileSync(outputs[0]?.filePath ?? ""), "word/document.xml")?.toString("utf8") ?? "";
    assert.match(documentXml, /\[원문\]/);
    assert.match(documentXml, /Chinese food law requires Korean translation/);
    assert.match(JSON.stringify(sentMessages.at(-1)?.reply_markup), /DOCX 다운로드/);
  } finally {
    restoreEnv("PANDOC_BIN", oldPandoc);
    restoreEnv("PDFTOTEXT_BIN", oldPdftotext);
    dbHandle.close();
  }
});

test("runWorkerOnce ignores agent-created DOCX and renders document output from Markdown", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/vendor-policy.pdf", "%PDF-1.4\n");
  const toolRoot = path.join(fixture.root, "tools");
  const fakePandoc = writeFakePandoc(toolRoot, "정상 번역 결과");
  const fakePdftotext = writeExecutable(toolRoot, "pdftotext", [
    "#!/bin/sh",
    "printf 'Vendor policy requires Korean translation.\\n'",
  ].join("\n"));
  const oldPandoc = process.env.PANDOC_BIN;
  const oldPdftotext = process.env.PDFTOTEXT_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  try {
    process.env.PANDOC_BIN = fakePandoc;
    process.env.PDFTOTEXT_BIN = fakePdftotext;
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales", "documents/vendor-policy.pdf"),
      ),
      agent: {
        async postprocess(input): Promise<AgentPostprocessResult> {
          fs.mkdirSync(input.outputDir, { recursive: true });
          fs.writeFileSync(path.join(input.outputDir, "translated.md"), "정상 번역 결과\n", "utf8");
          fs.writeFileSync(path.join(input.outputDir, "translated.docx"), "sandbox blocked arbitrary binary ZIP creation", "utf8");
          return {
            command: "custom-agent",
            args: ["--prompt", "prompt.md"],
            promptPath: path.join(input.outputDir, "..", ".agent-work", "prompt.md"),
            outputDir: input.outputDir,
            stdout: "ok",
            stderr: "",
          };
        },
      },
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs[0]?.fileName, "vendor-policy_translated.docx");
    const outputXml = extractZipEntry(fs.readFileSync(outputs[0]?.filePath ?? ""), "word/document.xml")?.toString("utf8") ?? "";
    assert.match(outputXml, /정상 번역 결과/);
    assert.match(outputXml, /Vendor policy requires Korean translation/);
    assert.doesNotMatch(outputXml, /sandbox blocked arbitrary binary ZIP creation/);
    assert.equal(fs.existsSync(path.join(fixture.runtimeDir, "agent-postprocess", "tg_300_21", "outputs", "translated.docx")), false);
  } finally {
    restoreEnv("PANDOC_BIN", oldPandoc);
    restoreEnv("PDFTOTEXT_BIN", oldPdftotext);
    dbHandle.close();
  }
});

test("runWorkerOnce renders EML uploads as DOCX downloads with original message text", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/vendor-update.eml", [
    "From: Vendor <vendor@example.com>",
    "To: Operator <operator@example.com>",
    "Subject: Vendor update",
    "Date: Fri, 24 Apr 2026 10:30:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This vendor update requires Korean translation and business formatting.",
  ].join("\r\n"));
  const toolRoot = path.join(fixture.root, "tools");
  const fakePandoc = writeFakePandoc(toolRoot);
  const oldPandoc = process.env.PANDOC_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    process.env.PANDOC_BIN = fakePandoc;
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales", "documents/vendor-update.eml"),
      ),
      agent: mockAgentPostprocessor(agentInputs),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(agentInputs.length, 1);
    assert.equal(agentInputs[0]?.artifacts[0]?.kind, "eml_text");
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.fileName, "vendor-update_translated.docx");
    assert.equal(outputs[0]?.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const rendered = extractZipEntry(fs.readFileSync(outputs[0]?.filePath ?? ""), "word/document.xml")?.toString("utf8") ?? "";
    assert.match(rendered, /\[원문\]/);
    assert.match(rendered, /Subject: Vendor update/);
    assert.match(rendered, /This vendor update requires Korean translation/);
    assert.match(JSON.stringify(sentMessages.at(-1)?.reply_markup), /DOCX 다운로드/);
  } finally {
    restoreEnv("PANDOC_BIN", oldPandoc);
    dbHandle.close();
  }
});

test("runWorkerOnce fails PDF agent jobs when text extraction and OCR are unavailable", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/source.pdf", "%PDF-1.4\n");
  const oldPdftotext = process.env.PDFTOTEXT_BIN;
  const oldPdftoppm = process.env.PDFTOPPM_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    process.env.PDFTOTEXT_BIN = path.join(fixture.root, "tools", "missing-pdftotext");
    process.env.PDFTOPPM_BIN = path.join(fixture.root, "tools", "missing-pdftoppm");
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales", "documents/source.pdf"),
      ),
      agent: mockAgentPostprocessor(agentInputs),
    };

    await assert.rejects(
      () => runWorkerOnce(context),
      /Source text extraction is required for agent postprocess.*pdf_ocr_tool_missing/,
    );

    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "FAILED");
    assert.equal(agentInputs.length, 0);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "preprocess.completed"));
    assert.equal(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "language.detected"), false);
    const failureMessage = sentMessages.at(-1);
    assert.match(failureMessage?.text ?? "", /Source text extraction is required for agent postprocess/);
    assert.match(JSON.stringify(failureMessage?.reply_markup), /retry:tg_300_21/);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", oldPdftotext);
    restoreEnv("PDFTOPPM_BIN", oldPdftoppm);
    dbHandle.close();
  }
});

test("runWorkerOnce sanitizes extracted PDF text before appending it to DOCX output", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/chinese-food-law.pdf", "%PDF-1.4\n");
  const toolRoot = path.join(fixture.root, "tools");
  const fakePdftotext = writeExecutable(toolRoot, "pdftotext", [
    "#!/bin/sh",
    "printf 'Chinese food law A\\001B <tag> & value requires Korean translation.\\n'",
  ].join("\n"));
  const fakePandoc = writeFakePandoc(toolRoot);
  const oldPdftotext = process.env.PDFTOTEXT_BIN;
  const oldPandoc = process.env.PANDOC_BIN;
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const agentInputs: AgentPostprocessInput[] = [];
  try {
    process.env.PDFTOTEXT_BIN = fakePdftotext;
    process.env.PANDOC_BIN = fakePandoc;
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent --prompt {promptFile} --output {outputDir}",
      timeoutMs: 30 * 60 * 1000,
    };
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/ingest project:sales", "documents/chinese-food-law.pdf"),
      ),
      agent: {
        async postprocess(input): Promise<AgentPostprocessResult> {
          agentInputs.push(input);
          fs.mkdirSync(input.outputDir, { recursive: true });
          fs.writeFileSync(path.join(input.outputDir, "translated.md"), "번역 결과\n", "utf8");
          return {
            command: "custom-agent",
            args: ["--prompt", "prompt.md"],
            promptPath: path.join(input.outputDir, "..", ".agent-work", "prompt.md"),
            outputDir: input.outputDir,
            stdout: "ok",
            stderr: "",
          };
        },
      },
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(agentInputs.length, 1);
    const outputs = listJobOutputs(dbHandle.db, "tg_300_21");
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.fileName, "chinese-food-law_translated.docx");
    const documentXml = extractZipEntry(fs.readFileSync(outputs[0]?.filePath ?? ""), "word/document.xml")?.toString("utf8") ?? "";
    assert.doesNotMatch(documentXml, /\u0001/);
    assert.match(documentXml, /Chinese food law AB &lt;tag&gt; &amp; value requires Korean translation/);
  } finally {
    restoreEnv("PDFTOTEXT_BIN", oldPdftotext);
    restoreEnv("PANDOC_BIN", oldPandoc);
    dbHandle.close();
  }
});

test("runWorkerOnce treats file uploads without captions as ingest jobs", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "documents/upload-only.txt", "upload only");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, undefined, "documents/upload-only.txt"),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.jobsCreated, 1);
    assert.equal(result.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "documents", "upload-only.txt")), false);
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce asks for RTZR preset on audio uploads and queues after callback", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
    };

    const first = await runWorkerOnce(context);

    assert.equal(first.jobsCreated, 1);
    assert.equal(first.jobsProcessed, 0);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "RECEIVED");
    assert.match(sentMessages[0]?.text ?? "", /🎧 음성 파일 업로드/);
    assert.match(JSON.stringify(sentMessages[0]?.reply_markup), /회의/);
    assert.match(JSON.stringify(sentMessages[0]?.reply_markup), /stt:meeting/);

    const second = await runWorkerOnce(context);

    assert.equal(second.operatorCommandsHandled, 1);
    assert.equal(second.jobsProcessed, 0);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "RECEIVED");
    assert.match(sentMessages[1]?.text ?? "", /어떤 언어/);
    assert.match(JSON.stringify(sentMessages[1]?.reply_markup), /stt-lang:meeting:ko:tg_300_21/);

    const third = await runWorkerOnce(context);

    assert.equal(third.operatorCommandsHandled, 1);
    assert.equal(third.jobsProcessed, 1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "COMPLETED");
    assert.equal(fs.existsSync(path.join(fixture.botRoot, "audio", "call.m4a")), false);
    assert.ok(answeredCallbacks.length > 0);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "stt.preset_selected"));
    assert.ok(
      fs.readFileSync(mustGetSourceBundleForJob(dbHandle.db, "tg_300_21").manifestPath, "utf8")
        .includes("default_relation: \"business\""),
    );
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce transcribes audio with the selected RTZR preset and bundles artifacts", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  const rtzrCalls: Array<{ filePath: string; config: RtzrTranscribeConfig; waitOptions: WaitForTranscriptionOptions }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks, "en"),
      ),
      rtzr: mockRtzrTranscriber(rtzrCalls),
    };

    await runWorkerOnce(context);
    await runWorkerOnce(context);
    await runWorkerOnce(context);

    const bundle = mustGetSourceBundleForJob(dbHandle.db, "tg_300_21");
    const manifest = fs.readFileSync(bundle.manifestPath, "utf8");
    assert.equal(rtzrCalls.length, 1);
    assert.equal(rtzrCalls[0]?.config.model_name, "whisper");
    assert.equal(rtzrCalls[0]?.config.language, "en");
    assert.equal(rtzrCalls[0]?.config.use_diarization, true);
    assert.equal(rtzrCalls[0]?.waitOptions.pollIntervalMs, 5000);
    assert.match(manifest, /language:/);
    assert.match(manifest, /model_name: "whisper"/);
    assert.match(manifest, /call\.rtzr\.json/);
    assert.match(manifest, /call\.transcript\.md/);
    assert.match(fs.readFileSync(path.join(bundle.bundlePath, "extracted", "call.transcript.md"), "utf8"), /회의 내용입니다/);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "rtzr.transcribed"));
    const languageEvent = listJobEvents(dbHandle.db, "tg_300_21").find((event) => event.type === "language.detected");
    assert.equal((languageEvent?.data as { primaryLanguage: string }).primaryLanguage, "ko");
    assert.equal((languageEvent?.data as { translationNeeded: boolean }).translationNeeded, false);
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce transcribes audio with SenseVoice on demand and bundles artifacts", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  const senseVoiceCalls: Array<{ filePath: string; options: SenseVoiceTranscribeOptions }> = [];
  try {
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.stt.provider = "sensevoice";
    config.sensevoice.pythonPath = ".venv-sensevoice/bin/python";
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
      sensevoice: mockSenseVoiceTranscriber(senseVoiceCalls),
    };

    await runWorkerOnce(context);
    await runWorkerOnce(context);
    await runWorkerOnce(context);

    const bundle = mustGetSourceBundleForJob(dbHandle.db, "tg_300_21");
    const manifest = fs.readFileSync(bundle.manifestPath, "utf8");
    assert.equal(senseVoiceCalls.length, 1);
    assert.equal(senseVoiceCalls[0]?.options.device, "cpu");
    assert.equal(senseVoiceCalls[0]?.options.language, "ko");
    assert.match(manifest, /provider: "sensevoice"/);
    assert.match(manifest, /call\.sensevoice\.json/);
    assert.match(manifest, /call\.transcript\.md/);
    assert.match(fs.readFileSync(path.join(bundle.bundlePath, "extracted", "call.transcript.md"), "utf8"), /센스보이스 전사입니다/);
    assert.ok(listJobEvents(dbHandle.db, "tg_300_21").some((event) => event.type === "sensevoice.transcribed"));
  } finally {
    dbHandle.close();
  }
});

test("runWorkerOnce sends a retry button when processing fails", async () => {
  const fixture = createFixture();
  writeFile(fixture.botRoot, "audio/call.m4a", "fake audio");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    const config = configFixture(fixture);
    config.stt.provider = "sensevoice";
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockAudioPresetFetch(sentMessages, answeredCallbacks),
      ),
      sensevoice: mockFailingSenseVoiceTranscriber("sensevoice failed"),
    };

    await runWorkerOnce(context);
    await runWorkerOnce(context);
    await assert.rejects(() => runWorkerOnce(context), /sensevoice failed/);

    const failureMessage = sentMessages.at(-1);
    assert.equal(getJob(dbHandle.db, "tg_300_21")?.status, "FAILED");
    assert.match(failureMessage?.text ?? "", /⚠️ 처리 실패: tg_300_21\nsensevoice failed/);
    assert.match(JSON.stringify(failureMessage?.reply_markup), /retry:tg_300_21/);
    assert.match(JSON.stringify(failureMessage?.reply_markup), /다시 처리/);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce retries a failed job from a retry button", async () => {
  const fixture = createFixture();
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-retry",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    transitionJob(dbHandle.db, "job-retry", "QUEUED", { now: "2026-04-22T12:00:01.000Z" });
    transitionJob(dbHandle.db, "job-retry", "IMPORTING", { now: "2026-04-22T12:00:02.000Z" });
    transitionJob(dbHandle.db, "job-retry", "FAILED", { now: "2026-04-22T12:00:03.000Z", error: "boom" });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockRetryCallbackFetch(sentMessages, answeredCallbacks),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(result.jobsCreated, 0);
    assert.equal(getJob(dbHandle.db, "job-retry")?.status, "QUEUED");
    assert.equal(getJob(dbHandle.db, "job-retry")?.retryCount, 1);
    assert.match(JSON.stringify(answeredCallbacks[0]), /재시도 대기열/);
    assert.equal(sentMessages.at(-1)?.text, "🔁 재시도 대기열에 넣었어요: job-retry");
  } finally {
    dbHandle.close();
  }
});

test("processJob reuses an existing finalized raw bundle when a retry reaches bundle writing again", async () => {
  const fixture = createFixture();
  const originalPath = writeFile(fixture.runtimeDir, "archive/originals/aa/hash/lead.txt", "This contract still needs translation.");
  const bundlePath = path.join(fixture.vaultPath, "raw", "2026-04-22", "job-retry");
  const manifestPath = writeFile(fixture.vaultPath, "raw/2026-04-22/job-retry/manifest.yaml", "schema_version: 1\n");
  const sourceMarkdownPath = writeFile(fixture.vaultPath, "raw/2026-04-22/job-retry/source.md", "# Source\n");
  writeFile(fixture.vaultPath, "raw/2026-04-22/job-retry/.finalized", "finalized_at=2026-04-22T12:00:00.000Z\n");
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-retry",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      project: "sales",
      now: NOW_FOR_TESTS,
    });
    transitionJob(dbHandle.db, "job-retry", "QUEUED", { now: NOW_FOR_TESTS });
    addJobFile(dbHandle.db, {
      id: "file-1",
      jobId: "job-retry",
      sourceFileId: "file-1",
      fileUniqueId: "file-1-unique",
      originalName: "lead.txt",
      mimeType: "text/plain",
      sizeBytes: 38,
      sha256: "hash",
      localPath: originalPath,
      archivePath: originalPath,
      now: NOW_FOR_TESTS,
    });
    transitionJob(dbHandle.db, "job-retry", "IMPORTING", { now: NOW_FOR_TESTS });
    transitionJob(dbHandle.db, "job-retry", "NORMALIZING", { now: NOW_FOR_TESTS });
    transitionJob(dbHandle.db, "job-retry", "BUNDLE_WRITING", { now: NOW_FOR_TESTS });
    createSourceBundle(dbHandle.db, {
      id: "job-retry",
      jobId: "job-retry",
      bundlePath,
      manifestPath,
      sourceMarkdownPath,
      finalizedAt: NOW_FOR_TESTS,
      now: NOW_FOR_TESTS,
    });
    transitionJob(dbHandle.db, "job-retry", "INGESTING", { now: NOW_FOR_TESTS });
    transitionJob(dbHandle.db, "job-retry", "FAILED", { now: NOW_FOR_TESTS, error: "agent failed" });
    const retryRequested = requestRetry(dbHandle.db, "job-retry", { now: NOW_FOR_TESTS, message: "Retry requested" });
    transitionJob(dbHandle.db, retryRequested.id, "QUEUED", { now: NOW_FOR_TESTS, message: "Retry queued" });
    transitionJob(dbHandle.db, "job-retry", "IMPORTING", { now: NOW_FOR_TESTS, message: "Retry importing" });
    transitionJob(dbHandle.db, "job-retry", "NORMALIZING", { now: NOW_FOR_TESTS, message: "Retry normalizing" });
    transitionJob(dbHandle.db, "job-retry", "BUNDLE_WRITING", { now: NOW_FOR_TESTS, message: "Retry writing bundle" });

    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages),
      ),
    };

    const result = await processJob(context, "job-retry");

    assert.equal(result.status, "COMPLETED");
    assert.equal(getJob(dbHandle.db, "job-retry")?.status, "COMPLETED");
    assert.ok(listJobEvents(dbHandle.db, "job-retry").some((event) => event.type === "bundle.reused"));
    assert.match(sentMessages.at(-1)?.text ?? "", /✅ 처리 완료: job-retry \(sales\)/);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce sends active output documents from a download button", async () => {
  const fixture = createFixture();
  const outputPath = writeFile(fixture.runtimeDir, "outputs/job-download/out-1/translated.md", "translated");
  const dbHandle = openIngestDatabase(":memory:");
  const sentDocuments: Array<{ chat_id: string; caption?: string; document?: string }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-download",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "out-1",
      jobId: "job-download",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      mimeType: "text/markdown",
      createdAt: "2026-04-22T12:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockDownloadCallbackFetch(sentDocuments, answeredCallbacks),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.match(JSON.stringify(answeredCallbacks[0]), /파일을 전송/);
    assert.deepEqual(sentDocuments, [{
      chat_id: "300",
      caption: "📎 translated.md",
      document: "translated.md",
    }]);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce still sends output documents when callback answer expires", async () => {
  const fixture = createFixture();
  const outputPath = writeFile(fixture.runtimeDir, "outputs/job-download/out-1/translated.md", "translated");
  const dbHandle = openIngestDatabase(":memory:");
  const sentDocuments: Array<{ chat_id: string; caption?: string; document?: string }> = [];
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-download",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "out-1",
      jobId: "job-download",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      mimeType: "text/markdown",
      createdAt: "2026-04-22T12:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockDownloadCallbackFetch(sentDocuments, answeredCallbacks, { answerFails: true }),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.deepEqual(sentDocuments, [{
      chat_id: "300",
      caption: "📎 translated.md",
      document: "translated.md",
    }]);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce handles hidden output discard callbacks", async () => {
  const fixture = createFixture();
  const outputPath = writeFile(fixture.runtimeDir, "outputs/job-output/out-discard/translated.md", "translated");
  const dbHandle = openIngestDatabase(":memory:");
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-output",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "out-discard",
      jobId: "job-output",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      createdAt: "2026-04-22T12:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockOutputLifecycleCallbackFetch("output-discard:out-discard", answeredCallbacks),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(fs.existsSync(outputPath), false);
    assert.ok(getJobOutput(dbHandle.db, "out-discard")?.deletedAt);
    assert.match(JSON.stringify(answeredCallbacks[0]), /폐기/);
  } finally {
    dbHandle.close();
  }
});

test("pollTelegramUpdatesOnce records hidden output regenerate callbacks", async () => {
  const fixture = createFixture();
  const outputPath = writeFile(fixture.runtimeDir, "outputs/job-output/out-regen/translated.md", "translated");
  const dbHandle = openIngestDatabase(":memory:");
  const answeredCallbacks: unknown[] = [];
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-output",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "out-regen",
      jobId: "job-output",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      createdAt: "2026-04-22T12:00:01.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockOutputLifecycleCallbackFetch("output-regenerate:out-regen", answeredCallbacks),
      ),
    };

    const result = await pollTelegramUpdatesOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(fs.existsSync(outputPath), true);
    assert.ok(listJobEvents(dbHandle.db, "job-output").some((event) => event.type === "output.regenerate_requested"));
    assert.match(JSON.stringify(answeredCallbacks[0]), /다시 생성 요청/);
  } finally {
    dbHandle.close();
  }
});

test("runWorkerLoop cleans expired outputs on the scheduled cadence", async () => {
  const fixture = createFixture();
  const outputPath = writeFile(fixture.runtimeDir, "outputs/job-expired/out-old/old.md", "old output");
  const dbHandle = openIngestDatabase(":memory:");
  const abort = new AbortController();
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, {
      id: "job-expired",
      source: "telegram-local-bot-api",
      chatId: "300",
      userId: "400",
      now: "2026-04-22T12:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "out-old",
      jobId: "job-expired",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "old.md",
      createdAt: "2026-04-22T12:01:00.000Z",
      expiresAt: "2026-04-22T12:02:00.000Z",
    });
    const context: WorkerContext = {
      config: {
        ...configFixture(fixture),
        worker: {
          ...configFixture(fixture).worker,
          outputCleanupIntervalMs: 60_000,
        },
      },
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockEmptyUpdatesFetch(),
      ),
    };

    setTimeout(() => abort.abort(), 5);
    await runWorkerLoop(context, { pollIntervalMs: 1, abortSignal: abort.signal });

    assert.equal(fs.existsSync(outputPath), false);
    assert.ok(getJobOutput(dbHandle.db, "out-old")?.deletedAt);
  } finally {
    abort.abort();
    dbHandle.close();
  }
});

test("runWorkerOnce handles operator status without creating a job", async () => {
  const fixture = createFixture();
  const dbHandle = openIngestDatabase(":memory:");
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  try {
    migrate(dbHandle.db);
    const context: WorkerContext = {
      config: configFixture(fixture),
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch(sentMessages, "/status", null),
      ),
    };

    const result = await runWorkerOnce(context);

    assert.equal(result.operatorCommandsHandled, 1);
    assert.equal(result.jobsCreated, 0);
    assert.deepEqual(sentMessages.map((message) => message.text), ["📭 작업이 없습니다."]);
  } finally {
    dbHandle.close();
  }
});

test("processRunnableJobs claims multiple jobs while limiting STT concurrency", async () => {
  const fixture = createFixture();
  const firstAudio = writeFile(fixture.runtimeDir, "staging/job-a/file-a/call-a.m4a", "fake audio a");
  const secondAudio = writeFile(fixture.runtimeDir, "staging/job-b/file-b/call-b.m4a", "fake audio b");
  const dbHandle = openIngestDatabase(":memory:");
  const calls: Array<{ filePath: string; options: SenseVoiceTranscribeOptions }> = [];
  const releaseFirst = deferred<void>();
  const releaseSecond = deferred<void>();
  try {
    migrate(dbHandle.db);
    createNormalizingAudioJob(dbHandle.db, "job-a", "file-a", "call-a.m4a", firstAudio);
    createNormalizingAudioJob(dbHandle.db, "job-b", "file-b", "call-b.m4a", secondAudio);
    const config = configFixture(fixture);
    config.stt.provider = "sensevoice";
    config.worker.jobConcurrency = 2;
    config.worker.sttConcurrency = 1;
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockTelegramFetch([]),
      ),
      sensevoice: {
        async transcribeFile(filePath, options): Promise<SenseVoiceTranscript> {
          calls.push({ filePath, options });
          if (calls.length === 1) {
            await releaseFirst.promise;
          } else {
            await releaseSecond.promise;
          }
          return {
            id: `sensevoice-${calls.length}`,
            text: `전사 ${calls.length}`,
            segments: [{ text: `전사 ${calls.length}`, language: "ko" }],
            raw: {
              id: `sensevoice-${calls.length}`,
              provider: "sensevoice",
              text: `전사 ${calls.length}`,
              segments: [{ text: `전사 ${calls.length}`, language: "ko" }],
            },
          };
        },
      },
    };

    const processing = processRunnableJobs(context, 2, { waitForCompletion: false });
    assert.equal(await processing, 2);
    await waitFor(() => calls.length === 1);
    assert.equal(calls.length, 1);
    assert.equal(getJob(dbHandle.db, "job-a")?.status, "NORMALIZING");
    assert.equal(getJob(dbHandle.db, "job-b")?.status, "NORMALIZING");

    releaseFirst.resolve();
    await waitFor(() => calls.length === 2);
    assert.equal(calls.length, 2);
    releaseSecond.resolve();
    await waitFor(() => getJob(dbHandle.db, "job-a")?.status === "COMPLETED" && getJob(dbHandle.db, "job-b")?.status === "COMPLETED");
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    dbHandle.close();
  }
});

test("processRunnableJobs does not gate translation-skipped jobs behind agent concurrency", async () => {
  const fixture = createFixture();
  const agentInput = writeFile(fixture.runtimeDir, "archive/originals/agent/lead.txt", "This contract requires Korean translation.");
  const skippedInput = writeFile(fixture.runtimeDir, "archive/originals/skip/korean.txt", "한국어 문서입니다. 번역이 필요하지 않습니다.");
  const dbHandle = openIngestDatabase(":memory:");
  const releaseAgent = deferred<void>();
  const agentCalls: AgentPostprocessInput[] = [];
  try {
    migrate(dbHandle.db);
    createIngestingTextJob(dbHandle.db, fixture, "job-agent", "file-agent", "lead.txt", agentInput);
    createIngestingTextJob(dbHandle.db, fixture, "job-skip", "file-skip", "korean.txt", skippedInput);
    const config = configFixture(fixture);
    config.agent = {
      provider: "custom",
      command: "custom-agent",
      timeoutMs: 30 * 60 * 1000,
    };
    config.worker.agentConcurrency = 1;
    const context: WorkerContext = {
      config,
      db: dbHandle.db,
      telegram: new TelegramBotApiClient(
        { botToken: "123:abc", baseUrl: "http://127.0.0.1:8081", localFilesRoot: fixture.botRoot },
        mockEmptyUpdatesFetch(),
      ),
      agent: {
        async postprocess(input): Promise<AgentPostprocessResult> {
          agentCalls.push(input);
          await releaseAgent.promise;
          fs.mkdirSync(input.outputDir, { recursive: true });
          fs.writeFileSync(path.join(input.outputDir, "translated.md"), "번역 결과\n", "utf8");
          return {
            command: "custom-agent",
            args: [],
            promptPath: path.join(input.outputDir, "..", ".agent-work", "prompt.md"),
            outputDir: input.outputDir,
            stdout: "ok",
            stderr: "",
          };
        },
      },
    };

    assert.equal(await processRunnableJobs(context, 2, { waitForCompletion: false }), 2);
    await waitFor(() => agentCalls.length === 1 && getJob(dbHandle.db, "job-skip")?.status === "COMPLETED");
    assert.equal(getJob(dbHandle.db, "job-agent")?.status, "INGESTING");

    releaseAgent.resolve();
    await waitFor(() => getJob(dbHandle.db, "job-agent")?.status === "COMPLETED");
  } finally {
    releaseAgent.resolve();
    dbHandle.close();
  }
});

function configFixture(fixture: { runtimeDir: string; vaultPath: string; botRoot: string }): AppConfig {
  return {
    telegram: {
      botToken: "123:abc",
      botApiBaseUrl: "http://127.0.0.1:8081",
      localFilesRoot: fixture.botRoot,
      allowedUserIds: ["400"],
      pollTimeoutSeconds: 1,
    },
    runtime: {
      runtimeDir: fixture.runtimeDir,
      sqliteDbPath: ":memory:",
      wikiWriteLockPath: path.join(fixture.runtimeDir, "wiki.lock"),
      maxFileSizeBytes: 1024,
    },
    vault: {
      obsidianVaultPath: fixture.vaultPath,
      rawRoot: "raw",
    },
    stt: {
      provider: "rtzr",
    },
    rtzr: {
      apiBaseUrl: "https://openapi.vito.ai",
      ffmpegPath: "ffmpeg",
      pollIntervalMs: 5000,
      timeoutMs: 30 * 60 * 1000,
      rateLimitBackoffMs: 30_000,
    },
    sensevoice: {
      pythonPath: "python3",
      scriptPath: "./scripts/sensevoice-transcribe.py",
      model: "iic/SenseVoiceSmall",
      vadModel: "fsmn-vad",
      device: "cpu",
      language: "auto",
      useItn: true,
      batchSizeSeconds: 60,
      mergeVad: true,
      mergeLengthSeconds: 15,
      maxSingleSegmentTimeMs: 30_000,
      timeoutMs: 60 * 60 * 1000,
    },
    wiki: {},
    translation: {
      defaultRelation: "business",
      targetLanguage: "ko",
    },
    agent: {
      provider: "none",
      timeoutMs: 30 * 60 * 1000,
    },
    worker: {
      jobConcurrency: 2,
      sttConcurrency: 1,
      agentConcurrency: 1,
      jobClaimTtlMs: 2 * 60 * 60 * 1000,
      outputCleanupIntervalMs: 10 * 60 * 1000,
    },
  };
}

function createIngestingTextJob(
  db: DatabaseSync,
  fixture: { vaultPath: string },
  jobId: string,
  fileId: string,
  originalName: string,
  localPath: string,
): void {
  createJob(db, {
    id: jobId,
    source: "telegram-local-bot-api",
    chatId: "300",
    userId: "400",
    now: NOW_FOR_TESTS,
  });
  transitionJob(db, jobId, "QUEUED", { now: NOW_FOR_TESTS });
  addJobFile(db, {
    id: fileId,
    jobId,
    originalName,
    mimeType: "text/plain",
    sizeBytes: 10,
    localPath,
    archivePath: localPath,
    now: NOW_FOR_TESTS,
  });
  transitionJob(db, jobId, "IMPORTING", { now: NOW_FOR_TESTS });
  transitionJob(db, jobId, "NORMALIZING", { now: NOW_FOR_TESTS });
  transitionJob(db, jobId, "BUNDLE_WRITING", { now: NOW_FOR_TESTS });
  const bundlePath = path.join(fixture.vaultPath, "raw", "2026-04-22", jobId);
  const manifestPath = writeFile(bundlePath, "manifest.yaml", "schema_version: 1\n");
  const sourceMarkdownPath = writeFile(bundlePath, "source.md", "# Source\n");
  writeFile(bundlePath, ".finalized", "finalized_at=2026-04-22T12:00:00.000Z\n");
  createSourceBundle(db, {
    id: jobId,
    jobId,
    bundlePath,
    manifestPath,
    sourceMarkdownPath,
    finalizedAt: NOW_FOR_TESTS,
    now: NOW_FOR_TESTS,
  });
  transitionJob(db, jobId, "INGESTING", { now: NOW_FOR_TESTS });
}

function createNormalizingAudioJob(
  db: DatabaseSync,
  jobId: string,
  fileId: string,
  originalName: string,
  localPath: string,
): void {
  createJob(db, {
    id: jobId,
    source: "telegram-local-bot-api",
    chatId: "300",
    userId: "400",
    now: NOW_FOR_TESTS,
  });
  transitionJob(db, jobId, "QUEUED", { now: NOW_FOR_TESTS });
  addJobFile(db, {
    id: fileId,
    jobId,
    sourceFileId: fileId,
    fileUniqueId: `${fileId}-unique`,
    originalName,
    mimeType: "audio/mp4",
    sizeBytes: 10,
    localPath,
    archivePath: localPath,
    now: NOW_FOR_TESTS,
  });
  transitionJob(db, jobId, "IMPORTING", { now: NOW_FOR_TESTS });
  transitionJob(db, jobId, "NORMALIZING", { now: NOW_FOR_TESTS });
}

const NOW_FOR_TESTS = "2026-04-22T12:00:00.000Z";

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function createFixture(): { root: string; botRoot: string; runtimeDir: string; vaultPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-loop-"));
  return {
    root,
    botRoot: path.join(root, "bot-root"),
    runtimeDir: path.join(root, "runtime"),
    vaultPath: path.join(root, "vault"),
  };
}

function writeFile(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeExecutable(root: string, fileName: string, content: string): string {
  const filePath = path.join(root, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function writeFakePandoc(root: string, translatedText = "번역 결과"): string {
  const templatePath = writeMinimalDocx(root, "pandoc-template.docx", translatedText);
  return writeExecutable(root, "pandoc", [
    "#!/bin/sh",
    "out=\"\"",
    "prev=\"\"",
    "for arg in \"$@\"; do",
    "  if [ \"$prev\" = \"--output\" ]; then out=\"$arg\"; fi",
    "  prev=\"$arg\"",
    "done",
    "if [ -z \"$out\" ]; then echo 'missing --output' >&2; exit 2; fi",
    `cp ${JSON.stringify(templatePath)} "$out"`,
  ].join("\n"));
}

function writeMinimalDocx(root: string, relativePath: string, textContent: string): string {
  const escaped = textContent
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body><w:p><w:pPr><w:pStyle w:val="TemplateBody"/></w:pPr><w:r><w:t>',
    escaped,
    "</w:t></w:r></w:p></w:body></w:document>",
  ].join("");
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildZip({
    "[Content_Types].xml": [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      "</Types>",
    ].join(""),
    "word/document.xml": documentXml,
  }));
  return filePath;
}

function buildZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentBuffer = Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(contentBuffer);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contentBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(localHeader, 30);
    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contentBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBuffer.copy(centralHeader, 46);
    centralParts.push(centralHeader);

    localOffset += localHeader.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(centralParts.length, 8);
  endOfCentralDirectory.writeUInt16LE(centralParts.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

function extractZipEntry(zip: Buffer, entryName: string): Buffer | null {
  const eocdOffset = findEndOfCentralDirectory(zip);
  let centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const centralEnd = centralOffset + zip.readUInt32LE(eocdOffset + 12);
  while (centralOffset < centralEnd) {
    if (zip.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory header not found");
    }
    const compressionMethod = zip.readUInt16LE(centralOffset + 10);
    const compressedSize = zip.readUInt32LE(centralOffset + 20);
    const fileNameLength = zip.readUInt16LE(centralOffset + 28);
    const extraFieldLength = zip.readUInt16LE(centralOffset + 30);
    const fileCommentLength = zip.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = zip.readUInt32LE(centralOffset + 42);
    const name = zip.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength).toString("utf8").replaceAll("\\", "/");
    if (name === entryName) {
      return inflateZipEntry(zip, localHeaderOffset, compressedSize, compressionMethod);
    }
    centralOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return null;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 65_557);
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("Invalid ZIP: end of central directory not found");
}

function inflateZipEntry(zip: Buffer, localHeaderOffset: number, compressedSize: number, compressionMethod: number): Buffer {
  if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error("Invalid ZIP: local file header not found");
  }
  const fileNameLength = zip.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = zip.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
  if (compressionMethod === 0) {
    return compressed;
  }
  if (compressionMethod === 8) {
    return zlib.inflateRawSync(compressed);
  }
  throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function mockTelegramFetch(
  sentMessages: Array<{ chat_id: string; text: string }>,
  text: string | undefined = "/ingest project:sales tag:lead",
  filePath: string | null = "documents/lead.txt",
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [
          {
            update_id: 11,
            message: {
              message_id: 21,
              date: 1_777_000_001,
              chat: { id: 300, type: "private" },
              from: { id: 400, is_bot: false, first_name: "Tony" },
              ...(text !== undefined ? { caption: text } : {}),
              ...(filePath
                ? {
                    document: {
                      file_id: "doc-file",
                      file_unique_id: "doc-unique",
                      file_name: path.basename(filePath),
                      mime_type: mimeTypeForFixture(filePath),
                      file_size: 12,
                    },
                  }
                : {}),
            },
          },
        ],
      });
    }
    if (method === "getFile") {
      return jsonResponse({
        ok: true,
        result: {
          file_id: "doc-file",
          file_unique_id: "doc-unique",
          file_size: 12,
          file_path: filePath ?? "documents/lead.txt",
        },
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockEmptyUpdatesFetch(sentMessages: Array<{ chat_id: string; text: string }> = []): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      return jsonResponse({ ok: true, result: [] });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mimeTypeForFixture(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".eml":
      return "message/rfc822";
    case ".pdf":
      return "application/pdf";
    default:
      return "text/plain";
  }
}

function mockAudioPresetFetch(
  sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }>,
  answeredCallbacks: unknown[],
  languageKey = "ko",
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      const offset = (body as { offset?: number }).offset;
      if (offset === undefined) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 11,
            message: {
              message_id: 21,
              date: 1_777_000_001,
              chat: { id: 300, type: "private" },
              from: { id: 400, is_bot: false, first_name: "Tony" },
              audio: {
                file_id: "audio-file",
                file_unique_id: "audio-unique",
                file_name: "call.m4a",
                mime_type: "audio/mp4",
                file_size: 10,
              },
            },
          }],
        });
      }
      if (offset === 12) {
        return jsonResponse({
          ok: true,
          result: [{
            update_id: 12,
            callback_query: {
              id: "callback-1",
              from: { id: 400, is_bot: false, first_name: "Tony" },
              message: {
                message_id: 22,
                date: 1_777_000_002,
                chat: { id: 300, type: "private" },
                text: "preset",
              },
              data: "stt:meeting:tg_300_21",
            },
          }],
        });
      }
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 13,
          callback_query: {
            id: "callback-2",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 23,
              date: 1_777_000_003,
              chat: { id: 300, type: "private" },
              text: "language",
            },
            data: `stt-lang:meeting:${languageKey}:tg_300_21`,
          },
        }],
      });
    }
    if (method === "getFile") {
      return jsonResponse({
        ok: true,
        result: {
          file_id: "audio-file",
          file_unique_id: "audio-unique",
          file_size: 10,
          file_path: "audio/call.m4a",
        },
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string; reply_markup?: unknown });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 99,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockRetryCallbackFetch(
  sentMessages: Array<{ chat_id: string; text: string; reply_markup?: unknown }>,
  answeredCallbacks: unknown[],
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 31,
          callback_query: {
            id: "retry-callback-1",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 32,
              date: 1_777_000_003,
              chat: { id: 300, type: "private" },
              text: "failed",
            },
            data: "retry:job-retry",
          },
        }],
      });
    }
    if (method === "sendMessage") {
      sentMessages.push(body as { chat_id: string; text: string; reply_markup?: unknown });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 100,
          date: 1,
          chat: { id: Number((body as { chat_id: string }).chat_id), type: "private" },
          text: (body as { text: string }).text,
        },
      });
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockDownloadCallbackFetch(
  sentDocuments: Array<{ chat_id: string; caption?: string; document?: string }>,
  answeredCallbacks: unknown[],
  options: { answerFails?: boolean } = {},
): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    const body = init?.body instanceof FormData ? init.body : undefined;
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 41,
          callback_query: {
            id: "download-callback-1",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 42,
              date: 1_777_000_004,
              chat: { id: 300, type: "private" },
              text: "download",
            },
            data: "download:out-1",
          },
        }],
      });
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(init?.body ? JSON.parse(String(init.body)) : {});
      if (options.answerFails) {
        return jsonResponse({
          ok: false,
          description: "Bad Request: query is too old and response timeout expired or query ID is invalid",
          error_code: 400,
        }, 400);
      }
      return jsonResponse({ ok: true, result: true });
    }
    if (method === "sendDocument" && body) {
      const document = body.get("document");
      sentDocuments.push({
        chat_id: String(body.get("chat_id")),
        caption: String(body.get("caption")),
        ...(typeof document === "string" ? { document } : {}),
        ...(typeof document !== "string" && document?.name ? { document: document.name } : {}),
      });
      return jsonResponse({
        ok: true,
        result: {
          message_id: 101,
          date: 1,
          chat: { id: 300, type: "private" },
          document: { file_id: "doc", file_name: "translated.md" },
        },
      });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockOutputLifecycleCallbackFetch(data: string, answeredCallbacks: unknown[]): FetchLike {
  return async (input, init) => {
    const method = input.split("/").at(-1);
    if (method === "getUpdates") {
      return jsonResponse({
        ok: true,
        result: [{
          update_id: 43,
          callback_query: {
            id: "output-lifecycle-callback-1",
            from: { id: 400, is_bot: false, first_name: "Tony" },
            message: {
              message_id: 44,
              date: 1_777_000_005,
              chat: { id: 300, type: "private" },
              text: "output",
            },
            data,
          },
        }],
      });
    }
    if (method === "answerCallbackQuery") {
      answeredCallbacks.push(init?.body ? JSON.parse(String(init.body)) : {});
      return jsonResponse({ ok: true, result: true });
    }
    return jsonResponse({ ok: false, description: `unexpected method: ${method}`, error_code: 400 }, 400);
  };
}

function mockAgentPostprocessor(calls: AgentPostprocessInput[]): AgentPostprocessor {
  return {
    async postprocess(input): Promise<AgentPostprocessResult> {
      calls.push(input);
      fs.mkdirSync(input.outputDir, { recursive: true });
      fs.writeFileSync(path.join(input.outputDir, "translated.md"), "번역 결과\n", "utf8");
      const structuredArtifact = input.artifacts.find((artifact) => artifact.structurePath);
      if (structuredArtifact?.structurePath) {
        const structure = JSON.parse(fs.readFileSync(structuredArtifact.structurePath, "utf8")) as {
          blocks?: Array<{ id: string; text: string }>;
        };
        fs.writeFileSync(path.join(input.outputDir, "translations.json"), `${JSON.stringify({
          schemaVersion: 1,
          blocks: (structure.blocks ?? []).map((block) => ({
            id: block.id,
            text: block.id === "b0001" ? "번역 결과" : `번역 결과 ${block.id}`,
          })),
        }, null, 2)}\n`, "utf8");
      }
      return {
        command: "custom-agent",
        args: ["--prompt", "prompt.md"],
        promptPath: path.join(input.outputDir, "..", ".agent-work", "prompt.md"),
        outputDir: input.outputDir,
        stdout: "ok",
        stderr: "",
      };
    },
  };
}

function mockSenseVoiceTranscriber(
  calls: Array<{ filePath: string; options: SenseVoiceTranscribeOptions }>,
): SenseVoiceTranscriber {
  return {
    async transcribeFile(filePath, options): Promise<SenseVoiceTranscript> {
      calls.push({ filePath, options });
      return {
        id: "sensevoice-1",
        text: "센스보이스 전사입니다",
        segments: [{ text: "센스보이스 전사입니다", language: "ko" }],
        raw: {
          id: "sensevoice-1",
          provider: "sensevoice",
          text: "센스보이스 전사입니다",
          segments: [{ text: "센스보이스 전사입니다", language: "ko" }],
        },
      };
    },
  };
}

function mockFailingSenseVoiceTranscriber(message: string): SenseVoiceTranscriber {
  return {
    async transcribeFile(): Promise<SenseVoiceTranscript> {
      throw new Error(message);
    },
  };
}

function mockRtzrTranscriber(
  calls: Array<{ filePath: string; config: RtzrTranscribeConfig; waitOptions: WaitForTranscriptionOptions }>,
): RtzrTranscriber {
  return {
    async transcribeFile(filePath, config, waitOptions): Promise<RtzrTranscript> {
      calls.push({ filePath, config, waitOptions });
      return {
        id: "rtzr-1",
        text: "회의 내용입니다",
        raw: {
          id: "rtzr-1",
          status: "completed",
          results: {
            utterances: [{ start_at: 0, duration: 1000, msg: "회의 내용입니다", spk: 0, lang: "ko" }],
          },
        },
      };
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
