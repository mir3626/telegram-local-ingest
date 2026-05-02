import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWikiIngestCommand,
  loadWikiIngestContract,
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

test("loadWikiIngestContract resolves only manifest-declared bundle inputs", async () => {
  const fixture = createFixture();
  const contract = await loadWikiIngestContract(fixture.bundlePath);

  assert.equal(contract.version, "telegram-local-ingest.llmwiki.v1");
  assert.equal(contract.manifestPath, path.join(fixture.bundlePath, "manifest.yaml"));
  assert.equal(contract.sourceMarkdownPath, path.join(fixture.bundlePath, "source.md"));
  assert.equal(contract.inputs.length, 2);
  assert.equal(contract.defaultInputs.length, 1);
  assert.equal(contract.defaultInputs[0]?.id, "extracted:file-1:original_text");
  assert.equal(contract.defaultInputs[0]?.role, "canonical_text");
  assert.equal(contract.defaultInputs[0]?.absolutePath, path.join(fixture.bundlePath, "extracted", "lead.txt"));
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
    const wikiInputJson = args.at(args.indexOf("--wiki-input") + 1);
    assert.ok(wikiInputJson);
    const wikiInput = JSON.parse(wikiInputJson) as { id: string; role: string; path: string; readByDefault: boolean };
    assert.equal(wikiInput.id, "extracted:file-1:original_text");
    assert.equal(wikiInput.role, "canonical_text");
    assert.equal(wikiInput.readByDefault, true);
    assert.equal(wikiInput.path, "extracted/lead.txt");
    assert.equal(fs.readFileSync(path.join(fixture.bundlePath, wikiInput.path), "utf8"), "Lead source text");
    assert.ok(args.includes("--manifest"));
    assert.ok(args.includes(path.join(fixture.bundlePath, "manifest.yaml")));
    assert.ok(args.includes("--source"));
    assert.ok(args.includes(path.join(fixture.bundlePath, "source.md")));
    assert.ok(args.includes("--require-citations"));
    writeWikiIndexLog(fixture, "job-1");
    fs.writeFileSync(path.join(fixture.wikiRoot, "lead.md"), "updated wiki\n\nSource: extracted:file-1:original_text\n", "utf8");
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
  assert.match(fs.readFileSync(path.join(fixture.wikiRoot, "lead.md"), "utf8"), /Source: extracted:file-1:original_text/);
  assert.match(fs.readFileSync(path.join(fixture.wikiRoot, "index.md"), "utf8"), /job-1/);
  assert.match(fs.readFileSync(path.join(fixture.wikiRoot, "log.md"), "utf8"), /extracted:file-1:original_text/);
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
    writeWikiIndexLog(fixture, "job-1");
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

test("runWikiIngestAdapter requires index and log updates", async () => {
  const fixture = createFixture();

  await assert.rejects(
    () =>
      runWikiIngestAdapter({
        command: "codex exec",
        bundlePath: fixture.bundlePath,
        rawRoot: fixture.rawRoot,
        wikiRoot: fixture.wikiRoot,
        lockPath: fixture.lockPath,
        jobId: "job-1",
      }, async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    /index\.md, log\.md/,
  );
});

test("loadWikiIngestContract rejects rendered outputs as wiki source inputs", async () => {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.bundlePath, "manifest.yaml"), [
    "schema_version: 2",
    "wiki_inputs:",
    "  - id: \"bad\"",
    "    role: \"canonical_text\"",
    "    path: \"extracted/lead_translated.docx\"",
    "    name: \"lead_translated.docx\"",
    "    source_kind: \"extracted\"",
    "    read_by_default: true",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(() => loadWikiIngestContract(fixture.bundlePath), /Rendered output cannot be a wiki source input/);
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
  fs.mkdirSync(path.join(bundlePath, "extracted"), { recursive: true });
  fs.mkdirSync(wikiRoot, { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "source.md"), "immutable raw", "utf8");
  fs.writeFileSync(path.join(bundlePath, "extracted", "lead.txt"), "Lead source text", "utf8");
  fs.writeFileSync(path.join(bundlePath, "extracted", "lead.blocks.json"), "{\"blocks\":[]}\n", "utf8");
  fs.writeFileSync(path.join(bundlePath, "manifest.yaml"), [
    "schema_version: 2",
    "wiki_inputs:",
    "  - id: \"extracted:file-1:original_text\"",
    "    role: \"canonical_text\"",
    "    path: \"extracted/lead.txt\"",
    "    name: \"lead.txt\"",
    "    source_kind: \"extracted\"",
    "    read_by_default: true",
    "  - id: \"extracted:file-1:original_text:structure\"",
    "    role: \"structure\"",
    "    path: \"extracted/lead.blocks.json\"",
    "    name: \"lead.blocks.json\"",
    "    source_kind: \"extracted\"",
    "    read_by_default: false",
    "",
  ].join("\n"), "utf8");
  return {
    root,
    rawRoot,
    wikiRoot,
    bundlePath,
    lockPath: path.join(root, "runtime", "wiki.lock"),
  };
}

function writeWikiIndexLog(fixture: { wikiRoot: string }, jobId: string): void {
  fs.writeFileSync(path.join(fixture.wikiRoot, "index.md"), `# Wiki Index\n\n- ${jobId}\n`, "utf8");
  fs.writeFileSync(path.join(fixture.wikiRoot, "log.md"), [
    "# Wiki Log",
    "",
    `- ${jobId}: cited extracted:file-1:original_text`,
    "",
  ].join("\n"), "utf8");
}
