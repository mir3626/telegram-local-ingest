import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkFfmpeg,
  ensureRtzrSupportedAudio,
  isRtzrSupportedAudioPath,
  renderTranscriptMarkdown,
  RtzrOpenApiClient,
  RtzrTranscriptionFailedError,
  transcriptionText,
  writeTranscriptArtifacts,
  type CommandRunner,
  type FetchLike,
} from "@telegram-local-ingest/rtzr";

test("RtzrOpenApiClient authenticates, submits a file, and polls completed output", async () => {
  const fixture = createAudioFixture("sample.wav");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new RtzrOpenApiClient(
    { clientId: "client", clientSecret: "secret", apiBaseUrl: "https://openapi.vito.ai/" },
    mockFetch(calls, [
      { access_token: "token-1", expire_at: 9_999_999_999 },
      { id: "tr-1" },
      { id: "tr-1", status: "transcribing" },
      {
        id: "tr-1",
        status: "completed",
        results: {
          utterances: [
            { start_at: 1000, duration: 500, msg: "hello", spk: 0, lang: "en" },
            { start_at: 2000, duration: 500, msg: "world", spk: 1, lang: "en" },
          ],
        },
      },
    ]),
  );

  const transcript = await client.transcribeFile(
    fixture.audioPath,
    { language: "ko", use_diarization: true },
    { pollIntervalMs: 1, timeoutMs: 1000, sleep: async () => undefined },
  );

  assert.equal(transcript.id, "tr-1");
  assert.equal(transcript.text, "hello\nworld");
  assert.equal(calls[0]?.url, "https://openapi.vito.ai/v1/authenticate");
  assert.equal(calls[1]?.url, "https://openapi.vito.ai/v1/transcribe");
  assert.equal(calls[1]?.init?.headers && (calls[1].init.headers as Record<string, string>).authorization, "Bearer token-1");
  assert.equal(calls[2]?.url, "https://openapi.vito.ai/v1/transcribe/tr-1");
});

test("RtzrOpenApiClient backs off on 429 while polling", async () => {
  const sleeps: number[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new RtzrOpenApiClient(
    { clientId: "client", clientSecret: "secret", apiBaseUrl: "https://openapi.vito.ai" },
    mockFetch(calls, [
      { access_token: "token-1", expire_at: 9_999_999_999 },
      { code: "A0003", msg: "rate limited", status: 429 },
      { id: "tr-2", status: "completed", results: { utterances: [{ start_at: 0, duration: 1, msg: "done" }] } },
    ]),
  );

  const result = await client.waitForTranscription("tr-2", {
    pollIntervalMs: 10,
    rateLimitBackoffMs: 50,
    timeoutMs: 1000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(sleeps, [50]);
});

test("RtzrOpenApiClient surfaces failed transcription status", async () => {
  const client = new RtzrOpenApiClient(
    { clientId: "client", clientSecret: "secret", apiBaseUrl: "https://openapi.vito.ai" },
    mockFetch([], [
      { access_token: "token-1", expire_at: 9_999_999_999 },
      { id: "tr-3", status: "failed", error: { code: "E500", message: "internal server error" } },
    ]),
  );

  await assert.rejects(
    () => client.waitForTranscription("tr-3", { pollIntervalMs: 1, timeoutMs: 1000, sleep: async () => undefined }),
    RtzrTranscriptionFailedError,
  );
});

test("writeTranscriptArtifacts persists RTZR JSON and transcript markdown", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtzr-artifacts-"));
  const transcript = {
    id: "tr-4",
    text: "hello",
    raw: {
      id: "tr-4",
      status: "completed" as const,
      results: { utterances: [{ start_at: 4737, duration: 2360, msg: "Hello.", spk: 0, lang: "en" }] },
    },
  };

  const paths = await writeTranscriptArtifacts(transcript, outputDir);

  assert.match(fs.readFileSync(paths.rtzrJsonPath, "utf8"), /"status": "completed"/);
  assert.match(fs.readFileSync(paths.transcriptMarkdownPath, "utf8"), /\[00:04.737\] Speaker 0: Hello\./);
  assert.equal(transcriptionText(transcript.raw), "Hello.");
  assert.match(renderTranscriptMarkdown(transcript), /# Transcript tr-4/);
});

test("ffmpeg helpers check availability and convert unsupported input", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, stdout: "ffmpeg version n", stderr: "" };
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtzr-ffmpeg-"));
  const voicePath = path.join(root, "voice.ogg");
  fs.writeFileSync(voicePath, "not real audio", "utf8");

  await checkFfmpeg("ffmpeg", runner);
  assert.equal(isRtzrSupportedAudioPath("sample.mp3"), true);
  assert.equal(isRtzrSupportedAudioPath("voice.ogg"), false);

  const converted = await ensureRtzrSupportedAudio({
    inputPath: voicePath,
    outputDir: path.join(root, "normalized"),
    ffmpegPath: "ffmpeg",
    runner,
  });

  assert.equal(converted.converted, true);
  assert.equal(converted.audioPath, path.join(root, "normalized", "voice.wav"));
  assert.deepEqual(calls[1]?.args, ["-y", "-i", voicePath, "-ar", "16000", "-ac", "1", converted.audioPath]);
});

function createAudioFixture(name: string): { audioPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rtzr-audio-"));
  const audioPath = path.join(root, name);
  fs.writeFileSync(audioPath, "fake audio", "utf8");
  return { audioPath };
}

function mockFetch(calls: Array<{ url: string; init?: RequestInit }>, responses: unknown[]): FetchLike {
  return async (input, init) => {
    calls.push(init === undefined ? { url: input } : { url: input, init });
    const next = responses.shift();
    assert.ok(next, `missing mock response for ${input}`);
    const status = isRecord(next) && typeof next.status === "number" ? next.status : 200;
    const body = isRecord(next) && typeof next.status === "number" ? stripStatus(next) : next;
    return jsonResponse(body, status);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripStatus(value: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...rest } = value;
  return rest;
}
