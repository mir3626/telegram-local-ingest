#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  addJobFile,
  createJob,
  createSourceBundle,
  listJobEvents,
  migrate,
  openIngestDatabase,
  transitionJob,
} from "@telegram-local-ingest/db";
import {
  collectPreprocessedTextArtifacts,
  type PreprocessedTextArtifact,
} from "@telegram-local-ingest/preprocessors";
import {
  writeRawBundle,
  type RawBundleArtifactInput,
} from "@telegram-local-ingest/vault";

type SourceRecord = {
  jobId: string;
  fileName: string;
  sourcePath: string;
  sourcePage: string;
  canonicalCount: number;
  skippedCount: number;
};

type ArtifactSmokeResult = {
  artifactId: string;
  rendererId: string;
  runId: string;
  bundlePath: string;
  wikiPagePath?: string;
  artifactPaths: string[];
};

type GuardResult = {
  name: string;
  status: "passed";
  detail: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDir);
const cliEntry = path.join(projectRoot, "apps", "ops-cli", "src", "index.ts");
const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 18);
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function main() {
  await loadEnvFile(path.join(projectRoot, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const vaultRoot = path.resolve(args.get("vault") ?? requiredEnv("OBSIDIAN_VAULT_PATH"));
  const runtimeDir = process.env.INGEST_RUNTIME_DIR
    ? path.resolve(projectRoot, process.env.INGEST_RUNTIME_DIR)
    : path.join(projectRoot, "runtime");
  const sqliteDbPath = process.env.SQLITE_DB_PATH
    ? path.resolve(projectRoot, process.env.SQLITE_DB_PATH)
    : path.join(runtimeDir, "ingest.db");
  const sourceDir = path.resolve(args.get("source-dir") ?? path.join(vaultRoot, "to-be-removed"));
  const resultRoot = path.resolve(args.get("result-dir") ?? path.join(vaultRoot, "to-be-removed-result"));
  const resultDir = path.join(resultRoot, stamp);
  const requestDir = path.join(runtimeDir, "smoke", "wiki-renderers", stamp, "requests");
  const preprocessRoot = path.join(runtimeDir, "smoke", "wiki-renderers", stamp, "preprocess");

  assertInside(vaultRoot, sourceDir, "source-dir");
  assertInside(vaultRoot, resultRoot, "result-dir");
  await assertDirectory(vaultRoot, "vault");
  await assertDirectory(sourceDir, "source-dir");
  await fs.mkdir(requestDir, { recursive: true });
  await fs.mkdir(resultDir, { recursive: true });

  const dbHandle = openIngestDatabase(sqliteDbPath);
  try {
    migrate(dbHandle.db);
    const sourceFiles = await listInputFiles(sourceDir);
    if (sourceFiles.length === 0) {
      throw new Error(`No smoke input files found under ${sourceDir}`);
    }

    const sources: SourceRecord[] = [];
    for (const filePath of sourceFiles) {
      sources.push(await ingestLocalFile({
        db: dbHandle.db,
        filePath,
        sourceDir,
        vaultRoot,
        runtimeDir,
        preprocessRoot,
      }));
    }

    const runs: ArtifactSmokeResult[] = [];
    const guards: GuardResult[] = [];
    const fxSources = await pickFxSourcePages(vaultRoot, "2025-04-01", "2025-10-31", 3);
    const invoiceSources = requireSources(sources, (source) => /(^|[/\\])invoice[_-]\d+/i.test(source.sourcePath), 3, "invoice documents");
    const meetingSources = requireSources(sources, (source) => /meeting|memo_01_call/i.test(source.fileName), 1, "meeting or call notes");
    const timelineSources = requireSources(sources, (source) => /email_|contract_|meeting_|memo_/i.test(source.fileName), 3, "timeline-capable documents");
    const reportSources = requireSources(sources, (source) => /contract_|coa_|tds_|spec_|email_/i.test(source.fileName), 3, "report documents");
    const glossarySources = requireSources(sources, (source) => /contract_|coa_|tds_|spec_|label_|email_/i.test(source.fileName), 3, "glossary documents");

    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: generic recent one-year FX chart.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "chart",
        artifactId: `qa_fx_chart_1y_${stamp}`,
        title: "QA 최근 1년 환율 라인차트",
        renderer: { mode: "registered", id: "fx.chart.1y" },
        sources: [],
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/fx_chart_1y.png"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: USD and EUR FX statistics for 2025-04 through 2025-10.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "fx_stats",
        artifactId: `qa_fx_stats_period_${stamp}`,
        title: "QA USD EUR 환율 기간 통계",
        renderer: { mode: "registered", id: "fx.stats.period" },
        sources: [{ path: "wiki/sources/fx_koreaexim_2025{04..10}*.md", type: "wiki_source" }],
        parameters: { currencies: ["USD", "EUR"], startDate: "2025-04-01", endDate: "2025-10-31", chartFormats: ["png"] },
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/chart.png", "artifacts/stats.csv", "artifacts/summary.docx"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: exact-date FX comparison table.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "comparison_table",
        artifactId: `qa_table_compare_fx_${stamp}`,
        title: "QA 특정일 환율 비교표",
        renderer: { mode: "registered", id: "table.compare" },
        sources: fxSources.map((sourcePath) => ({ path: sourcePath, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/comparison_table.docx", "artifacts/comparison_table.csv", "artifacts/comparison_table.xlsx"],
      contentChecks: [{ relativePath: "artifacts/comparison_table.csv", includes: ["USD", "2025", "Deal Basis"] }],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: compare invoice source pages.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "comparison_table",
        artifactId: `qa_table_compare_invoices_${stamp}`,
        title: "QA 인보이스 비교표",
        renderer: { mode: "registered", id: "table.compare" },
        sources: invoiceSources.slice(0, 4).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/comparison_table.docx", "artifacts/comparison_table.csv", "artifacts/comparison_table.xlsx"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: summary report from selected business documents.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "summary_report",
        artifactId: `qa_summary_report_${stamp}`,
        title: "QA 업무 문서 요약 보고서",
        renderer: { mode: "registered", id: "report.summary" },
        sources: reportSources.slice(0, 5).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/summary_report.docx"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: timeline from e-mails, contract, meeting notes, and call memo.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "timeline",
        artifactId: `qa_timeline_extract_${stamp}`,
        title: "QA 거래 타임라인",
        renderer: { mode: "registered", id: "timeline.extract" },
        sources: timelineSources.slice(0, 6).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/timeline.docx", "artifacts/timeline.json"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: vendor invoice summary from invoice PDFs.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "invoice_summary",
        artifactId: `qa_invoice_vendor_summary_${stamp}`,
        title: "QA 업체별 인보이스 요약",
        renderer: { mode: "registered", id: "invoice.vendor-summary" },
        sources: invoiceSources.map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/invoice_summary.csv", "artifacts/report.docx"],
      minCsvRows: { relativePath: "artifacts/invoice_summary.csv", minRows: 1 },
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: action items from meeting/STT-like notes.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "action_items",
        artifactId: `qa_meeting_actions_${stamp}`,
        title: "QA 회의 액션아이템",
        renderer: { mode: "registered", id: "meeting.actions" },
        sources: meetingSources.map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/action_items.docx", "artifacts/action_items.csv"],
      minCsvRows: { relativePath: "artifacts/action_items.csv", minRows: 1 },
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: glossary candidates from business documents.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "glossary",
        artifactId: `qa_glossary_extract_${stamp}`,
        title: "QA 문서 기반 용어집",
        renderer: { mode: "registered", id: "glossary.extract" },
        sources: glossarySources.slice(0, 8).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/glossary.docx", "artifacts/glossary.csv"],
      minCsvRows: { relativePath: "artifacts/glossary.csv", minRows: 1 },
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: topic index for enzyme supplier and product documents.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "topic_index",
        artifactId: `qa_topic_index_${stamp}`,
        title: "QA 효소 원료 거래 인덱스",
        renderer: { mode: "registered", id: "wiki.index.topic" },
        sources: glossarySources.slice(0, 8).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: { topic: "enzyme supplier and product documents" },
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: ["artifacts/topic_index.docx", "artifacts/topic_index.json"],
    }));
    runs.push(await runArtifact({
      requestDir,
      prompt: "Renderer QA: NotebookLM manual export pack.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "notebooklm_export",
        artifactId: `qa_notebooklm_export_${stamp}`,
        title: "QA NotebookLM 수동 업로드 팩",
        renderer: { mode: "registered", id: "notebooklm.export-pack" },
        sources: reportSources.slice(0, 5).map((source) => ({ path: source.sourcePage, type: "wiki_source" })),
        parameters: {
          purpose: "Renderer QA manual NotebookLM export pack",
          desiredOutputs: ["briefing", "quiz", "slides"],
          language: "ko",
          redactionMode: "none",
          maxSourceChars: 12000,
        },
        delivery: { sendToTelegram: false, ingestDerived: true },
      },
      expectedFiles: [],
      expectedArtifactSuffixes: ["_notebooklm_export.zip"],
    }));

    guards.push(await expectArtifactFailure({
      requestDir,
      name: "fx.chart.1y rejects custom source/date requests",
      prompt: "Renderer QA guard: fx.chart.1y must reject custom request.",
      expectedMessage: "fx.stats.period",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "chart",
        artifactId: `qa_guard_fx_chart_custom_${stamp}`,
        title: "QA guard custom FX chart",
        renderer: { mode: "registered", id: "fx.chart.1y" },
        sources: [{ path: fxSources[0], type: "wiki_source" }],
        parameters: { currency: "USD", startDate: "2025-04-01", endDate: "2025-10-31" },
        delivery: { sendToTelegram: false, ingestDerived: false },
      },
    }));
    guards.push(await expectArtifactFailure({
      requestDir,
      name: "fx.stats.period rejects missing requested currencies",
      prompt: "Renderer QA guard: fx.stats.period must reject absent currency.",
      expectedMessage: "GBP",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "fx_stats",
        artifactId: `qa_guard_fx_missing_currency_${stamp}`,
        title: "QA guard missing FX currency",
        renderer: { mode: "registered", id: "fx.stats.period" },
        sources: [{ path: fxSources[0], type: "wiki_source" }],
        parameters: { currencies: ["USD", "GBP"], startDate: "2025-04-01", endDate: "2025-10-31" },
        delivery: { sendToTelegram: false, ingestDerived: false },
      },
    }));
    guards.push(await runEmptyCsvGuard({
      requestDir,
      name: "invoice.vendor-summary skips unrelated FX sources",
      prompt: "Renderer QA guard: invoice renderer should not turn FX data into invoices.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "invoice_summary",
        artifactId: `qa_guard_invoice_fx_${stamp}`,
        title: "QA guard invoice false positive",
        renderer: { mode: "registered", id: "invoice.vendor-summary" },
        sources: [{ path: fxSources[0], type: "wiki_source" }],
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: false },
      },
      csvPath: "artifacts/invoice_summary.csv",
    }));
    guards.push(await runEmptyCsvGuard({
      requestDir,
      name: "meeting.actions skips unrelated FX sources",
      prompt: "Renderer QA guard: meeting renderer should not turn FX data into action items.",
      request: {
        schemaVersion: "tlgi.artifact.request.v1",
        action: "create_derived_artifact",
        artifactKind: "action_items",
        artifactId: `qa_guard_meeting_fx_${stamp}`,
        title: "QA guard meeting false positive",
        renderer: { mode: "registered", id: "meeting.actions" },
        sources: [{ path: fxSources[0], type: "wiki_source" }],
        parameters: {},
        delivery: { sendToTelegram: false, ingestDerived: false },
      },
      csvPath: "artifacts/action_items.csv",
    }));

    await copySmokeArtifacts({ resultDir, runs });
    await writeSummary({ resultDir, sourceDir, sources, runs, guards });
    await assertCleanReconcile("after wiki renderer smoke");

    process.stdout.write("Wiki renderer QA smoke passed.\n");
    process.stdout.write(`sources=${sources.length}\n`);
    process.stdout.write(`runs=${runs.length}\n`);
    process.stdout.write(`guards=${guards.length}\n`);
    process.stdout.write(`result=${resultDir}\n`);
    for (const run of runs) {
      process.stdout.write(`- ${run.rendererId} ${run.runId}\n`);
      process.stdout.write(`  bundle=${run.bundlePath}\n`);
      if (run.wikiPagePath) {
        process.stdout.write(`  wiki=${run.wikiPagePath}\n`);
      }
    }
  } finally {
    dbHandle.close();
  }
}

async function ingestLocalFile(input: {
  db: DatabaseSync;
  filePath: string;
  sourceDir: string;
  vaultRoot: string;
  runtimeDir: string;
  preprocessRoot: string;
}): Promise<SourceRecord> {
  const relative = path.relative(input.sourceDir, input.filePath).replace(/\\/g, "/");
  const stem = safeName(path.basename(input.filePath, path.extname(input.filePath)));
  const jobId = `qa_renderer_${stamp}_${stem}`;
  const fileId = `${jobId}_file`;
  const now = new Date().toISOString();
  const stat = await fs.stat(input.filePath);
  const sha256 = await sha256File(input.filePath);
  const job = createJob(input.db, {
    id: jobId,
    source: "local",
    project: "renderer-qa",
    tags: ["renderer-qa", "to-be-removed"],
    instructions: `Renderer QA source imported from to-be-removed/${relative}`,
    now,
  });
  const file = addJobFile(input.db, {
    id: fileId,
    jobId,
    originalName: path.basename(input.filePath),
    mimeType: mimeTypeForPath(input.filePath),
    sizeBytes: stat.size,
    sha256,
    localPath: input.filePath,
    archivePath: input.filePath,
    now,
  });
  transitionJob(input.db, job.id, "QUEUED", { now, message: "Renderer QA queued local source" });
  transitionJob(input.db, job.id, "IMPORTING", { now, message: "Renderer QA reuses local source file" });
  transitionJob(input.db, job.id, "NORMALIZING", { now, message: "Renderer QA normalizing source" });
  transitionJob(input.db, job.id, "BUNDLE_WRITING", { now, message: "Renderer QA writing raw bundle" });

  const preprocessing = await collectPreprocessedTextArtifacts({
    job,
    files: [file],
    artifactRoot: path.join(input.preprocessRoot, job.id),
    includeBundledTranscripts: false,
  });
  const bundle = await writeRawBundle({
    vaultPath: input.vaultRoot,
    rawRoot: "raw",
    job,
    files: [file],
    events: listJobEvents(input.db, job.id),
    extractedArtifacts: preprocessedArtifactsToRawBundleInputs(preprocessing.artifacts),
    now,
  });
  createSourceBundle(input.db, {
    id: bundle.id,
    jobId: job.id,
    bundlePath: bundle.paths.root,
    manifestPath: bundle.paths.manifest,
    sourceMarkdownPath: bundle.paths.sourceMarkdown,
    finalizedAt: bundle.finalizedAt,
    now,
  });
  transitionJob(input.db, job.id, "INGESTING", { now, message: "Renderer QA ingesting source into wiki" });
  const sourcePage = await runWikiIngest({ vaultRoot: input.vaultRoot, jobId: job.id, bundle });
  transitionJob(input.db, job.id, "NOTIFYING", { now, message: "Renderer QA notification skipped" });
  transitionJob(input.db, job.id, "COMPLETED", { now, message: "Renderer QA source ingest completed" });

  return {
    jobId,
    fileName: path.basename(input.filePath),
    sourcePath: relative,
    sourcePage,
    canonicalCount: preprocessing.artifacts.length,
    skippedCount: preprocessing.skippedFiles.length,
  };
}

function preprocessedArtifactsToRawBundleInputs(artifacts: PreprocessedTextArtifact[]): RawBundleArtifactInput[] {
  return artifacts.flatMap((artifact) => {
    const textInput: RawBundleArtifactInput = {
      id: artifact.id,
      sourcePath: artifact.sourcePath,
      name: artifact.fileName,
      kind: artifact.kind,
      wikiRole: "canonical_text",
    };
    if (artifact.fileId) {
      textInput.sourceFileId = artifact.fileId;
    }
    const inputs: RawBundleArtifactInput[] = [textInput];
    if (artifact.structurePath) {
      const structureInput: RawBundleArtifactInput = {
        id: `${artifact.id}:structure`,
        sourcePath: artifact.structurePath,
        name: path.basename(artifact.structurePath),
        kind: `${artifact.kind}_structure`,
        wikiRole: "structure",
      };
      if (artifact.fileId) {
        structureInput.sourceFileId = artifact.fileId;
      }
      inputs.push(structureInput);
    }
    return inputs;
  });
}

async function runWikiIngest(input: { vaultRoot: string; jobId: string; bundle: Awaited<ReturnType<typeof writeRawBundle>> }): Promise<string> {
  const wikiRoot = path.join(input.vaultRoot, "wiki");
  const args = [
    path.join(input.vaultRoot, "scripts", "ingest.mjs"),
    "--bundle", input.bundle.paths.root,
    "--wiki-root", wikiRoot,
    "--raw-root", path.join(input.vaultRoot, "raw"),
    "--job-id", input.jobId,
    "--contract-version", "telegram-local-ingest.llmwiki.v1",
    "--source", input.bundle.paths.sourceMarkdown,
    "--manifest", input.bundle.paths.manifest,
    "--index", path.join(wikiRoot, "index.md"),
    "--log", path.join(wikiRoot, "log.md"),
    "--project", "renderer-qa",
    "--tag", "renderer-qa",
    "--instructions", "Renderer QA source page generated from local to-be-removed test documents.",
  ];
  for (const record of input.bundle.wikiInputs) {
    args.push("--wiki-input", JSON.stringify({
      id: record.id,
      role: record.role,
      path: path.join(input.bundle.paths.root, record.path),
      relativePath: record.path,
      name: record.name,
      readByDefault: record.readByDefault,
    }));
  }
  const result = await runProcess(process.execPath, args, { cwd: input.vaultRoot });
  const match = result.stdout.match(/->\s+(sources\/[^\s]+\.md)/);
  if (!match?.[1]) {
    throw new Error(`Could not parse wiki ingest output: ${result.stdout}`);
  }
  return `wiki/${match[1]}`;
}

async function runArtifact(input: {
  requestDir: string;
  prompt: string;
  request: Record<string, unknown>;
  expectedFiles: string[];
  expectedArtifactSuffixes?: string[];
  minCsvRows?: { relativePath: string; minRows: number };
  contentChecks?: { relativePath: string; includes: string[] }[];
}): Promise<ArtifactSmokeResult> {
  const artifactId = String(input.request.artifactId ?? input.request.title ?? "artifact");
  const requestFile = path.join(input.requestDir, `${safeName(artifactId)}.json`);
  await fs.writeFile(requestFile, `${JSON.stringify(input.request, null, 2)}\n`, "utf8");
  const result = await runCli(["artifact", "run", requestFile, "--prompt", input.prompt]);
  const parsed = parseArtifactCliOutput(result.stdout);
  const bundlePath = parsed.bundlePath;
  await assertFile(path.join(bundlePath, "manifest.yaml"));
  await assertFile(path.join(bundlePath, "source.md"));
  await assertFile(path.join(bundlePath, "provenance.json"));
  await assertFile(path.join(bundlePath, ".finalized"));
  for (const relative of input.expectedFiles) {
    await assertFile(path.join(bundlePath, relative));
  }
  const presentationRelative = `artifacts/${safeArtifactId(artifactId)}_${safePresentationTitle(String(input.request.title ?? artifactId))}.docx`;
  const presentationPath = path.join(bundlePath, presentationRelative);
  await assertFile(presentationPath);
  await assertPresentationDocxClean(presentationPath);
  for (const suffix of input.expectedArtifactSuffixes ?? []) {
    if (!parsed.artifactPaths.some((artifactPath) => artifactPath.endsWith(suffix))) {
      throw new Error(`Expected artifact suffix ${suffix} in ${parsed.artifactPaths.join(", ")}`);
    }
  }
  if (input.minCsvRows) {
    await assertCsvRows(path.join(bundlePath, input.minCsvRows.relativePath), input.minCsvRows.minRows);
  }
  for (const check of input.contentChecks ?? []) {
    const content = await fs.readFile(path.join(bundlePath, check.relativePath), "utf8");
    for (const expected of check.includes) {
      if (!content.includes(expected)) {
        throw new Error(`Expected ${check.relativePath} to contain ${expected}`);
      }
    }
  }
  const run = getArtifactRun(parsed.runId);
  if (!run) {
    throw new Error(`Artifact renderer run not recorded in SQLite: ${parsed.runId}`);
  }
  if (run.renderer_mode !== "registered") {
    throw new Error(`Expected registered renderer run, got ${run.renderer_mode}`);
  }
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Expected succeeded renderer run, got ${run.status}: ${run.error ?? ""}`);
  }
  if (!run.derived_bundle_path) {
    throw new Error(`Artifact run did not record derived bundle path: ${parsed.runId}`);
  }
  if (!run.wiki_page_path && (input.request as { delivery?: { ingestDerived?: boolean } }).delivery?.ingestDerived !== false) {
    throw new Error(`Artifact run did not record wiki page path: ${parsed.runId}`);
  }
  return {
    artifactId,
    rendererId: String(run.renderer_id ?? ""),
    runId: parsed.runId,
    bundlePath: run.derived_bundle_path,
    ...(run.wiki_page_path ? { wikiPagePath: run.wiki_page_path } : {}),
    artifactPaths: parsed.artifactPaths,
  };
}

async function expectArtifactFailure(input: {
  requestDir: string;
  name: string;
  prompt: string;
  request: Record<string, unknown>;
  expectedMessage: string;
}): Promise<GuardResult> {
  const artifactId = String(input.request.artifactId ?? input.request.title ?? "artifact");
  const requestFile = path.join(input.requestDir, `${safeName(artifactId)}.json`);
  await fs.writeFile(requestFile, `${JSON.stringify(input.request, null, 2)}\n`, "utf8");
  try {
    await runCli(["artifact", "run", requestFile, "--prompt", input.prompt]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes(input.expectedMessage)) {
      throw new Error(`Expected guard failure to mention ${input.expectedMessage}, got:\n${text}`);
    }
    return { name: input.name, status: "passed", detail: firstLine(text) };
  }
  throw new Error(`Expected artifact request to fail: ${input.name}`);
}

async function runEmptyCsvGuard(input: {
  requestDir: string;
  name: string;
  prompt: string;
  request: Record<string, unknown>;
  csvPath: string;
}): Promise<GuardResult> {
  const run = await runArtifact({
    requestDir: input.requestDir,
    prompt: input.prompt,
    request: input.request,
    expectedFiles: [input.csvPath],
  });
  const rowCount = await csvDataRowCount(path.join(run.bundlePath, input.csvPath));
  if (rowCount !== 0) {
    throw new Error(`Expected ${input.name} to produce zero rows, got ${rowCount}`);
  }
  return { name: input.name, status: "passed", detail: `${input.csvPath} rows=0` };
}

function parseArtifactCliOutput(stdout: string): { runId: string; bundlePath: string; artifactPaths: string[] } {
  const runId = stdout.match(/^succeeded\s+(\S+)/m)?.[1];
  const bundlePath = stdout.match(/^bundle=(.+)$/m)?.[1]?.trim();
  const artifactPaths = [...stdout.matchAll(/^artifact=(.+)$/gm)].map((match) => match[1]?.trim()).filter((value): value is string => !!value);
  if (!runId || !bundlePath) {
    throw new Error(`Could not parse artifact run output:\n${stdout}`);
  }
  return { runId, bundlePath, artifactPaths };
}

function getArtifactRun(runId: string): {
  renderer_mode: string;
  renderer_id: string | null;
  status: string;
  error: string | null;
  derived_bundle_path: string | null;
  wiki_page_path: string | null;
} | null {
  const sqliteDbPath = process.env.SQLITE_DB_PATH
    ? path.resolve(projectRoot, process.env.SQLITE_DB_PATH)
    : path.join(projectRoot, "runtime", "ingest.db");
  const db = new DatabaseSync(sqliteDbPath);
  try {
    return db.prepare(`
      SELECT renderer_mode, renderer_id, status, error, derived_bundle_path, wiki_page_path
      FROM artifact_renderer_runs
      WHERE id = ?
    `).get(runId) as ReturnType<typeof getArtifactRun>;
  } finally {
    db.close();
  }
}

async function copySmokeArtifacts(input: { resultDir: string; runs: ArtifactSmokeResult[] }) {
  for (const run of input.runs) {
    const target = path.join(input.resultDir, safeName(run.artifactId));
    await fs.mkdir(target, { recursive: true });
    await fs.cp(path.join(run.bundlePath, "artifacts"), path.join(target, "artifacts"), { recursive: true });
    await fs.copyFile(path.join(run.bundlePath, "manifest.yaml"), path.join(target, "manifest.yaml"));
    await fs.copyFile(path.join(run.bundlePath, "source.md"), path.join(target, "source.md"));
    await fs.copyFile(path.join(run.bundlePath, "provenance.json"), path.join(target, "provenance.json"));
    if (run.wikiPagePath) {
      await fs.copyFile(run.wikiPagePath, path.join(target, "wiki-page.md"));
    }
  }
}

async function writeSummary(input: {
  resultDir: string;
  sourceDir: string;
  sources: SourceRecord[];
  runs: ArtifactSmokeResult[];
  guards: GuardResult[];
}) {
  const lines = [
    "# Wiki Renderer QA Smoke",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Input source directory: \`${input.sourceDir}\``,
    `- Result directory: \`${input.resultDir}\``,
    "",
    "## Ingested Sources",
    "",
    ...input.sources.map((source) => `- \`${source.sourcePage}\` <= \`${source.sourcePath}\` (canonical=${source.canonicalCount}, skipped=${source.skippedCount})`),
    "",
    "## Artifact Runs",
    "",
    ...input.runs.flatMap((run) => [
      `### ${run.artifactId}`,
      "",
      `- Renderer: \`${run.rendererId}\``,
      `- Run: \`${run.runId}\``,
      `- Bundle: \`${run.bundlePath}\``,
      run.wikiPagePath ? `- Wiki page: \`${run.wikiPagePath}\`` : "- Wiki page: none",
      "- Copied artifacts:",
      ...run.artifactPaths.map((artifactPath) => `  - \`${artifactPath}\``),
      "",
    ]),
    "## Guard Checks",
    "",
    ...input.guards.map((guard) => `- ${guard.name}: ${guard.status} (${guard.detail})`),
    "",
  ];
  await fs.writeFile(path.join(input.resultDir, "qa-summary.md"), `${lines.join("\n")}\n`, "utf8");
}

async function listInputFiles(root: string): Promise<string[]> {
  const files = await listFiles(root);
  return files
    .filter((filePath) => !path.basename(filePath).includes(":"))
    .filter((filePath) => isSupportedInput(filePath))
    .sort((left, right) => left.localeCompare(right));
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function pickFxSourcePages(vaultRoot: string, startDate: string, endDate: string, count: number): Promise<string[]> {
  const files = await listFiles(path.join(vaultRoot, "wiki", "sources"));
  const selected = files
    .map((filePath) => {
      const match = path.basename(filePath).match(/^fx_koreaexim_(20\d{2})(\d{2})(\d{2})\.md$/);
      if (!match?.[1] || !match[2] || !match[3]) {
        return null;
      }
      return {
        date: `${match[1]}-${match[2]}-${match[3]}`,
        relative: path.relative(vaultRoot, filePath).replace(/\\/g, "/"),
      };
    })
    .filter((record): record is { date: string; relative: string } => !!record)
    .filter((record) => record.date >= startDate && record.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, count);
  if (selected.length < count) {
    throw new Error(`Expected at least ${count} FX source pages between ${startDate} and ${endDate}, found ${selected.length}`);
  }
  return selected.map((record) => record.relative);
}

function requireSources(sources: SourceRecord[], predicate: (source: SourceRecord) => boolean, minCount: number, label: string): SourceRecord[] {
  const selected = sources.filter(predicate);
  if (selected.length < minCount) {
    throw new Error(`Expected at least ${minCount} ${label}; found ${selected.length}`);
  }
  return selected;
}

async function assertCleanReconcile(label: string) {
  const result = await runCli(["vault", "reconcile", "--json"]);
  const parsed = JSON.parse(result.stdout) as { summary?: { error?: number; warn?: number } };
  const summary = parsed.summary ?? {};
  const total = Number(summary.error ?? 0) + Number(summary.warn ?? 0);
  if (total !== 0) {
    throw new Error(`Vault reconcile is not clean ${label}: ${result.stdout}`);
  }
}

async function assertCsvRows(filePath: string, minRows: number) {
  const rowCount = await csvDataRowCount(filePath);
  if (rowCount < minRows) {
    throw new Error(`Expected at least ${minRows} CSV data row(s) in ${filePath}, got ${rowCount}`);
  }
}

async function csvDataRowCount(filePath: string): Promise<number> {
  const content = await fs.readFile(filePath, "utf8");
  return content.split(/\r?\n/).filter((line) => line.trim()).slice(1).length;
}

async function runCli(args: string[]) {
  return runProcess(process.execPath, ["--import", "tsx", cliEntry, ...args], { cwd: projectRoot, env: process.env });
}

function runProcess(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (exitCode !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${exitCode}\n${stdoutText}\n${stderrText}`.trim()));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

async function assertDirectory(directoryPath: string, label: string) {
  const stat = await fs.stat(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directoryPath}`);
  }
}

async function assertFile(filePath: string) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Expected file: ${filePath}`);
  }
}

async function assertPresentationDocxClean(filePath: string) {
  const pandocBin = process.env.PANDOC_BIN?.trim() || "pandoc";
  const result = await runProcess(pandocBin, [filePath, "-t", "plain"], { cwd: projectRoot, env: process.env });
  const text = result.stdout;
  const badJsonLine = text.split(/\r?\n/).find((line) => /^\s*[{[]\s*$/.test(line));
  if (badJsonLine) {
    throw new Error(`Presentation DOCX appears to contain raw JSON/list syntax: ${filePath}`);
  }
  if (text.includes("[Preview truncated]")) {
    throw new Error(`Presentation DOCX contains a truncated raw preview: ${filePath}`);
  }
  const forbiddenMetadata = [
    "Bundle:",
    "Canonical Inputs",
    "Other Manifest Inputs",
    "renderer-qa",
    "wiki/sources/",
    "Source Path",
    "source.md",
    "manifest.yaml",
  ];
  const marker = forbiddenMetadata.find((item) => text.includes(item));
  if (marker) {
    throw new Error(`Presentation DOCX contains source-wrapper metadata (${marker}): ${filePath}`);
  }
}

function isSupportedInput(filePath: string): boolean {
  return [".docx", ".eml", ".jpg", ".jpeg", ".md", ".pdf", ".png", ".txt"].includes(path.extname(filePath).toLowerCase());
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".docx") {
    return DOCX_MEDIA_TYPE;
  }
  if (ext === ".eml") {
    return "message/rfc822";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".md") {
    return "text/markdown";
  }
  if (ext === ".pdf") {
    return "application/pdf";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".txt") {
    return "text/plain";
  }
  return "application/octet-stream";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function assertInside(root: string, target: string, label: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${root}: ${target}`);
  }
}

function safeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "item";
}

function safeArtifactId(value: string) {
  return safeName(value);
}

function safePresentationTitle(value: string) {
  return String(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "presentation";
}

function parseArgs(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    index += 1;
    values.set(key, value);
  }
  return values;
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function loadEnvFile(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed || process.env[parsed.key] !== undefined) {
        continue;
      }
      process.env[parsed.key] = parsed.value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const index = trimmed.indexOf("=");
  if (index <= 0) {
    return null;
  }
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function firstLine(value: string) {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? value.trim();
}

await main();
