import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentAdapterError,
  buildAgentCommand,
  buildAgentPrompt,
  runAgentPostprocess,
  type CommandRunner,
} from "@telegram-local-ingest/agent-adapter";

test("buildAgentPrompt constrains agents to raw read and output writes", () => {
  const prompt = buildAgentPrompt(inputFixture(createFixture()));

  assert.match(prompt, /Do not modify, delete, rename, or create files under raw\/\*\*\./);
  assert.match(prompt, /Target language: ko/);
  assert.match(prompt, /Relationship\/tone preset: business/);
  assert.match(prompt, /meeting\.transcript\.md/);
  assert.match(prompt, /Business Document Translation Preset/);
  assert.match(prompt, /2 translators \+ 1 reviewer/);
  assert.match(prompt, /Create Markdown only/);
  assert.match(prompt, /translated\.md/);
  assert.match(prompt, /Do not create DOCX, PDF, HWP, HWPX, ZIP, or other binary output yourself/);
  assert.match(prompt, /Do not append the original\/source section yourself/);
  assert.match(prompt, /worker may append `\[원문\]` itself/);
});

test("buildAgentPrompt requires Markdown output for document-derived artifacts", () => {
  const fixture = createFixture();
  const prompt = buildAgentPrompt({
    ...inputFixture(fixture),
    artifacts: [{
      id: "artifact-eml",
      kind: "eml_text",
      fileName: "vendor-update.eml.txt",
      sourcePath: fixture.transcriptPath,
      charCount: 128,
      truncated: false,
    }],
  });

  assert.match(prompt, /Create exactly one final translated Markdown file named `translated\.md`/);
  assert.match(prompt, /Do not create `\.docx`, `\.pdf`, `\.hwp`, `\.hwpx`, `\.zip`/);
  assert.match(prompt, /OUTPUT_FORMAT: \.md \(worker-rendered to the final Telegram document format\)/);
});

test("buildAgentPrompt asks for block translations when DOCX structure is available", () => {
  const fixture = createFixture();
  const prompt = buildAgentPrompt({
    ...inputFixture(fixture),
    artifacts: [{
      id: "artifact-docx",
      kind: "docx_text",
      fileName: "vendor-template.docx.txt",
      sourcePath: fixture.transcriptPath,
      structurePath: path.join(fixture.root, "vendor-template.blocks.json"),
      charCount: 128,
      truncated: false,
    }],
  });

  assert.match(prompt, /structure path:/);
  assert.match(prompt, /also create `translations\.json`/);
  assert.match(prompt, /exact block ids/);
  assert.match(prompt, /Create text output files only: `translated\.md` and `translations\.json`/);
  assert.match(prompt, /both `translated\.md` and `translations\.json` exist directly in the output directory/);
  assert.match(prompt, /Create exactly these two text files directly in the output directory/);
  assert.doesNotMatch(prompt, /Create Markdown only/);
});

test("buildAgentCommand replaces placeholders and detects prompt file usage", () => {
  const command = buildAgentCommand("{projectRoot}/scripts/run-codex-postprocess.sh --prompt {promptFile} --output {outputDir} --bundle {bundlePath} --job {jobId}", {
    bundlePath: "/raw/job",
    jobId: "job-1",
    outputDir: "/runtime/out",
    projectRoot: "/repo",
    promptFile: "/runtime/work/prompt.md",
  });

  assert.equal(command.command, "/repo/scripts/run-codex-postprocess.sh");
  assert.deepEqual(command.args, ["--prompt", "/runtime/work/prompt.md", "--output", "/runtime/out", "--bundle", "/raw/job", "--job", "job-1"]);
  assert.equal(command.usesPromptPlaceholder, true);
});

test("runAgentPostprocess writes a prompt, runs the command, and preserves raw files", async () => {
  const fixture = createFixture();
  const calls: Array<{ command: string; args: string[]; stdin: string; cwd: string }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, stdin: options.stdin, cwd: options.cwd });
    const outputIndex = args.indexOf("--output");
    assert.notEqual(outputIndex, -1);
    fs.writeFileSync(path.join(String(args[outputIndex + 1]), "translated.md"), "번역 결과", "utf8");
    return { exitCode: 0, stdout: "done", stderr: "" };
  };

  const result = await runAgentPostprocess(inputFixture(fixture), runner);

  assert.equal(result.command, "codex");
  assert.equal(result.stdout, "done");
  assert.equal(fs.existsSync(result.promptPath), true);
  assert.equal(fs.existsSync(path.join(fixture.outputDir, "translated.md")), true);
  assert.equal(calls[0]?.stdin, "");
  assert.equal(calls[0]?.cwd.includes(".agent-work"), true);
  assert.equal(fs.readFileSync(path.join(fixture.rawRoot, "job-1", "source.md"), "utf8"), "source");
});

test("runAgentPostprocess stages prepared artifacts into the agent workspace", async () => {
  const fixture = createFixture();
  const extractedDir = path.join(fixture.root, "runtime", "extracted", "job-1", "preprocess");
  fs.mkdirSync(extractedDir, { recursive: true });
  const textPath = path.join(extractedDir, "vendor-template.txt");
  const structurePath = path.join(extractedDir, "vendor-template.blocks.json");
  fs.writeFileSync(textPath, "Source text outside the allowed agent root", "utf8");
  fs.writeFileSync(structurePath, JSON.stringify({
    schemaVersion: 1,
    blocks: [{ id: "b0001", text: "Source text outside the allowed agent root" }],
  }), "utf8");
  let prompt = "";
  const runner: CommandRunner = async (_command, args) => {
    const promptIndex = args.indexOf("--prompt");
    assert.notEqual(promptIndex, -1);
    prompt = fs.readFileSync(String(args[promptIndex + 1]), "utf8");
    fs.writeFileSync(path.join(fixture.outputDir, "translated.md"), "번역 결과", "utf8");
    fs.writeFileSync(path.join(fixture.outputDir, "translations.json"), JSON.stringify({
      schemaVersion: 1,
      blocks: [{ id: "b0001", text: "번역 결과" }],
    }), "utf8");
    return { exitCode: 0, stdout: "done", stderr: "" };
  };

  await runAgentPostprocess({
    ...inputFixture(fixture),
    artifacts: [{
      id: "artifact-docx",
      kind: "docx_text",
      fileName: "vendor-template.docx.txt",
      sourcePath: textPath,
      structurePath,
      charCount: 42,
      truncated: false,
    }],
  }, runner);

  assert.doesNotMatch(prompt, new RegExp(escapeRegExp(textPath)));
  assert.doesNotMatch(prompt, new RegExp(escapeRegExp(structurePath)));
  assert.match(prompt, /\.agent-work\/job-1\/artifacts\/001-artifact-docx\/vendor-template\.txt/);
  assert.match(prompt, /\.agent-work\/job-1\/artifacts\/001-artifact-docx\/vendor-template\.blocks\.json/);
  assert.equal(fs.readFileSync(path.join(fixture.outputDir, "..", ".agent-work", "job-1", "artifacts", "001-artifact-docx", "vendor-template.txt"), "utf8"), "Source text outside the allowed agent root");
});

test("runAgentPostprocess sends prompt on stdin when command has no prompt placeholder", async () => {
  const fixture = createFixture();
  let stdin = "";
  const runner: CommandRunner = async (_command, _args, options) => {
    stdin = options.stdin;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await runAgentPostprocess({ ...inputFixture(fixture), command: "custom-agent run" }, runner);

  assert.match(stdin, /Telegram Local Ingest Post-Processing/);
  assert.match(stdin, /Write generated deliverables only under:/);
});

test("runAgentPostprocess rejects raw bundle mutations", async () => {
  const fixture = createFixture();
  const runner: CommandRunner = async () => {
    fs.writeFileSync(path.join(fixture.rawRoot, "job-1", "source.md"), "mutated", "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(
    () => runAgentPostprocess(inputFixture(fixture), runner),
    (error) => error instanceof AgentAdapterError && /modified:job-1\/source\.md/.test(error.message),
  );
});

test("runAgentPostprocess ignores unrelated raw changes outside the current bundle scope", async () => {
  const fixture = createFixture();
  const runner: CommandRunner = async () => {
    fs.mkdirSync(path.join(fixture.rawRoot, "job-2"), { recursive: true });
    fs.writeFileSync(path.join(fixture.rawRoot, "job-2", "source.md"), "other job", "utf8");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };

  const result = await runAgentPostprocess(inputFixture(fixture), runner);

  assert.equal(result.stdout, "ok");
  assert.equal(fs.existsSync(path.join(fixture.rawRoot, "job-2", "source.md")), true);
});

function createFixture(): { root: string; rawRoot: string; bundlePath: string; outputDir: string; transcriptPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-adapter-"));
  const rawRoot = path.join(root, "vault", "raw");
  const bundlePath = path.join(rawRoot, "job-1");
  const outputDir = path.join(root, "runtime", "outputs", "job-1");
  fs.mkdirSync(path.join(bundlePath, "extracted"), { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "source.md"), "source", "utf8");
  const transcriptPath = path.join(bundlePath, "extracted", "meeting.transcript.md");
  fs.writeFileSync(transcriptPath, "회의 내용", "utf8");
  return { root, rawRoot, bundlePath, outputDir, transcriptPath };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inputFixture(fixture: ReturnType<typeof createFixture>) {
  return {
    command: "codex exec --prompt {promptFile} --output {outputDir}",
    jobId: "job-1",
    bundlePath: fixture.bundlePath,
    rawRoot: fixture.rawRoot,
    outputDir: fixture.outputDir,
    targetLanguage: "ko",
    defaultRelation: "business",
    language: {
      primaryLanguage: "en",
      confidence: 0.98,
      translationNeeded: true,
      targetLanguage: "ko",
    },
    artifacts: [{
      id: "artifact-1",
      kind: "transcript_markdown",
      fileName: "meeting.transcript.md",
      sourcePath: fixture.transcriptPath,
      charCount: 5,
      truncated: false,
    }],
    instructions: "Keep terms consistent.",
  };
}
