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
  const executable = renderer.manifest.runtime === "node" ? process.execPath : (input.env?.PYTHON_BIN ?? "python3");
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
    ? (input.env?.PYTHON_BIN ?? "python3")
    : process.execPath;
  return executeRenderer({
    command: executable,
    args: [scriptPath, input.inputSnapshotPath, input.outputDir, input.resultPath],
    cwd: generatedDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env: input.env ?? process.env,
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

async function buildSourceSnapshot(
  sources: ArtifactRequest["sources"],
  roots: { vaultRoot: string; rawRoot: string; wikiRoot: string; derivedRoot: string },
): Promise<ArtifactSourceSnapshot[]> {
  const snapshots: ArtifactSourceSnapshot[] = [];
  for (const source of sources) {
    const absolutePath = path.resolve(path.isAbsolute(source.path) ? source.path : path.join(roots.vaultRoot, source.path));
    const vaultRelative = path.relative(roots.vaultRoot, absolutePath).replace(/\\/g, "/");
    if (vaultRelative.startsWith("..") || path.isAbsolute(vaultRelative)) {
      throw new Error(`Artifact source is outside vault root: ${source.path}`);
    }
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
  return snapshots;
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
