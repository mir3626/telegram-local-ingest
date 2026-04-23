import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWikiIngestCommand,
  parseCommandLine,
  runWikiIngestAdapter,
  WikiAdapterError,
  withWikiWriteLock,
  type CommandRunner,
} from "@telegram-local-ingest/wiki-adapter";

test("parseCommandLine handles quoted command arguments", () => {
  assert.deepEqual(parseCommandLine('codex exec --profile "wiki ingest"'), ["codex", "exec", "--profile", "wiki ingest"]);
  assert.throws(() => parseCommandLine('codex "unterminated'), WikiAdapterError);
});

test("buildWikiIngestCommand appends the narrow adapter contract", () => {
  const fixture = createFixture();
  const command = buildWikiIngestCommand({
    command: "codex exec",
    bundlePath: fixture.bundlePath,
    rawRoot: fixture.rawRoot,
    wikiRoot: fixture.wikiRoot,
    lockPath: fixture.lockPath,
    jobId: "job-1",
    project: "sales",
    tags: ["lead", "korea"],
    instructions: "update wiki only",
  });

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args.slice(0, 3), ["exec", "--bundle", fixture.bundlePath]);
  assert.ok(command.args.includes("--wiki-root"));
  assert.ok(command.args.includes(fixture.wikiRoot));
  assert.ok(command.args.includes("--raw-root"));
  assert.ok(command.args.includes(fixture.rawRoot));
  assert.ok(command.args.includes("--tag"));
  assert.ok(command.args.includes("lead"));
});

test("withWikiWriteLock rejects concurrent lock holders and cleans up", async () => {
  const fixture = createFixture();
  await withWikiWriteLock(fixture.lockPath, async () => {
    await assert.rejects(() => withWikiWriteLock(fixture.lockPath, async () => undefined), WikiAdapterError);
  });
  assert.equal(fs.existsSync(fixture.lockPath), false);
});

test("runWikiIngestAdapter allows wiki writes and captures output", async () => {
  const fixture = createFixture();
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    fs.writeFileSync(path.join(fixture.wikiRoot, "lead.md"), "updated wiki", "utf8");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };

  const result = await runWikiIngestAdapter({
    command: "codex exec",
    bundlePath: fixture.bundlePath,
    rawRoot: fixture.rawRoot,
    wikiRoot: fixture.wikiRoot,
    lockPath: fixture.lockPath,
    jobId: "job-1",
  }, runner);

  assert.equal(result.stdout, "ok");
  assert.equal(calls[0]?.command, "codex");
  assert.equal(fs.readFileSync(path.join(fixture.wikiRoot, "lead.md"), "utf8"), "updated wiki");
});

test("runWikiIngestAdapter rejects raw bundle mutations", async () => {
  const fixture = createFixture();
  const runner: CommandRunner = async () => {
    fs.writeFileSync(path.join(fixture.bundlePath, "source.md"), "mutated", "utf8");
    return { exitCode: 0, stdout: "bad", stderr: "" };
  };

  await assert.rejects(
    () =>
      runWikiIngestAdapter({
        command: "codex exec",
        bundlePath: fixture.bundlePath,
        rawRoot: fixture.rawRoot,
        wikiRoot: fixture.wikiRoot,
        lockPath: fixture.lockPath,
        jobId: "job-1",
      }, runner),
    /modified:2026-04-22\/job-1\/source\.md/,
  );
});

test("runWikiIngestAdapter ignores unrelated raw changes outside the current bundle scope", async () => {
  const fixture = createFixture();
  const runner: CommandRunner = async () => {
    const siblingBundle = path.join(fixture.rawRoot, "2026-04-22", "job-2");
    fs.mkdirSync(siblingBundle, { recursive: true });
    fs.writeFileSync(path.join(siblingBundle, "source.md"), "other raw", "utf8");
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };

  const result = await runWikiIngestAdapter({
    command: "codex exec",
    bundlePath: fixture.bundlePath,
    rawRoot: fixture.rawRoot,
    wikiRoot: fixture.wikiRoot,
    lockPath: fixture.lockPath,
    jobId: "job-1",
  }, runner);

  assert.equal(result.stdout, "ok");
});

test("runWikiIngestAdapter rejects overlapping raw and wiki roots", async () => {
  const fixture = createFixture();
  await assert.rejects(
    () =>
      runWikiIngestAdapter({
        command: "codex exec",
        bundlePath: fixture.bundlePath,
        rawRoot: fixture.rawRoot,
        wikiRoot: fixture.rawRoot,
        lockPath: fixture.lockPath,
        jobId: "job-1",
      }, async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    WikiAdapterError,
  );
});

function createFixture(): { root: string; rawRoot: string; wikiRoot: string; bundlePath: string; lockPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-adapter-"));
  const rawRoot = path.join(root, "raw");
  const wikiRoot = path.join(root, "wiki");
  const bundlePath = path.join(rawRoot, "2026-04-22", "job-1");
  fs.mkdirSync(bundlePath, { recursive: true });
  fs.mkdirSync(wikiRoot, { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "source.md"), "immutable raw", "utf8");
  return {
    root,
    rawRoot,
    wikiRoot,
    bundlePath,
    lockPath: path.join(root, "runtime", "wiki.lock"),
  };
}
