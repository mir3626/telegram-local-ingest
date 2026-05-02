import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  artifactRequestSchema,
  buildArtifactRunId,
  parseArtifactRequest,
  promoteGeneratedRenderer,
  runArtifactRequest,
  type ArtifactRequest,
} from "@telegram-local-ingest/artifact-core";
import {
  completeArtifactRendererRun,
  createArtifactRendererRun,
  getArtifactRendererRun,
  listArtifactRendererRuns,
  markArtifactRendererRunPromoted,
  migrate,
  openIngestDatabase,
} from "@telegram-local-ingest/db";

test("parseArtifactRequest normalizes generated renderer file maps", () => {
  const request = parseArtifactRequest({
    action: "create_derived_artifact",
    artifactKind: "chart",
    artifactId: "fx_custom",
    title: "FX Custom",
    renderer: {
      mode: "generated",
      language: "python",
      entrypoint: "render.py",
      files: {
        "render.py": "print('ok')\n",
      },
    },
    sources: [],
    parameters: {},
  });

  assert.equal(request.renderer.mode, "generated");
  if (request.renderer.mode === "generated") {
    assert.equal(request.renderer.code, "print('ok')\n");
  }
});

test("generated artifact renderer creates a derived package and records promotable DB log", async () => {
  const fixture = createFixture();
  const sourcePage = path.join(fixture.vaultRoot, "wiki", "sources", "demo.md");
  fs.mkdirSync(path.dirname(sourcePage), { recursive: true });
  fs.writeFileSync(sourcePage, "# Demo\n\nvalue,amount\nA,10\n", "utf8");

  const request = artifactRequestSchema.parse({
    action: "create_derived_artifact",
    artifactKind: "report",
    artifactId: "demo_report",
    title: "Demo Report",
    renderer: {
      mode: "generated",
      language: "javascript",
      suggestedId: "demo_report",
      code: [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "const [inputPath, outputDir, resultPath] = process.argv.slice(2);",
        "const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));",
        "const reportPath = path.join(outputDir, 'summary.md');",
        "const jsonPath = path.join(outputDir, 'summary.json');",
        "await fs.writeFile(reportPath, `# Generated\\n\\n| Field | Value |\\n| --- | --- |\\n| Source | ${input.sources[0].path} |\\n`, 'utf8');",
        "await fs.writeFile(jsonPath, JSON.stringify({records:[{debug:'machine readable only'}]}, null, 2), 'utf8');",
        "await fs.writeFile(resultPath, JSON.stringify({artifacts:[{path:'summary.md',role:'report',mediaType:'text/markdown'},{path:'summary.json',role:'report',mediaType:'application/json'}]}), 'utf8');",
        "",
      ].join("\n"),
    },
    sources: [{ path: "wiki/sources/demo.md", type: "wiki_source" }],
    parameters: {},
  }) satisfies ArtifactRequest;
  const prompt = "demo wiki data로 보고서 만들어줘";
  const runId = buildArtifactRunId("demo_report", new Date("2026-04-28T00:00:00.000Z"));
  const dbHandle = openIngestDatabase(":memory:");
  try {
    migrate(dbHandle.db);
    const runDir = path.join(fixture.runtimeDir, "wiki-artifacts", "runs", runId);
    createArtifactRendererRun(dbHandle.db, {
      id: runId,
      artifactId: "demo_report",
      artifactKind: "report",
      rendererMode: "generated",
      rendererLanguage: "javascript",
      sourcePrompt: prompt,
      request,
      runDir,
      outputDir: path.join(runDir, "outputs"),
      stdoutPath: path.join(runDir, "stdout.log"),
      stderrPath: path.join(runDir, "stderr.log"),
      resultPath: path.join(runDir, "result.json"),
      now: "2026-04-28T00:00:00.000Z",
    });

    const result = await runArtifactRequest({
      request,
      runId,
      vaultRoot: fixture.vaultRoot,
      runtimeDir: fixture.runtimeDir,
      sourcePrompt: prompt,
      now: new Date("2026-04-28T00:00:00.000Z"),
      env: process.env,
    });
    completeArtifactRendererRun(dbHandle.db, {
      id: runId,
      status: "SUCCEEDED",
      derivedBundlePath: result.derivedBundlePath,
      endedAt: result.endedAt,
    });

    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, ".finalized")), true);
    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, "artifacts", "summary.docx")), true);
    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, "artifacts", "summary.md")), false);
    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, "artifacts", "summary.json")), true);
    const presentationPath = path.join(result.derivedBundlePath, "artifacts", "demo_report_Demo_Report.docx");
    assert.equal(fs.existsSync(presentationPath), true);
    assert.equal(result.artifacts.some((artifact) => artifact.role === "presentation" && artifact.path.endsWith("_Demo_Report.docx")), true);
    const presentationText = docxDocumentXml(presentationPath);
    assert.match(presentationText, /Demo Report/);
    assert.match(presentationText, /<w:tbl>/);
    assert.doesNotMatch(presentationText, /Artifact kind|User Request|Source Basis|SHA-256/);
    assert.doesNotMatch(presentationText, /machine readable only|records/);
    assert.match(fs.readFileSync(path.join(result.derivedBundlePath, "provenance.json"), "utf8"), /demo wiki data/);
    assert.equal(fs.existsSync(result.stdoutPath), false);
    assert.equal(fs.existsSync(result.stderrPath), false);
    assert.equal(listArtifactRendererRuns(dbHandle.db, 10).length, 1);
    assert.equal(getArtifactRendererRun(dbHandle.db, runId)?.sourcePrompt, prompt);

    const promoted = await promoteGeneratedRenderer({
      runDir: result.runDir,
      request,
      targetRoot: fixture.renderersRoot,
      rendererId: "generated.report.demo",
    });
    markArtifactRendererRunPromoted(dbHandle.db, runId, promoted.rendererId);
    assert.equal(fs.existsSync(path.join(promoted.rendererDir, "manifest.json")), true);
    assert.equal(fs.existsSync(path.join(promoted.rendererDir, "render.mjs")), true);
    assert.equal(getArtifactRendererRun(dbHandle.db, runId)?.promotedRendererId, "generated.report.demo");
  } finally {
    dbHandle.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact renderer expands allowed wiki source glob patterns", async () => {
  const fixture = createFixture();
  const sourcesDir = path.join(fixture.vaultRoot, "wiki", "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20250401.md"), "# FX 2025-04-01\n", "utf8");
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20250501.md"), "# FX 2025-05-01\n", "utf8");
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20251101.md"), "# FX 2025-11-01\n", "utf8");

  const request = artifactRequestSchema.parse({
    action: "create_derived_artifact",
    artifactKind: "chart",
    artifactId: "fx_range_chart",
    title: "FX Range Chart",
    renderer: {
      mode: "generated",
      language: "javascript",
      suggestedId: "fx_range_chart",
      code: [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "const [inputPath, outputDir, resultPath] = process.argv.slice(2);",
        "const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));",
        "const readable = await Promise.all(input.sources.map((source) => fs.readFile(path.join(input.vaultRoot, source.path), 'utf8')));",
        "const reportPath = path.join(outputDir, 'summary.md');",
        "await fs.writeFile(reportPath, `sources=${input.sources.length}\\n${input.sources.map((source) => source.path).join('\\n')}\\n${readable.join('\\n')}`, 'utf8');",
        "await fs.writeFile(resultPath, JSON.stringify({artifacts:[{path:'summary.md',role:'report',mediaType:'text/markdown'}]}), 'utf8');",
        "",
      ].join("\n"),
    },
    sources: [{ path: "wiki/sources/fx_koreaexim_2025{04..05}*.md", type: "wiki_source" }],
    parameters: {},
  }) satisfies ArtifactRequest;

  try {
    const result = await runArtifactRequest({
      request,
      runId: "artifact_fx_range_chart_20260429T000000000Z",
      vaultRoot: fixture.vaultRoot,
      runtimeDir: fixture.runtimeDir,
      sourcePrompt: "2025년 4월에서 2025년 5월까지 달러 환율 차트로 보여줘",
      now: new Date("2026-04-29T00:00:00.000Z"),
      env: process.env,
    });

    const inputSnapshot = JSON.parse(fs.readFileSync(result.inputSnapshotPath, "utf8")) as {
      vaultRoot?: string;
      wikiRoot?: string;
      sources: Array<{ path: string }>;
    };
    assert.equal(inputSnapshot.vaultRoot, fixture.vaultRoot);
    assert.equal(inputSnapshot.wikiRoot, path.join(fixture.vaultRoot, "wiki"));
    assert.deepEqual(inputSnapshot.sources.map((source) => source.path), [
      "wiki/sources/fx_koreaexim_20250401.md",
      "wiki/sources/fx_koreaexim_20250501.md",
    ]);
    const summary = docxDocumentXml(path.join(result.derivedBundlePath, "artifacts", "summary.docx"));
    assert.match(summary, /sources=2/);
    assert.match(summary, /FX 2025-04-01/);
    assert.doesNotMatch(summary, /20251101/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("artifact renderer expands comma brace lists before exact source stat", async () => {
  const fixture = createFixture();
  const sourcesDir = path.join(fixture.vaultRoot, "wiki", "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20250401.md"), "# FX 2025-04-01\n", "utf8");
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20250701.md"), "# FX 2025-07-01\n", "utf8");
  fs.writeFileSync(path.join(sourcesDir, "fx_koreaexim_20251001.md"), "# FX 2025-10-01\n", "utf8");

  const request = artifactRequestSchema.parse({
    action: "create_derived_artifact",
    artifactKind: "table",
    artifactId: "fx_selected_dates",
    title: "FX Selected Dates",
    renderer: {
      mode: "generated",
      language: "javascript",
      suggestedId: "fx_selected_dates",
      code: [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "const [inputPath, outputDir, resultPath] = process.argv.slice(2);",
        "const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));",
        "const reportPath = path.join(outputDir, 'selected.md');",
        "await fs.writeFile(reportPath, input.sources.map((source) => source.path).join('\\n'), 'utf8');",
        "await fs.writeFile(resultPath, JSON.stringify({artifacts:[{path:'selected.md',role:'report',mediaType:'text/markdown'}]}), 'utf8');",
        "",
      ].join("\n"),
    },
    sources: [{ path: "wiki/sources/fx_koreaexim_2025{0401,0701,1001}.md", type: "wiki_source" }],
    parameters: {},
  }) satisfies ArtifactRequest;

  try {
    const result = await runArtifactRequest({
      request,
      runId: "artifact_fx_selected_dates_20260429T000000000Z",
      vaultRoot: fixture.vaultRoot,
      runtimeDir: fixture.runtimeDir,
      sourcePrompt: "세 날짜 환율 비교표를 만들어줘",
      now: new Date("2026-04-29T00:00:00.000Z"),
      env: process.env,
    });

    const selected = docxDocumentXml(path.join(result.derivedBundlePath, "artifacts", "selected.docx"));
    assert.match(selected, /wiki\/sources\/fx_koreaexim_20250401\.md/);
    assert.match(selected, /wiki\/sources\/fx_koreaexim_20250701\.md/);
    assert.match(selected, /wiki\/sources\/fx_koreaexim_20251001\.md/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("python artifact renderers prefer WIKI_ARTIFACT_PYTHON_BIN", async () => {
  const fixture = createFixture();
  const sourcesDir = path.join(fixture.vaultRoot, "wiki", "sources");
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, "demo.md"), "# Demo\n", "utf8");
  const markerPath = path.join(fixture.root, "python-used.txt");
  const wrapperPath = writeExecutable(
    fixture.root,
    "artifact-python",
    `#!/usr/bin/env bash\necho used > ${shellQuote(markerPath)}\nexec python3 "$@"`,
  );
  const request = artifactRequestSchema.parse({
    action: "create_derived_artifact",
    artifactKind: "report",
    artifactId: "python_demo",
    title: "Python Demo",
    renderer: {
      mode: "generated",
      language: "python",
      suggestedId: "python_demo",
      code: [
        "import json, sys",
        "from pathlib import Path",
        "import os",
        "input_path, output_dir, result_path = sys.argv[1:4]",
        "assert os.environ['TLGI_VAULT_ROOT']",
        "Path(output_dir).mkdir(parents=True, exist_ok=True)",
        "Path(output_dir, 'summary.md').write_text('# Python generated\\n', encoding='utf-8')",
        "Path(result_path).write_text(json.dumps({'artifacts':[{'path':'summary.md','mediaType':'text/markdown'}]}), encoding='utf-8')",
        "",
      ].join("\n"),
    },
    sources: [{ path: "wiki/sources/demo.md", type: "wiki_source" }],
    parameters: {},
  }) satisfies ArtifactRequest;

  try {
    const result = await runArtifactRequest({
      request,
      runId: "artifact_python_demo_20260429T000000000Z",
      vaultRoot: fixture.vaultRoot,
      runtimeDir: fixture.runtimeDir,
      sourcePrompt: "python renderer test",
      now: new Date("2026-04-29T00:00:00.000Z"),
      env: { ...process.env, WIKI_ARTIFACT_PYTHON_BIN: wrapperPath },
    });

    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, "artifacts", "summary.docx")), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(): { root: string; vaultRoot: string; runtimeDir: string; renderersRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-core-"));
  return {
    root,
    vaultRoot: path.join(root, "vault"),
    runtimeDir: path.join(root, "runtime"),
    renderersRoot: path.join(root, "vault", "renderers"),
  };
}

function writeExecutable(root: string, fileName: string, content: string): string {
  const filePath = path.join(root, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function docxDocumentXml(filePath: string): string {
  return extractZipEntry(fs.readFileSync(filePath), "word/document.xml")?.toString("utf8") ?? "";
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
