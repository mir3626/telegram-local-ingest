import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const ARTIFACT_BLOCK_PATTERN = /```tlgi-artifact-request\s*([\s\S]*?)```/g;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SOURCE_TEXT_BYTES = 1024 * 1024;

const sourceRefSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});

const deliverySchema = z.object({
  sendToTelegram: z.boolean().default(true),
  ingestDerived: z.boolean().default(true),
}).default({ sendToTelegram: true, ingestDerived: true });

const registeredRendererSchema = z.object({
  mode: z.literal("registered"),
  id: z.string().min(1),
});

const generatedRendererSchema = z.object({
  mode: z.literal("generated"),
  language: z.enum(["python", "javascript"]),
  code: z.string().min(1),
  suggestedId: z.string().min(1).optional(),
});

export const artifactRequestSchema = z.object({
  schemaVersion: z.string().default("tlgi.artifact.request.v1"),
  action: z.literal("create_derived_artifact").default("create_derived_artifact"),
  artifactKind: z.string().min(1),
  artifactId: z.string().min(1).optional(),
  title: z.string().min(1),
  renderer: z.discriminatedUnion("mode", [registeredRendererSchema, generatedRendererSchema]),
  sources: z.array(sourceRefSchema).default([]),
  parameters: z.record(z.unknown()).default({}),
  delivery: deliverySchema,
});

export const artifactRendererManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  title: z.string().min(1),
  description: z.string().optional(),
  artifactKinds: z.array(z.string().min(1)).default([]),
  entry: z.string().min(1),
  runtime: z.enum(["node", "python"]),
  timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
});

export type ArtifactRequest = z.infer<typeof artifactRequestSchema>;
export type ArtifactRendererManifest = z.infer<typeof artifactRendererManifestSchema>;
export type ArtifactRendererMode = ArtifactRequest["renderer"]["mode"];

export interface DiscoveredArtifactRenderer {
  manifest: ArtifactRendererManifest;
  rendererDir: string;
  manifestPath: string;
  entryPath: string;
}

export interface ArtifactSourceSnapshot {
  path: string;
  absolutePath: string;
  label?: string;
  type?: string;
  sizeBytes: number;
  sha256: string;
  text?: string;
}

export interface ArtifactRunInput {
  request: ArtifactRequest;
  vaultRoot: string;
  runtimeDir: string;
  sourcePrompt: string;
  runId?: string;
  rendererRegistryRoot?: string;
  derivedRoot?: string;
  wikiRoot?: string;
  rawRoot?: string;
  ingestDerivedCommand?: string;
  allowGeneratedRenderers?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ArtifactRunResult {
  runId: string;
  artifactId: string;
  artifactKind: string;
  rendererMode: ArtifactRendererMode;
  rendererId?: string;
  rendererLanguage?: string;
  runDir: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  requestPath: string;
  promptPath: string;
  inputSnapshotPath: string;
  generatedScriptPath?: string;
  derivedBundlePath: string;
  derivedBundleRelativePath: string;
  wikiPageRelative?: string;
  artifacts: PackagedArtifact[];
  startedAt: string;
  endedAt: string;
}

export interface PackagedArtifact {
  id: string;
  role: string;
  path: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
}

interface RendererExecutionResult {
  stdout: string;
  stderr: string;
  artifacts: RendererArtifact[];
  generatedScriptPath?: string;
}

interface RendererArtifact {
  path: string;
  role?: string;
  mediaType?: string;
}

export function extractArtifactRequestsFromText(text: string): ArtifactRequest[] {
  const requests: ArtifactRequest[] = [];
  for (const match of text.matchAll(ARTIFACT_BLOCK_PATTERN)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.requests)
          ? parsed.requests
          : [parsed];
      for (const record of records) {
        requests.push(artifactRequestSchema.parse(record));
      }
    } catch {
      // Ignore malformed machine blocks; visible agent text remains useful.
    }
  }
  return requests;
}

export function stripArtifactRequestBlocks(text: string): string {
  return text.replace(ARTIFACT_BLOCK_PATTERN, "").trim();
}

export function buildArtifactRunId(artifactId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `artifact_${safeName(artifactId)}_${stamp}`;
}

export async function discoverArtifactRenderers(renderersRoot: string): Promise<DiscoveredArtifactRenderer[]> {
  const resolvedRoot = path.resolve(renderersRoot);
  let entries;
  try {
    entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }

  const renderers: DiscoveredArtifactRenderer[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const rendererDir = path.join(resolvedRoot, entry.name);
    const manifestPath = path.join(rendererDir, "manifest.json");
    let rawManifest;
    try {
      rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw new Error(`Failed to read artifact renderer manifest ${manifestPath}: ${errorMessage(error)}`);
    }
    const manifest = artifactRendererManifestSchema.parse(rawManifest);
    const entryPath = path.resolve(rendererDir, manifest.entry);
    assertInside(rendererDir, entryPath, "Artifact renderer entry must stay inside its renderer directory");
    renderers.push({ manifest, rendererDir, manifestPath, entryPath });
  }
  return renderers.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export async function runArtifactRequest(input: ArtifactRunInput): Promise<ArtifactRunResult> {
  const request = artifactRequestSchema.parse(input.request);
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const vaultRoot = path.resolve(input.vaultRoot);
  const runtimeDir = path.resolve(input.runtimeDir);
  const wikiRoot = path.resolve(input.wikiRoot ?? path.join(vaultRoot, "wiki"));
  const rawRoot = path.resolve(input.rawRoot ?? path.join(vaultRoot, "raw"));
  const derivedRoot = path.resolve(input.derivedRoot ?? path.join(vaultRoot, "derived"));
  const rendererSuggestedId = request.renderer.mode === "generated" ? request.renderer.suggestedId : undefined;
  const artifactId = safeName(request.artifactId ?? rendererSuggestedId ?? request.title);
  const runId = input.runId ?? buildArtifactRunId(artifactId, now);
  const runDir = path.join(runtimeDir, "wiki-artifacts", "runs", runId);
  const outputDir = path.join(runDir, "outputs");
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const resultPath = path.join(runDir, "result.json");
  const requestPath = path.join(runDir, "request.json");
  const promptPath = path.join(runDir, "prompt.txt");
  const inputSnapshotPath = path.join(runDir, "input.json");
  await fs.mkdir(outputDir, { recursive: true });

  const sourceSnapshot = await buildSourceSnapshot(request.sources, { vaultRoot, rawRoot, wikiRoot, derivedRoot });
  await Promise.all([
    fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8"),
    fs.writeFile(promptPath, input.sourcePrompt, "utf8"),
    fs.writeFile(inputSnapshotPath, `${JSON.stringify({
      request,
      sourcePrompt: input.sourcePrompt,
      vaultRoot,
      wikiRoot,
      rawRoot,
      derivedRoot,
      sources: sourceSnapshot.map((source) => ({
        path: source.path,
        label: source.label,
        type: source.type,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        text: source.text,
      })),
    }, null, 2)}\n`, "utf8"),
  ]);

  const execution = request.renderer.mode === "registered"
    ? await runRegisteredRenderer({
      request,
      runDir,
      outputDir,
      resultPath,
      inputSnapshotPath,
      vaultRoot,
      rawRoot,
      wikiRoot,
      derivedRoot,
      rendererRegistryRoot: input.rendererRegistryRoot ?? path.join(vaultRoot, "renderers"),
      ...(input.env ? { env: input.env } : {}),
    })
    : await runGeneratedRenderer({
      request,
      runDir,
      outputDir,
      resultPath,
      inputSnapshotPath,
      vaultRoot,
      rawRoot,
      wikiRoot,
      derivedRoot,
      allowGeneratedRenderers: input.allowGeneratedRenderers ?? true,
      ...(input.env ? { env: input.env } : {}),
    });

  await Promise.all([
    fs.writeFile(stdoutPath, execution.stdout, "utf8"),
    fs.writeFile(stderrPath, execution.stderr, "utf8"),
  ]);

  const packaged = await finalizeDerivedPackage({
    request,
    artifactId,
    runId,
    runDir,
    outputDir,
    derivedRoot,
    wikiRoot,
    sourcePrompt: input.sourcePrompt,
    sourceSnapshot,
    execution,
    startedAt,
    ...(request.delivery.ingestDerived && input.ingestDerivedCommand ? { ingestDerivedCommand: input.ingestDerivedCommand } : {}),
    ...(input.env ? { env: input.env } : {}),
  });
  const endedAt = new Date().toISOString();
  const runResult: ArtifactRunResult = {
    runId,
    artifactId: packaged.artifactId,
    artifactKind: request.artifactKind,
    rendererMode: request.renderer.mode,
    runDir,
    outputDir,
    stdoutPath,
    stderrPath,
    resultPath,
    requestPath,
    promptPath,
    inputSnapshotPath,
    derivedBundlePath: packaged.bundlePath,
    derivedBundleRelativePath: packaged.bundleRelativePath,
    artifacts: packaged.artifacts,
    startedAt,
    endedAt,
  };
  if (request.renderer.mode === "registered") {
    runResult.rendererId = request.renderer.id;
  } else {
    runResult.rendererLanguage = request.renderer.language;
    if (execution.generatedScriptPath) {
      runResult.generatedScriptPath = execution.generatedScriptPath;
    }
  }
  if (packaged.wikiPageRelative) {
    runResult.wikiPageRelative = packaged.wikiPageRelative;
  }
  await fs.writeFile(resultPath, `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  return runResult;
}

export async function promoteGeneratedRenderer(input: {
  runDir: string;
  request: ArtifactRequest;
  targetRoot: string;
  rendererId?: string;
}): Promise<{ rendererId: string; rendererDir: string; manifestPath: string; entryPath: string }> {
  if (input.request.renderer.mode !== "generated") {
    throw new Error("Only generated renderer runs can be promoted");
  }
  const suggestedId = input.request.renderer.mode === "generated" ? input.request.renderer.suggestedId : undefined;
  const rendererId = sanitizeRendererId(input.rendererId ?? `generated.${input.request.artifactKind}.${input.request.artifactId ?? suggestedId ?? input.request.title}`);
  const rendererDir = path.join(path.resolve(input.targetRoot), rendererId.replace(/[._]+/g, "-"));
  const ext = input.request.renderer.language === "python" ? ".py" : ".mjs";
  const entryName = `render${ext}`;
  const sourcePath = path.join(input.runDir, "generated", entryName);
  const targetPath = path.join(rendererDir, entryName);
  await assertExists(sourcePath, "generated renderer source");
  await fs.mkdir(rendererDir, { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  const manifest: ArtifactRendererManifest = {
    id: rendererId,
    title: input.request.title,
    description: `Promoted from generated renderer request for ${input.request.title}`,
    artifactKinds: [input.request.artifactKind],
    entry: entryName,
    runtime: input.request.renderer.language === "python" ? "python" : "node",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const manifestPath = path.join(rendererDir, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { rendererId, rendererDir, manifestPath, entryPath: targetPath };
}

async function runRegisteredRenderer(input: {
  request: ArtifactRequest;
  runDir: string;
  outputDir: string;
  resultPath: string;
  inputSnapshotPath: string;
  vaultRoot: string;
  rawRoot: string;
  wikiRoot: string;
  derivedRoot: string;
  rendererRegistryRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RendererExecutionResult> {
  if (input.request.renderer.mode !== "registered") {
    throw new Error("Expected registered renderer request");
  }
  const rendererRequest = input.request.renderer;
  const renderers = await discoverArtifactRenderers(input.rendererRegistryRoot);
  const renderer = renderers.find((item) => item.manifest.id === rendererRequest.id);
  if (!renderer) {
    throw new Error(`Artifact renderer is not registered: ${rendererRequest.id}`);
  }
  if (
    renderer.manifest.artifactKinds.length > 0 &&
    !renderer.manifest.artifactKinds.includes(input.request.artifactKind)
  ) {
    throw new Error(`Renderer ${renderer.manifest.id} does not support artifact kind ${input.request.artifactKind}`);
  }
  const executable = renderer.manifest.runtime === "node" ? process.execPath : artifactPythonBin(input.env);
  const args = renderer.manifest.runtime === "node" ? [renderer.entryPath] : [renderer.entryPath];
  return executeRenderer({
    command: executable,
    args,
    cwd: renderer.rendererDir,
    timeoutMs: renderer.manifest.timeoutMs,
    env: {
      ...(input.env ?? process.env),
      TLGI_ARTIFACT_REQUEST_PATH: path.join(input.runDir, "request.json"),
      TLGI_ARTIFACT_INPUT_JSON: input.inputSnapshotPath,
      TLGI_ARTIFACT_OUTPUT_DIR: input.outputDir,
      TLGI_ARTIFACT_RESULT_PATH: input.resultPath,
      TLGI_VAULT_ROOT: input.vaultRoot,
      TLGI_RAW_ROOT: input.rawRoot,
      TLGI_WIKI_ROOT: input.wikiRoot,
      TLGI_DERIVED_ROOT: input.derivedRoot,
    },
    outputDir: input.outputDir,
    resultPath: input.resultPath,
  });
}

async function runGeneratedRenderer(input: {
  request: ArtifactRequest;
  runDir: string;
  outputDir: string;
  resultPath: string;
  inputSnapshotPath: string;
  vaultRoot: string;
  rawRoot: string;
  wikiRoot: string;
  derivedRoot: string;
  allowGeneratedRenderers: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<RendererExecutionResult> {
  if (input.request.renderer.mode !== "generated") {
    throw new Error("Expected generated renderer request");
  }
  if (!input.allowGeneratedRenderers) {
    throw new Error("Generated renderers are disabled by configuration");
  }
  validateGeneratedRendererCode(input.request.renderer.code, input.request.renderer.language);
  const generatedDir = path.join(input.runDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  const entryName = input.request.renderer.language === "python" ? "render.py" : "render.mjs";
  const scriptPath = path.join(generatedDir, entryName);
  await fs.writeFile(scriptPath, input.request.renderer.code, "utf8");
  const executable = input.request.renderer.language === "python"
    ? artifactPythonBin(input.env)
    : process.execPath;
  return executeRenderer({
    command: executable,
    args: [scriptPath, input.inputSnapshotPath, input.outputDir, input.resultPath],
    cwd: generatedDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: {
      ...(input.env ?? process.env),
      TLGI_ARTIFACT_REQUEST_PATH: path.join(input.runDir, "request.json"),
      TLGI_ARTIFACT_INPUT_JSON: input.inputSnapshotPath,
      TLGI_ARTIFACT_OUTPUT_DIR: input.outputDir,
      TLGI_ARTIFACT_RESULT_PATH: input.resultPath,
      TLGI_VAULT_ROOT: input.vaultRoot,
      TLGI_RAW_ROOT: input.rawRoot,
      TLGI_WIKI_ROOT: input.wikiRoot,
      TLGI_DERIVED_ROOT: input.derivedRoot,
    },
    outputDir: input.outputDir,
    resultPath: input.resultPath,
    generatedScriptPath: scriptPath,
  });
}

async function executeRenderer(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  outputDir: string;
  resultPath: string;
  generatedScriptPath?: string;
}): Promise<RendererExecutionResult> {
  const { stdout, stderr } = await runBufferedCommand(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
  });
  const artifacts = await collectRendererArtifacts(input.outputDir, input.resultPath);
  const result: RendererExecutionResult = { stdout, stderr, artifacts };
  if (input.generatedScriptPath) {
    result.generatedScriptPath = input.generatedScriptPath;
  }
  return result;
}

async function collectRendererArtifacts(outputDir: string, resultPath: string): Promise<RendererArtifact[]> {
  let declared: RendererArtifact[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(resultPath, "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.artifacts)) {
      declared = parsed.artifacts.flatMap((record) => {
        if (!isRecord(record) || typeof record.path !== "string") {
          return [];
        }
        return [{
          path: record.path,
          ...(typeof record.role === "string" ? { role: record.role } : {}),
          ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
        }];
      });
    }
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  if (declared.length > 0) {
    return declared;
  }
  const files = await listFiles(outputDir);
  return files.map((filePath) => ({
    path: path.relative(outputDir, filePath).replace(/\\/g, "/"),
    role: inferArtifactRole(filePath),
    mediaType: inferMediaType(filePath),
  }));
}

async function finalizeDerivedPackage(input: {
  request: ArtifactRequest;
  artifactId: string;
  runId: string;
  runDir: string;
  outputDir: string;
  derivedRoot: string;
  wikiRoot: string;
  sourcePrompt: string;
  sourceSnapshot: ArtifactSourceSnapshot[];
  execution: RendererExecutionResult;
  startedAt: string;
  ingestDerivedCommand?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  artifactId: string;
  bundlePath: string;
  bundleRelativePath: string;
  wikiPageRelative?: string;
  artifacts: PackagedArtifact[];
}> {
  if (input.execution.artifacts.length === 0) {
    throw new Error("Artifact renderer did not create any output artifacts");
  }
  const datePart = input.startedAt.slice(0, 10);
  const artifactId = await availableArtifactId(input.derivedRoot, datePart, input.artifactId, input.runId);
  const bundlePath = path.join(input.derivedRoot, datePart, artifactId);
  const artifactsDir = path.join(bundlePath, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });

  const packaged: PackagedArtifact[] = [];
  for (const artifact of input.execution.artifacts) {
    const sourcePath = path.resolve(input.outputDir, artifact.path);
    assertInside(input.outputDir, sourcePath, "Renderer artifact must stay inside output directory");
    await assertExists(sourcePath, "renderer artifact");
    const fileName = safeFileName(path.basename(sourcePath));
    const targetPath = path.join(artifactsDir, fileName);
    await fs.copyFile(sourcePath, targetPath);
    const stat = await fs.stat(targetPath);
    packaged.push({
      id: `artifact:${safeName(path.parse(fileName).name)}`,
      role: artifact.role ?? inferArtifactRole(targetPath),
      path: `artifacts/${fileName}`,
      mediaType: artifact.mediaType ?? inferMediaType(targetPath),
      sha256: await sha256File(targetPath),
      sizeBytes: stat.size,
    });
  }

  const generatedAt = new Date().toISOString();
  const presentationArtifacts = await createPresentationArtifacts({
    request: input.request,
    artifactId,
    bundlePath,
    artifactsDir,
    sourcePrompt: input.sourcePrompt,
    sourceSnapshot: input.sourceSnapshot,
    contentArtifacts: [...packaged],
    generatedAt,
    ...(input.env ? { env: input.env } : {}),
  });
  packaged.push(...presentationArtifacts);
  const provenance = {
    artifact_id: artifactId,
    title: input.request.title,
    artifact_kind: input.request.artifactKind,
    generated_at: generatedAt,
    source_authority: "derived_from_wiki_and_raw_citations",
    request: input.request,
    user_prompt: input.sourcePrompt,
    renderer: {
      mode: input.request.renderer.mode,
      ...(input.request.renderer.mode === "registered"
        ? { id: input.request.renderer.id }
        : {
          language: input.request.renderer.language,
          script_sha256: input.execution.generatedScriptPath ? await sha256File(input.execution.generatedScriptPath) : null,
        }),
    },
    sources: input.sourceSnapshot.map((source) => ({
      path: source.path,
      label: source.label,
      type: source.type,
      sha256: source.sha256,
      size_bytes: source.sizeBytes,
    })),
    run: {
      id: input.runId,
      run_dir: input.runDir,
    },
    artifacts: packaged,
  };
  const manifest = [
    "schema_version: 1",
    `artifact_id: "${yamlEscape(artifactId)}"`,
    `title: "${yamlEscape(input.request.title)}"`,
    `artifact_kind: "${yamlEscape(input.request.artifactKind)}"`,
    'source_kind: "derived"',
    'source_authority: "derived_from_wiki_and_raw_citations"',
    `created_at: "${generatedAt}"`,
    "tags:",
    '  - "derived"',
    `  - "${yamlEscape(input.request.artifactKind)}"`,
    "artifacts:",
    ...packaged.flatMap((artifact) => [
      `  - id: "${yamlEscape(artifact.id)}"`,
      `    role: "${yamlEscape(artifact.role)}"`,
      `    path: "${yamlEscape(artifact.path)}"`,
      `    media_type: "${yamlEscape(artifact.mediaType)}"`,
      `    sha256: "${artifact.sha256}"`,
      `    size_bytes: ${artifact.sizeBytes}`,
    ]),
    "provenance:",
    '  path: "provenance.json"',
    `  source_count: ${input.sourceSnapshot.length}`,
    "",
  ].join("\n");
  const source = [
    `# Derived ${input.request.title}`,
    "",
    "## Authority",
    "",
    "This package is a derived artifact generated from already-ingested wiki/raw data. It is not primary evidence; factual claims should cite the underlying canonical raw inputs recorded in `provenance.json`.",
    "",
    "## Artifacts",
    "",
    ...packaged.map((artifact) => `- [${artifact.path.replace(/^artifacts\//, "")}](${artifact.path}) (${artifact.mediaType}, ${artifact.sizeBytes} bytes)`),
    "",
    "## Request",
    "",
    input.sourcePrompt.trim() || "(no prompt recorded)",
    "",
    "## Source Basis",
    "",
    input.sourceSnapshot.length > 0
      ? input.sourceSnapshot.map((source) => `- \`${source.path}\``).join("\n")
      : "- No explicit sources were declared; see request parameters and renderer output.",
    "",
  ].join("\n");

  await Promise.all([
    fs.writeFile(path.join(bundlePath, "manifest.yaml"), manifest, "utf8"),
    fs.writeFile(path.join(bundlePath, "source.md"), source, "utf8"),
    fs.writeFile(path.join(bundlePath, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8"),
    fs.writeFile(path.join(bundlePath, ".finalized"), `${generatedAt}\n`, "utf8"),
  ]);

  let wikiPageRelative: string | undefined;
  if (input.ingestDerivedCommand) {
    const [command, ...baseArgs] = splitCommandLine(input.ingestDerivedCommand);
    if (!command) {
      throw new Error("Derived ingest command is empty");
    }
    const ingest = await runBufferedCommand(command, [
      ...baseArgs,
      "--bundle", bundlePath,
      "--derived-root", input.derivedRoot,
      "--wiki-root", input.wikiRoot,
    ], { cwd: path.dirname(input.wikiRoot), env: input.env ?? process.env, timeoutMs: DEFAULT_TIMEOUT_MS });
    const match = ingest.stdout.match(/->\s+(derived\/[^\s]+\.md)/);
    if (match?.[1]) {
      wikiPageRelative = match[1];
    }
  }

  const result: {
    artifactId: string;
    bundlePath: string;
    bundleRelativePath: string;
    wikiPageRelative?: string;
    artifacts: PackagedArtifact[];
  } = {
    artifactId,
    bundlePath,
    bundleRelativePath: path.relative(path.dirname(input.derivedRoot), bundlePath).replace(/\\/g, "/"),
    artifacts: packaged,
  };
  if (wikiPageRelative) {
    result.wikiPageRelative = wikiPageRelative;
  }
  return result;
}

async function createPresentationArtifacts(input: {
  request: ArtifactRequest;
  artifactId: string;
  bundlePath: string;
  artifactsDir: string;
  sourcePrompt: string;
  sourceSnapshot: ArtifactSourceSnapshot[];
  contentArtifacts: PackagedArtifact[];
  generatedAt: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PackagedArtifact[]> {
  const formats = presentationFormats(input.request);
  if (formats.length === 0) {
    return [];
  }
  const baseName = presentationBaseName(input.artifactId, input.request.title);
  const docxPath = path.join(input.artifactsDir, `${baseName}.docx`);
  await writePresentationDocx({
    outputPath: docxPath,
    title: input.request.title,
    artifactKind: input.request.artifactKind,
    generatedAt: input.generatedAt,
    sourcePrompt: input.sourcePrompt,
    sourceSnapshot: input.sourceSnapshot,
    artifacts: input.contentArtifacts,
    bundlePath: input.bundlePath,
  });
  const artifacts: PackagedArtifact[] = [await packagePresentationArtifact(docxPath, `artifacts/${path.basename(docxPath)}`, "presentation")];
  if (formats.includes("pdf")) {
    const pdfPath = path.join(input.artifactsDir, `${baseName}.pdf`);
    await renderPresentationPdf({
      docxPath,
      pdfPath,
      ...(input.env ? { env: input.env } : {}),
    });
    artifacts.push(await packagePresentationArtifact(pdfPath, `artifacts/${path.basename(pdfPath)}`, "presentation"));
  }
  return artifacts;
}

function presentationFormats(request: ArtifactRequest): Array<"docx" | "pdf"> {
  const parameters = request.parameters;
  const presentation = isRecord(parameters.presentation) ? parameters.presentation : {};
  const rawFormats = presentation.formats ?? parameters.presentationFormats ?? parameters.outputFormats;
  const values = Array.isArray(rawFormats)
    ? rawFormats
    : typeof rawFormats === "string"
      ? rawFormats.split(/[\s,]+/)
      : ["docx"];
  const formats = new Set<"docx" | "pdf">(["docx"]);
  for (const value of values) {
    const normalized = String(value).trim().toLowerCase().replace(/^\./, "");
    if (normalized === "pdf") {
      formats.add("pdf");
    }
    if (normalized === "docx") {
      formats.add("docx");
    }
  }
  return [...formats];
}

async function packagePresentationArtifact(filePath: string, relativePath: string, role: string): Promise<PackagedArtifact> {
  const stat = await fs.stat(filePath);
  return {
    id: `artifact:${safeName(path.parse(filePath).name)}`,
    role,
    path: relativePath,
    mediaType: inferMediaType(filePath),
    sha256: await sha256File(filePath),
    sizeBytes: stat.size,
  };
}

function presentationBaseName(artifactId: string, title: string): string {
  const titleSuffix = safeUnicodeFileName(title) || "presentation";
  return `${safeName(artifactId)}_${titleSuffix}`;
}

async function writePresentationDocx(input: {
  outputPath: string;
  title: string;
  artifactKind: string;
  generatedAt: string;
  sourcePrompt: string;
  sourceSnapshot: ArtifactSourceSnapshot[];
  artifacts: PackagedArtifact[];
  bundlePath: string;
}): Promise<void> {
  const entries: Array<{ name: string; content: Buffer | string }> = [];
  const relationships: Array<{ id: string; type: string; target: string }> = [];
  const contentTypeDefaults = new Map<string, string>([
    ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
    ["xml", "application/xml"],
  ]);
  const body: string[] = [
    paragraphXml(input.title, "Title"),
    paragraphXml(`Artifact kind: ${input.artifactKind}`, "Subtitle"),
    paragraphXml(`Generated: ${input.generatedAt}`, "Muted"),
    headingXml("Overview", 1),
    tableXml([
      ["Field", "Value"],
      ["Title", input.title],
      ["Artifact kind", input.artifactKind],
      ["Content artifacts", String(input.artifacts.length)],
      ["Source pages", String(input.sourceSnapshot.length)],
    ], true),
  ];

  const prompt = input.sourcePrompt.trim();
  if (prompt) {
    body.push(headingXml("User Request", 1));
    body.push(...plainTextParagraphs(prompt, "BodyText"));
  }

  body.push(headingXml("Generated Content", 1));
  body.push(tableXml([
    ["File", "Role", "Type", "Size"],
    ...input.artifacts.map((artifact) => [
      artifact.path.replace(/^artifacts\//, ""),
      artifact.role,
      artifact.mediaType,
      formatBytes(artifact.sizeBytes),
    ]),
  ], true));

  for (const artifact of input.artifacts) {
    const artifactPath = path.join(input.bundlePath, artifact.path);
    body.push(headingXml(artifact.path.replace(/^artifacts\//, ""), 2));
    if (isEmbeddableDocxImage(artifact)) {
      const mediaName = safeFileName(path.basename(artifact.path));
      const relationshipId = `rId${relationships.length + 1}`;
      relationships.push({
        id: relationshipId,
        type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
        target: `media/${mediaName}`,
      });
      contentTypeDefaults.set(path.extname(mediaName).slice(1).toLowerCase(), artifact.mediaType);
      entries.push({ name: `word/media/${mediaName}`, content: await fs.readFile(artifactPath) });
      body.push(imageParagraphXml(relationshipId, artifact.path.replace(/^artifacts\//, "")));
      continue;
    }

    if (artifact.mediaType === "text/csv") {
      const csvTable = await csvPreviewTable(artifactPath);
      if (csvTable.length > 0) {
        body.push(tableXml(csvTable, true));
        continue;
      }
    }

    const preview = await textPreview(artifactPath, artifact);
    if (preview) {
      body.push(...plainTextParagraphs(preview, "BodyText"));
    } else {
      body.push(paragraphXml(`Included as file: ${artifact.path} (${artifact.mediaType}, ${formatBytes(artifact.sizeBytes)})`, "Muted"));
    }
  }

  if (input.sourceSnapshot.length > 0) {
    body.push(headingXml("Source Basis", 1));
    body.push(tableXml([
      ["Source", "Type", "Size", "SHA-256"],
      ...input.sourceSnapshot.slice(0, 30).map((source) => [
        source.path,
        source.type ?? "",
        formatBytes(source.sizeBytes),
        source.sha256.slice(0, 16),
      ]),
    ], true));
    if (input.sourceSnapshot.length > 30) {
      body.push(paragraphXml(`Additional sources omitted from this readable view: ${input.sourceSnapshot.length - 30}`, "Muted"));
    }
  }

  entries.push(
    { name: "[Content_Types].xml", content: contentTypesXml(contentTypeDefaults) },
    { name: "_rels/.rels", content: rootRelationshipsXml() },
    { name: "word/_rels/document.xml.rels", content: documentRelationshipsXml(relationships) },
    { name: "word/styles.xml", content: stylesXml() },
    { name: "word/document.xml", content: documentXml(body.join("")) },
  );
  await writeZip(entries, input.outputPath);
}

async function renderPresentationPdf(input: {
  docxPath: string;
  pdfPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(path.dirname(input.pdfPath), ".presentation-pdf-"));
  try {
    const tempDocx = path.join(tempDir, "presentation.docx");
    await fs.copyFile(input.docxPath, tempDocx);
    const executable = input.env?.LIBREOFFICE_BIN ?? input.env?.SOFFICE_BIN ?? "libreoffice";
    await runBufferedCommand(executable, ["--headless", "--convert-to", "pdf", "--outdir", tempDir, tempDocx], {
      cwd: tempDir,
      env: input.env ?? process.env,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    await fs.copyFile(path.join(tempDir, "presentation.pdf"), input.pdfPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function isEmbeddableDocxImage(artifact: PackagedArtifact): boolean {
  return ["image/png", "image/jpeg"].includes(artifact.mediaType);
}

async function textPreview(filePath: string, artifact: PackagedArtifact): Promise<string | null> {
  if (!["text/markdown", "text/plain", "application/json"].includes(artifact.mediaType)) {
    return null;
  }
  if (artifact.sizeBytes > 128 * 1024) {
    return `Text preview skipped because the artifact is large (${formatBytes(artifact.sizeBytes)}).`;
  }
  const text = await fs.readFile(filePath, "utf8");
  return text.length > 4000 ? `${text.slice(0, 4000)}\n\n[Preview truncated]` : text;
}

async function csvPreviewTable(filePath: string): Promise<string[][]> {
  const text = await fs.readFile(filePath, "utf8");
  const rows = parseCsvRows(text).slice(0, 9).map((row) => row.slice(0, 6));
  return rows.length > 0 ? rows : [];
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (quoted && char === '"' && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ",") {
      row.push(current);
      current = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(current);
      if (row.some((cell) => cell.trim())) {
        rows.push(row);
      }
      row = [];
      current = "";
      continue;
    }
    current += char;
  }
  row.push(current);
  if (row.some((cell) => cell.trim())) {
    rows.push(row);
  }
  return rows;
}

function plainTextParagraphs(text: string, style = "BodyText"): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((line) => paragraphXml(line.replace(/^#{1,6}\s+/, ""), style));
}

function documentXml(bodyXml: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">',
    `<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>`,
    "</w:document>",
  ].join("");
}

function paragraphXml(text: string, style = "BodyText"): string {
  return `<w:p><w:pPr><w:pStyle w:val="${xmlEscape(style)}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function headingXml(text: string, level: 1 | 2): string {
  return paragraphXml(text, level === 1 ? "Heading1" : "Heading2");
}

function tableXml(rows: string[][], header = false): string {
  const width = 9360;
  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const columnWidth = Math.floor(width / maxColumns);
  const tableRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: maxColumns }, (_, cellIndex) => tableCellXml(row[cellIndex] ?? "", columnWidth, header && rowIndex === 0)).join("");
    return `<w:tr>${cells}</w:tr>`;
  }).join("");
  return [
    "<w:tbl>",
    `<w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D7DE"/><w:left w:val="single" w:sz="4" w:color="D0D7DE"/><w:bottom w:val="single" w:sz="4" w:color="D0D7DE"/><w:right w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideH w:val="single" w:sz="4" w:color="D0D7DE"/><w:insideV w:val="single" w:sz="4" w:color="D0D7DE"/></w:tblBorders></w:tblPr>`,
    `<w:tblGrid>${Array.from({ length: maxColumns }, () => `<w:gridCol w:w="${columnWidth}"/>`).join("")}</w:tblGrid>`,
    tableRows,
    "</w:tbl>",
  ].join("");
}

function tableCellXml(text: string, width: number, header: boolean): string {
  const shading = header ? '<w:shd w:fill="EAF2F8"/>' : "";
  const run = header ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>` : `<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shading}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr><w:p>${run}</w:p></w:tc>`;
}

function imageParagraphXml(relationshipId: string, name: string): string {
  const cx = 7_600_000;
  const cy = 4_300_000;
  return [
    "<w:p><w:r><w:drawing>",
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="${xmlEscape(name)}"/>`,
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>',
    '<pic:nvPicPr><pic:cNvPr id="0" name="artifact image"/><pic:cNvPicPr/></pic:nvPicPr>',
    `<pic:blipFill><a:blip r:embed="${xmlEscape(relationshipId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`,
    "</pic:pic></a:graphicData></a:graphic></wp:inline>",
    "</w:drawing></w:r></w:p>",
  ].join("");
}

function contentTypesXml(defaults: Map<string, string>): string {
  const defaultXml = [...defaults.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([extension, contentType]) => `<Default Extension="${xmlEscape(extension)}" ContentType="${xmlEscape(contentType)}"/>`)
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    defaultXml,
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    "</Types>",
  ].join("");
}

function rootRelationshipsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    "</Relationships>",
  ].join("");
}

function documentRelationshipsXml(relationships: Array<{ id: string; type: string; target: string }>): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    ...relationships.map((relationship) => `<Relationship Id="${xmlEscape(relationship.id)}" Type="${xmlEscape(relationship.type)}" Target="${xmlEscape(relationship.target)}"/>`),
    "</Relationships>",
  ].join("");
}

function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="180"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:color w:val="5B6770"/><w:sz w:val="22"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Muted"><w:name w:val="Muted"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:color w:val="6B7280"/><w:sz w:val="18"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    "</w:styles>",
  ].join("");
}

async function writeZip(entries: Array<{ name: string; content: Buffer | string }>, targetPath: string): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fileName = entry.name.replace(/^\/+/, "");
    const nameBuffer = Buffer.from(fileName, "utf8");
    const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(targetPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    const lookup = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = lookup ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return c >>> 0;
});

function safeUnicodeFileName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function buildSourceSnapshot(
  sources: ArtifactRequest["sources"],
  roots: { vaultRoot: string; rawRoot: string; wikiRoot: string; derivedRoot: string },
): Promise<ArtifactSourceSnapshot[]> {
  const snapshots: ArtifactSourceSnapshot[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const absolutePaths = await expandArtifactSourcePaths(source.path, roots);
    for (const absolutePath of absolutePaths) {
      const vaultRelative = path.relative(roots.vaultRoot, absolutePath).replace(/\\/g, "/");
      if (seen.has(vaultRelative)) {
        continue;
      }
      seen.add(vaultRelative);
      assertAllowedArtifactSource(absolutePath, roots);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error(`Artifact source is not a file: ${source.path}`);
      }
      const snapshot: ArtifactSourceSnapshot = {
        path: vaultRelative,
        absolutePath,
        sizeBytes: stat.size,
        sha256: await sha256File(absolutePath),
      };
      if (source.label) {
        snapshot.label = source.label;
      }
      if (source.type) {
        snapshot.type = source.type;
      }
      if (isTextLike(absolutePath) && stat.size <= MAX_SOURCE_TEXT_BYTES) {
        snapshot.text = await fs.readFile(absolutePath, "utf8");
      }
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

async function expandArtifactSourcePaths(
  sourcePath: string,
  roots: { vaultRoot: string; rawRoot: string; wikiRoot: string; derivedRoot: string },
): Promise<string[]> {
  const expandedPatterns = expandBracePatterns(sourcePath);
  const matches: string[] = [];
  const unmatchedGlobPatterns: string[] = [];
  for (const pattern of expandedPatterns) {
    const absolutePattern = path.resolve(path.isAbsolute(pattern) ? pattern : path.join(roots.vaultRoot, pattern));
    const vaultRelativePattern = path.relative(roots.vaultRoot, absolutePattern).replace(/\\/g, "/");
    if (vaultRelativePattern.startsWith("..") || path.isAbsolute(vaultRelativePattern)) {
      throw new Error(`Artifact source is outside vault root: ${sourcePath}`);
    }
    if (!hasGlobMeta(vaultRelativePattern)) {
      matches.push(absolutePattern);
      continue;
    }

    const searchRoot = artifactSourceSearchRoot(vaultRelativePattern, roots);
    const candidates = await listFilesIfExists(searchRoot);
    const matcher = globPatternToRegExp(vaultRelativePattern);
    const patternMatches = candidates
      .filter((candidate) => matcher.test(path.relative(roots.vaultRoot, candidate).replace(/\\/g, "/")))
      .sort((left, right) => left.localeCompare(right));
    if (patternMatches.length === 0) {
      unmatchedGlobPatterns.push(pattern);
    }
    matches.push(...patternMatches);
  }
  const unique = [...new Set(matches)].sort((left, right) => {
    const leftRelative = path.relative(roots.vaultRoot, left).replace(/\\/g, "/");
    const rightRelative = path.relative(roots.vaultRoot, right).replace(/\\/g, "/");
    return leftRelative.localeCompare(rightRelative);
  });
  if (unique.length === 0 && unmatchedGlobPatterns.length > 0) {
    throw new Error(`Artifact source glob matched no files: ${sourcePath}`);
  }
  return unique;
}

function artifactSourceSearchRoot(
  vaultRelativePattern: string,
  roots: { vaultRoot: string; rawRoot: string; wikiRoot: string; derivedRoot: string },
): string {
  if (vaultRelativePattern.startsWith("wiki/")) {
    return roots.wikiRoot;
  }
  if (vaultRelativePattern.startsWith("raw/")) {
    return roots.rawRoot;
  }
  if (vaultRelativePattern.startsWith("derived/")) {
    return roots.derivedRoot;
  }
  return roots.vaultRoot;
}

async function listFilesIfExists(root: string): Promise<string[]> {
  try {
    return await listFiles(root);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

function hasGlobMeta(value: string): boolean {
  return /[*?[\]]/.test(value);
}

function expandBracePatterns(pattern: string): string[] {
  const rangeMatch = pattern.match(/\{(\d+)\.\.(\d+)\}/);
  if (rangeMatch?.[0] && rangeMatch[1] && rangeMatch[2]) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    const width = Math.max(rangeMatch[1].length, rangeMatch[2].length);
    const step = start <= end ? 1 : -1;
    const expanded: string[] = [];
    for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
      const replacement = String(value).padStart(width, "0");
      expanded.push(...expandBracePatterns(pattern.replace(rangeMatch[0], replacement)));
    }
    return expanded;
  }

  const listMatch = pattern.match(/\{([^{}]+)\}/);
  if (listMatch?.[0] && listMatch[1]?.includes(",")) {
    return listMatch[1]
      .split(",")
      .flatMap((value) => expandBracePatterns(pattern.replace(listMatch[0], value.trim())));
  }

  return [pattern];
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === '?') {
      source += "[^/]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close > index + 1) {
        source += pattern.slice(index, close + 1);
        index = close;
      } else {
        source += "\\[";
      }
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function assertAllowedArtifactSource(
  absolutePath: string,
  roots: { rawRoot: string; wikiRoot: string; derivedRoot: string },
): void {
  if (isPathInside(roots.rawRoot, absolutePath)) {
    const parts = path.relative(roots.rawRoot, absolutePath).split(path.sep);
    const subPath = parts.slice(2).join("/");
    if (parts.length >= 3 && (
      subPath === "source.md" ||
      subPath === "manifest.yaml" ||
      subPath.startsWith("extracted/")
    )) {
      return;
    }
  }
  if (isPathInside(roots.wikiRoot, absolutePath)) {
    const relative = path.relative(roots.wikiRoot, absolutePath).replace(/\\/g, "/");
    if ((relative.startsWith("sources/") || relative.startsWith("derived/")) && relative.endsWith(".md")) {
      return;
    }
  }
  if (isPathInside(roots.derivedRoot, absolutePath)) {
    const parts = path.relative(roots.derivedRoot, absolutePath).split(path.sep);
    const subPath = parts.slice(2).join("/");
    if (parts[0] !== "_staging" && parts.length >= 3 && (
      subPath === "source.md" ||
      subPath === "manifest.yaml" ||
      subPath === "provenance.json" ||
      subPath.startsWith("artifacts/")
    )) {
      return;
    }
  }
  throw new Error(`Artifact source path is not allowed: ${absolutePath}`);
}

function validateGeneratedRendererCode(code: string, language: "python" | "javascript"): void {
  const blocked = language === "python"
    ? [
      /\bsubprocess\b/,
      /\bsocket\b/,
      /\brequests\b/,
      /\burllib\b/,
      /\bshutil\b/,
      /\bos\.system\b/,
      /\bpopen\b/,
      /\beval\s*\(/,
      /\bexec\s*\(/,
      /\.env\b/,
      /\/home\//,
      /\.\.\//,
    ]
    : [
      /\bchild_process\b/,
      /\bnet\b/,
      /\bhttp\b/,
      /\bhttps\b/,
      /\bfetch\s*\(/,
      /\beval\s*\(/,
      /Function\s*\(/,
      /\.env\b/,
      /\/home\//,
      /\.\.\//,
    ];
  const hit = blocked.find((pattern) => pattern.test(code));
  if (hit) {
    throw new Error(`Generated renderer code failed safety check: ${hit}`);
  }
}

function artifactPythonBin(env?: NodeJS.ProcessEnv): string {
  return env?.WIKI_ARTIFACT_PYTHON_BIN ?? env?.PYTHON_BIN ?? "python3";
}

async function availableArtifactId(derivedRoot: string, datePart: string, preferred: string, runId: string): Promise<string> {
  const first = safeName(preferred);
  if (!await pathExists(path.join(derivedRoot, datePart, first, ".finalized"))) {
    return first;
  }
  return safeName(`${first}_${runId.slice(-8)}`);
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(filePath));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function runBufferedCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      }
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (exitCode !== 0) {
        reject(new Error(stderrText || stdoutText || `${command} exited with ${exitCode}`));
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

function splitCommandLine(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char ?? "")) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    result.push(current);
  }
  return result;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function assertExists(filePath: string, label: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertInside(root: string, candidate: string, message: string): void {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${message}: ${candidate}`);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeName(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "artifact";
}

function sanitizeRendererId(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^[._-]+|[._-]+$/g, "");
  return safe || `generated.renderer.${Date.now()}`;
}

function safeFileName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "artifact";
}

function yamlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function inferArtifactRole(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".svg", ".pdf"].includes(ext)) {
    return "visualization";
  }
  if ([".csv", ".json", ".xlsx"].includes(ext)) {
    return "data";
  }
  return "report";
}

function inferMediaType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

function isTextLike(filePath: string): boolean {
  return [".md", ".txt", ".csv", ".json", ".yaml", ".yml"].includes(path.extname(filePath).toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
