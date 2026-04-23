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
  assert.match(prompt, /official Anthropic `docx` skill/);
  assert.match(prompt, /Do not append the original\/source section yourself/);
  assert.match(prompt, /worker may append `\[원문\]` itself/);
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
