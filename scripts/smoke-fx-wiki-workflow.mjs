#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDir);
const cliEntry = path.join(projectRoot, "apps", "ops-cli", "src", "index.ts");
const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").slice(0, 18);

async function main() {
  await loadEnvFile(path.join(projectRoot, ".env"));
  const vaultRoot = requiredEnv("OBSIDIAN_VAULT_PATH");
  const runtimeDir = process.env.INGEST_RUNTIME_DIR
    ? path.resolve(projectRoot, process.env.INGEST_RUNTIME_DIR)
    : path.join(projectRoot, "runtime");
  const sqliteDbPath = process.env.SQLITE_DB_PATH
    ? path.resolve(projectRoot, process.env.SQLITE_DB_PATH)
    : path.join(runtimeDir, "ingest.db");
  const requestDir = path.join(runtimeDir, "smoke", "fx-wiki-workflow", stamp, "requests");
  await fs.mkdir(requestDir, { recursive: true });

  await assertDirectory(vaultRoot, "OBSIDIAN_VAULT_PATH");
  await assertFxSourcesAvailable(vaultRoot);
  await assertCleanReconcile("before");

  const sampleSources = await pickFxSourcePages(vaultRoot, "2025-04-01", "2025-04-10", 3);
  const runs = [];
  runs.push(await runArtifact({
    requestDir,
    sqliteDbPath,
    prompt: "Acceptance smoke: USD/KRW FX statistics and chart for 2025-04 through 2025-10.",
    request: {
      schemaVersion: "tlgi.artifact.request.v1",
      action: "create_derived_artifact",
      artifactKind: "fx_stats",
      artifactId: `fx_acceptance_usd_2025_apr_oct_${stamp}`,
      title: "FX acceptance USD 2025 Apr-Oct",
      renderer: { mode: "registered", id: "fx.stats.period" },
      sources: [{ path: "wiki/sources/fx_koreaexim_2025{04..10}*.md", type: "wiki_source" }],
      parameters: { currency: "USD", startDate: "2025-04-01", endDate: "2025-10-31", chartFormats: ["png", "svg", "pdf"] },
      delivery: { sendToTelegram: false, ingestDerived: true },
    },
    expectedFiles: ["artifacts/chart.png", "artifacts/chart.svg", "artifacts/chart.pdf", "artifacts/stats.csv", "artifacts/summary.docx"],
  }));
  runs.push(await runArtifact({
    requestDir,
    sqliteDbPath,
    prompt: "Acceptance smoke: comparison table from three FX source pages.",
    request: {
      schemaVersion: "tlgi.artifact.request.v1",
      action: "create_derived_artifact",
      artifactKind: "comparison_table",
      artifactId: `fx_acceptance_compare_${stamp}`,
      title: "FX acceptance comparison table",
      renderer: { mode: "registered", id: "table.compare" },
      sources: sampleSources.map((sourcePath) => ({ path: sourcePath, type: "wiki_source" })),
      parameters: {},
      delivery: { sendToTelegram: false, ingestDerived: true },
    },
    expectedFiles: ["artifacts/comparison_table.docx", "artifacts/comparison_table.csv", "artifacts/comparison_table.xlsx"],
  }));
  runs.push(await runArtifact({
    requestDir,
    sqliteDbPath,
    prompt: "Acceptance smoke: local NotebookLM manual export pack from FX source pages.",
    request: {
      schemaVersion: "tlgi.artifact.request.v1",
      action: "create_derived_artifact",
      artifactKind: "notebooklm_export",
      artifactId: `fx_acceptance_notebooklm_${stamp}`,
      title: "FX acceptance NotebookLM export pack",
      renderer: { mode: "registered", id: "notebooklm.export-pack" },
      sources: sampleSources.map((sourcePath) => ({ path: sourcePath, type: "wiki_source" })),
      parameters: {
        purpose: "FX-only acceptance smoke export for manual NotebookLM upload",
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

  await assertCleanReconcile("after");
  process.stdout.write("FX wiki workflow smoke passed.\n");
  for (const run of runs) {
    process.stdout.write(`- ${run.rendererId} ${run.runId}\n`);
    process.stdout.write(`  bundle=${run.bundlePath}\n`);
    process.stdout.write(`  wiki=${run.wikiPagePath}\n`);
  }
}

async function runArtifact({ requestDir, sqliteDbPath, prompt, request, expectedFiles, expectedArtifactSuffixes = [] }) {
  const requestFile = path.join(requestDir, `${request.artifactId}.json`);
  await fs.writeFile(requestFile, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const result = await runCli(["artifact", "run", requestFile, "--prompt", prompt]);
  const runId = result.stdout.match(/^succeeded\s+(\S+)/m)?.[1];
  const bundlePath = result.stdout.match(/^bundle=(.+)$/m)?.[1]?.trim();
  const artifactPaths = [...result.stdout.matchAll(/^artifact=(.+)$/gm)].map((match) => match[1]?.trim()).filter(Boolean);
  if (!runId || !bundlePath) {
    throw new Error(`Could not parse artifact run output:\n${result.stdout}`);
  }

  await assertFile(path.join(bundlePath, "manifest.yaml"));
  await assertFile(path.join(bundlePath, "source.md"));
  await assertFile(path.join(bundlePath, "provenance.json"));
  await assertFile(path.join(bundlePath, ".finalized"));
  for (const relative of expectedFiles) {
    await assertFile(path.join(bundlePath, relative));
  }
  const presentationRelative = `artifacts/${safeArtifactId(request.artifactId || request.title)}_${safePresentationTitle(request.title)}.docx`;
  await assertFile(path.join(bundlePath, presentationRelative));
  for (const suffix of expectedArtifactSuffixes) {
    if (!artifactPaths.some((artifactPath) => artifactPath.endsWith(suffix))) {
      throw new Error(`Expected artifact suffix ${suffix} in ${artifactPaths.join(", ")}`);
    }
  }
  const run = getArtifactRun(sqliteDbPath, runId);
  if (!run) {
    throw new Error(`Artifact renderer run was not recorded in SQLite: ${runId}`);
  }
  if (run.renderer_mode !== "registered") {
    throw new Error(`Expected registered renderer run, got ${run.renderer_mode}: ${runId}`);
  }
  if (run.renderer_id !== request.renderer.id) {
    throw new Error(`Expected renderer ${request.renderer.id}, got ${run.renderer_id}: ${runId}`);
  }
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Artifact run did not succeed: ${runId} status=${run.status}`);
  }
  if (!run.derived_bundle_path || !run.wiki_page_path) {
    throw new Error(`Artifact run did not record derived bundle/wiki page paths: ${runId}`);
  }
  await assertFile(run.wiki_page_path);
  return {
    runId,
    rendererId: run.renderer_id,
    bundlePath: run.derived_bundle_path,
    wikiPagePath: run.wiki_page_path,
  };
}

async function assertFxSourcesAvailable(vaultRoot) {
  const sourceDir = path.join(vaultRoot, "wiki", "sources");
  const files = await listFilesIfExists(sourceDir);
  const sourcePages = files.filter((filePath) => filePath.endsWith(".md"));
  if (sourcePages.length === 0) {
    throw new Error("No wiki source pages found");
  }
  const fx = sourcePages.filter((filePath) => path.basename(filePath).startsWith("fx_koreaexim_"));
  if (fx.length === 0) {
    throw new Error("No FX wiki source pages found");
  }
}

async function pickFxSourcePages(vaultRoot, startDate, endDate, count) {
  const sourceDir = path.join(vaultRoot, "wiki", "sources");
  const files = await listFilesIfExists(sourceDir);
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
    .filter(Boolean)
    .filter((record) => record.date >= startDate && record.date <= endDate)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, count);
  if (selected.length < count) {
    throw new Error(`Expected at least ${count} FX source pages between ${startDate} and ${endDate}, found ${selected.length}`);
  }
  return selected.map((record) => record.relative);
}

async function assertCleanReconcile(label) {
  const { stdout } = await runCli(["vault", "reconcile", "--json"]);
  const parsed = JSON.parse(stdout);
  const summary = parsed.summary || {};
  const total = Number(summary.error || 0) + Number(summary.warn || 0);
  if (total !== 0) {
    throw new Error(`Vault reconcile is not clean ${label}: ${stdout}`);
  }
}

function getArtifactRun(sqliteDbPath, runId) {
  const db = new DatabaseSync(sqliteDbPath);
  try {
    return db.prepare("SELECT id, renderer_mode, renderer_id, status, derived_bundle_path, wiki_page_path FROM artifact_renderer_runs WHERE id = ?").get(runId);
  } finally {
    db.close();
  }
}

async function runCli(args) {
  return runProcess(process.execPath, ["--import", "tsx", cliEntry, ...args], { cwd: projectRoot });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
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

async function listFilesIfExists(root) {
  try {
    return await listFiles(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
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

async function assertDirectory(directoryPath, label) {
  const stat = await fs.stat(directoryPath);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directoryPath}`);
  }
}

async function assertFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Expected file: ${filePath}`);
  }
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function safeArtifactId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "artifact";
}

function safePresentationTitle(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90) || "presentation";
}

function loadEnvFile(filePath) {
  return fs.readFile(filePath, "utf8")
    .then((content) => {
      for (const line of content.split(/\r?\n/)) {
        const parsed = parseEnvLine(line);
        if (!parsed || process.env[parsed.key] !== undefined) {
          continue;
        }
        process.env[parsed.key] = parsed.value;
      }
    })
    .catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
}

function parseEnvLine(line) {
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
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

await main();
