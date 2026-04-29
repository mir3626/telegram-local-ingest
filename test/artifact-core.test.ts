import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactRequestSchema,
  buildArtifactRunId,
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
        "await fs.writeFile(reportPath, `# Generated\\n\\nSource: ${input.sources[0].path}\\n`, 'utf8');",
        "await fs.writeFile(resultPath, JSON.stringify({artifacts:[{path:'summary.md',role:'report',mediaType:'text/markdown'}]}), 'utf8');",
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
    assert.equal(fs.existsSync(path.join(result.derivedBundlePath, "artifacts", "summary.md")), true);
    assert.match(fs.readFileSync(path.join(result.derivedBundlePath, "provenance.json"), "utf8"), /demo wiki data/);
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
        "const reportPath = path.join(outputDir, 'summary.md');",
        "await fs.writeFile(reportPath, `sources=${input.sources.length}\\n${input.sources.map((source) => source.path).join('\\n')}\\n`, 'utf8');",
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
      sources: Array<{ path: string }>;
    };
    assert.deepEqual(inputSnapshot.sources.map((source) => source.path), [
      "wiki/sources/fx_koreaexim_20250401.md",
      "wiki/sources/fx_koreaexim_20250501.md",
    ]);
    const summary = fs.readFileSync(path.join(result.derivedBundlePath, "artifacts", "summary.md"), "utf8");
    assert.match(summary, /sources=2/);
    assert.doesNotMatch(summary, /20251101/);
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
