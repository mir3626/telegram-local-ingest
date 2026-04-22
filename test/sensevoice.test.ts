import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalSenseVoiceClient,
  writeSenseVoiceTranscriptArtifacts,
  type CommandRunner,
} from "@telegram-local-ingest/sensevoice";

test("LocalSenseVoiceClient runs the Python helper and parses output JSON", async () => {
  const calls: Array<{ command: string; args: string[]; timeoutMs: number; env: NodeJS.ProcessEnv | undefined }> = [];
  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs, env: options.env });
    options.onStderr?.(`${JSON.stringify({
      type: "sensevoice_progress",
      percent: 50,
      stage: "TRANSCRIBE",
      message: "Running SenseVoice transcription",
    })}\n`);
    const outputIndex = args.indexOf("--output");
    assert.notEqual(outputIndex, -1);
    const outputPath = args[outputIndex + 1];
    assert.equal(typeof outputPath, "string");
    fs.writeFileSync(
      outputPath as string,
      `${JSON.stringify({
        id: "sensevoice-call",
        text: "중구난방",
        segments: [{ text: "중구난방", language: "ko" }],
      })}\n`,
      "utf8",
    );
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const client = new LocalSenseVoiceClient(runner);
  const progress: string[] = [];

  const transcript = await client.transcribeFile("/tmp/call.wav", {
    pythonPath: "/project/.venv-sensevoice/bin/python",
    scriptPath: "/project/scripts/sensevoice-transcribe.py",
    model: "iic/SenseVoiceSmall",
    vadModel: "fsmn-vad",
    device: "cpu",
    language: "auto",
    useItn: true,
    batchSizeSeconds: 60,
    mergeVad: true,
    mergeLengthSeconds: 15,
    maxSingleSegmentTimeMs: 30_000,
    timeoutMs: 3_600_000,
    torchNumThreads: 4,
  }, (event) => {
    progress.push(`${event.percent}:${event.stage}:${event.message}`);
  });

  assert.equal(transcript.text, "중구난방");
  assert.equal(transcript.segments[0]?.language, "ko");
  assert.equal(calls[0]?.command, "/project/.venv-sensevoice/bin/python");
  assert.equal(calls[0]?.args[0], "/project/scripts/sensevoice-transcribe.py");
  assert.equal(calls[0]?.timeoutMs, 3_600_000);
  assert.equal(calls[0]?.env?.TORCH_NUM_THREADS, "4");
  assert.ok(progress.includes("50:TRANSCRIBE:Running SenseVoice transcription"));
  assert.ok(progress.includes("100:DONE:SenseVoice transcript JSON parsed"));
});

test("writeSenseVoiceTranscriptArtifacts persists JSON and transcript markdown", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensevoice-artifacts-"));

  const artifacts = await writeSenseVoiceTranscriptArtifacts(
    {
      id: "sensevoice-call",
      text: "중구난방",
      segments: [{ text: "중구난방", language: "ko" }],
      raw: {
        id: "sensevoice-call",
        text: "중구난방",
      },
    },
    outputDir,
  );

  assert.match(fs.readFileSync(artifacts.senseVoiceJsonPath, "utf8"), /"sensevoice-call"/);
  assert.match(fs.readFileSync(artifacts.transcriptMarkdownPath, "utf8"), /중구난방/);
});
