import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildAutomationRunId,
  discoverAutomationModules,
  runAutomationModule,
} from "@telegram-local-ingest/automation-core";
import {
  createJob,
  createJobOutput,
  createSourceBundle,
  getAutomationScheduleState,
  listAutomationModules,
  listAutomationRuns,
  listJobOutputs,
  listVaultTombstones,
  migrate,
  openIngestDatabase,
  setAutomationModuleEnabled,
  upsertAutomationModule,
} from "@telegram-local-ingest/db";

const repoRoot = path.resolve(".");

test("automation manifests are discovered and synced into SQLite without package scripts", async () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.echo",
    title: "Demo Echo",
    defaultEnabled: false,
  });
  const dbHandle = openIngestDatabase(fixture.dbPath);
  try {
    migrate(dbHandle.db);
    const modules = await discoverAutomationModules(fixture.modulesRoot);
    assert.equal(modules.length, 1);
    assert.equal(modules[0]?.manifest.id, "demo.echo");
    assert.equal(modules[0]?.manifest.schedule.type, "manual");

    for (const module of modules) {
      upsertAutomationModule(dbHandle.db, {
        id: module.manifest.id,
        manifest: module.manifest,
        enabled: module.manifest.defaultEnabled,
      });
    }

    assert.deepEqual(listAutomationModules(dbHandle.db).map((module) => [module.id, module.enabled]), [
      ["demo.echo", false],
    ]);
    assert.equal(setAutomationModuleEnabled(dbHandle.db, "demo.echo", true).enabled, true);
  } finally {
    dbHandle.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runAutomationModule writes durable stdout stderr and result files", async () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.echo",
    title: "Demo Echo",
    defaultEnabled: true,
  });
  try {
    const [module] = await discoverAutomationModules(fixture.modulesRoot);
    assert.ok(module);
    const runId = buildAutomationRunId(module.manifest.id, new Date("2026-04-27T00:00:00.000Z"));
    const result = await runAutomationModule({
      module,
      projectRoot: repoRoot,
      runtimeDir: fixture.runtimeDir,
      sqliteDbPath: fixture.dbPath,
      runId,
      runDir: path.join(fixture.runtimeDir, "automation", "runs", runId),
      trigger: "manual",
      env: process.env,
    });

    assert.equal(result.exitCode, 0);
    assert.match(fs.readFileSync(result.stdoutPath, "utf8"), /module=demo.echo/);
    assert.equal(fs.readFileSync(result.stderrPath, "utf8"), "");
    const resultJson = JSON.parse(fs.readFileSync(result.resultPath, "utf8")) as {
      status?: string;
      moduleResult?: { artifact?: string };
    };
    assert.equal(resultJson.status, "succeeded");
    assert.deepEqual(resultJson.moduleResult, { artifact: "demo" });
    assert.notEqual(
      buildAutomationRunId(module.manifest.id, new Date("2026-04-27T00:00:00.000Z")),
      buildAutomationRunId(module.manifest.id, new Date("2026-04-27T00:00:00.001Z")),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runAutomationModule fails readiness without exposing secret values", async () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.secret",
    title: "Demo Secret",
    defaultEnabled: true,
    requiredEnv: ["DEMO_SECRET_TOKEN"],
  });
  try {
    const [module] = await discoverAutomationModules(fixture.modulesRoot);
    assert.ok(module);
    const runId = buildAutomationRunId(module.manifest.id, new Date("2026-04-27T00:00:00.000Z"));
    const result = await runAutomationModule({
      module,
      projectRoot: repoRoot,
      runtimeDir: fixture.runtimeDir,
      sqliteDbPath: fixture.dbPath,
      runId,
      runDir: path.join(fixture.runtimeDir, "automation", "runs", runId),
      trigger: "manual",
      env: {},
    });

    assert.equal(result.exitCode, 1);
    const stderr = fs.readFileSync(result.stderrPath, "utf8");
    assert.match(stderr, /DEMO_SECRET_TOKEN/);
    assert.doesNotMatch(stderr, /secret-value/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI lists enables runs and shows automation logs", () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.echo",
    title: "Demo Echo",
    defaultEnabled: false,
  });
  try {
    const baseEnv = {
      ...process.env,
      AUTOMATION_MODULES_DIR: fixture.modulesRoot,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
    };

    const listResult = runCli(["automation", "list"], baseEnv);
    assert.equal(listResult.status, 0);
    assert.match(listResult.stdout, /off demo\.echo ready Demo Echo/);

    const disabledRun = runCli(["automation", "run", "demo.echo"], baseEnv);
    assert.notEqual(disabledRun.status, 0);
    assert.match(disabledRun.stderr, /disabled/);

    const enableResult = runCli(["automation", "enable", "demo.echo"], baseEnv);
    assert.equal(enableResult.status, 0);
    assert.match(enableResult.stdout, /enabled demo\.echo/);

    const runResult = runCli(["automation", "run", "demo.echo"], baseEnv);
    assert.equal(runResult.status, 0, runResult.stderr);
    assert.match(runResult.stdout, /succeeded demo_echo_/);

    const dbHandle = openIngestDatabase(fixture.dbPath);
    try {
      migrate(dbHandle.db);
      assert.equal(listAutomationRuns(dbHandle.db, { moduleId: "demo.echo" }).length, 1);
    } finally {
      dbHandle.close();
    }

    const logsResult = runCli(["automation", "logs", "demo.echo"], baseEnv);
    assert.equal(logsResult.status, 0);
    assert.match(logsResult.stdout, /succeeded demo_echo_/);

    fs.rmSync(path.join(fixture.modulesRoot, "demo-echo"), { recursive: true, force: true });
    const missingListResult = runCli(["automation", "list"], baseEnv);
    assert.equal(missingListResult.status, 0);
    assert.match(missingListResult.stdout, /missing demo\.echo ready Demo Echo/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI dispatches due scheduled modules idempotently", () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "daily.fx",
    title: "Daily FX",
    defaultEnabled: true,
    schedule: { type: "daily", time: "00:00", timezone: "UTC", catchUp: "none" },
  });
  try {
    const baseEnv = {
      ...process.env,
      AUTOMATION_MODULES_DIR: fixture.modulesRoot,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
    };

    const dispatchResult = runCli(["automation", "dispatch", "--now", "2026-04-27T00:30:00.000Z"], baseEnv);
    assert.equal(dispatchResult.status, 0, dispatchResult.stderr);
    assert.match(dispatchResult.stdout, /succeeded daily_fx_/);
    assert.match(dispatchResult.stdout, /daily\.fx daily:2026-04-27/);

    const secondDispatch = runCli(["automation", "dispatch", "--now", "2026-04-27T00:45:00.000Z"], baseEnv);
    assert.equal(secondDispatch.status, 0, secondDispatch.stderr);
    assert.match(secondDispatch.stdout, /No automation modules due/);

    const dbHandle = openIngestDatabase(fixture.dbPath);
    try {
      migrate(dbHandle.db);
      const runs = listAutomationRuns(dbHandle.db, { moduleId: "daily.fx" });
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.idempotencyKey, "daily:2026-04-27");
      const state = getAutomationScheduleState(dbHandle.db, "daily.fx");
      assert.equal(state?.lastDueKey, "daily:2026-04-27");
      assert.equal(state?.nextDueAt, "2026-04-28T00:00:00.000Z");
    } finally {
      dbHandle.close();
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI installs and removes the user systemd automation timer files", () => {
  const fixture = createFixture();
  try {
    const configHome = path.join(fixture.root, "config");
    const baseEnv = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      AUTOMATION_MODULES_DIR: fixture.modulesRoot,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
    };

    const install = runCli(["automation", "timer", "install", "--interval-minutes", "7"], baseEnv);
    assert.equal(install.status, 0, install.stderr);
    const servicePath = path.join(configHome, "systemd", "user", "telegram-local-ingest-automation.service");
    const timerPath = path.join(configHome, "systemd", "user", "telegram-local-ingest-automation.timer");
    assert.match(fs.readFileSync(servicePath, "utf8"), /automation dispatch/);
    assert.match(fs.readFileSync(timerPath, "utf8"), /OnCalendar=\*:0\/7/);

    const status = runCli(["automation", "timer", "status"], baseEnv);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /service=installed/);
    assert.match(status.stdout, /timer=installed/);

    const uninstall = runCli(["automation", "timer", "uninstall"], baseEnv);
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(fs.existsSync(servicePath), false);
    assert.equal(fs.existsSync(timerPath), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI vault reconcile reports SQLite/filesystem drift", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  fs.mkdirSync(path.join(vaultPath, "raw", "2026-04-22", "orphan-bundle"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "raw", "2026-04-22", "orphan-bundle", ".finalized"), "done\n", "utf8");
  const dbHandle = openIngestDatabase(fixture.dbPath);
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-drift", source: "telegram-local-bot-api", now: "2026-04-22T00:00:00.000Z" });
    createSourceBundle(dbHandle.db, {
      id: "missing-bundle",
      jobId: "job-drift",
      bundlePath: path.join(vaultPath, "raw", "2026-04-22", "missing-bundle"),
      manifestPath: path.join(vaultPath, "raw", "2026-04-22", "missing-bundle", "manifest.yaml"),
      sourceMarkdownPath: path.join(vaultPath, "raw", "2026-04-22", "missing-bundle", "source.md"),
      now: "2026-04-22T00:00:00.000Z",
    });
  } finally {
    dbHandle.close();
  }

  try {
    const result = runCli(["vault", "reconcile", "--json"], {
      ...process.env,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      summary: { error: number; warn: number };
      issues: Array<{ code: string; targetId: string }>;
    };
    assert.ok(report.summary.error > 0);
    assert.ok(report.summary.warn > 0);
    assert.ok(report.issues.some((issue) => issue.code === "missing_path" && issue.targetId === "missing-bundle"));
    assert.ok(report.issues.some((issue) => issue.code === "orphan_raw_bundle" && issue.targetId === "orphan-bundle"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI vault delete removes related files and records tombstones only with apply", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const bundlePath = path.join(vaultPath, "raw", "2026-04-22", "bundle-delete");
  const wikiSourcePath = path.join(vaultPath, "wiki", "sources", "bundle-delete.md");
  const outputPath = path.join(fixture.runtimeDir, "outputs", "bundle-delete", "translated.md");
  fs.mkdirSync(bundlePath, { recursive: true });
  fs.mkdirSync(path.dirname(wikiSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "manifest.yaml"), "id: bundle-delete\n", "utf8");
  fs.writeFileSync(path.join(bundlePath, "source.md"), "# Source\n", "utf8");
  fs.writeFileSync(path.join(bundlePath, ".finalized"), "done\n", "utf8");
  fs.writeFileSync(wikiSourcePath, "# Wiki source\n", "utf8");
  fs.writeFileSync(outputPath, "# Translation\n", "utf8");

  const dbHandle = openIngestDatabase(fixture.dbPath);
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-delete", source: "telegram-local-bot-api", now: "2026-04-22T00:00:00.000Z" });
    createSourceBundle(dbHandle.db, {
      id: "bundle-delete",
      jobId: "job-delete",
      bundlePath,
      manifestPath: path.join(bundlePath, "manifest.yaml"),
      sourceMarkdownPath: path.join(bundlePath, "source.md"),
      now: "2026-04-22T00:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "output-delete",
      jobId: "job-delete",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      createdAt: "2026-04-22T00:00:00.000Z",
      expiresAt: "2026-04-23T00:00:00.000Z",
    });
  } finally {
    dbHandle.close();
  }

  try {
    const env = {
      ...process.env,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
    };
    const dryRun = runCli(["vault", "delete", "job-delete"], env);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /dry-run managed delete source_bundle bundle-delete/);
    assert.equal(fs.existsSync(bundlePath), true);
    assert.equal(fs.existsSync(wikiSourcePath), true);
    assert.equal(fs.existsSync(outputPath), true);

    const apply = runCli(["vault", "delete", "job-delete", "--apply", "--reason", "test cleanup"], env);
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /applied managed delete source_bundle bundle-delete/);
    assert.equal(fs.existsSync(bundlePath), false);
    assert.equal(fs.existsSync(wikiSourcePath), false);
    assert.equal(fs.existsSync(outputPath), false);

    const verify = openIngestDatabase(fixture.dbPath);
    try {
      migrate(verify.db);
      assert.equal(listJobOutputs(verify.db, "job-delete")[0]?.deletedAt !== undefined, true);
      const tombstones = listVaultTombstones(verify.db);
      assert.equal(tombstones.length, 1);
      assert.equal(tombstones[0]?.targetId, "bundle-delete");
      assert.equal(tombstones[0]?.reason, "test cleanup");
    } finally {
      verify.close();
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops CLI vault trash applies manual Obsidian moves and can restore tombstones", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const bundlePath = path.join(vaultPath, "raw", "2026-04-22", "bundle-trash");
  const wikiSourcePath = path.join(vaultPath, "wiki", "sources", "bundle-trash.md");
  const trashWikiSourcePath = path.join(vaultPath, "_trash", "wiki", "sources", "bundle-trash.md");
  const trashBundlePath = path.join(vaultPath, "_trash", "raw", "2026-04-22", "bundle-trash");
  const outputPath = path.join(fixture.runtimeDir, "outputs", "bundle-trash", "translated.md");
  fs.mkdirSync(bundlePath, { recursive: true });
  fs.mkdirSync(path.dirname(wikiSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(trashWikiSourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(path.join(bundlePath, "manifest.yaml"), "id: bundle-trash\n", "utf8");
  fs.writeFileSync(path.join(bundlePath, "source.md"), "# Source\n", "utf8");
  fs.writeFileSync(path.join(bundlePath, ".finalized"), "done\n", "utf8");
  fs.writeFileSync(wikiSourcePath, "# Wiki source\n", "utf8");
  fs.writeFileSync(outputPath, "# Translation\n", "utf8");

  const dbHandle = openIngestDatabase(fixture.dbPath);
  try {
    migrate(dbHandle.db);
    createJob(dbHandle.db, { id: "job-trash", source: "telegram-local-bot-api", now: "2026-04-22T00:00:00.000Z" });
    createSourceBundle(dbHandle.db, {
      id: "bundle-trash",
      jobId: "job-trash",
      bundlePath,
      manifestPath: path.join(bundlePath, "manifest.yaml"),
      sourceMarkdownPath: path.join(bundlePath, "source.md"),
      now: "2026-04-22T00:00:00.000Z",
    });
    createJobOutput(dbHandle.db, {
      id: "output-trash",
      jobId: "job-trash",
      kind: "agent_translation",
      filePath: outputPath,
      fileName: "translated.md",
      createdAt: "2026-04-22T00:00:00.000Z",
      expiresAt: "2026-04-23T00:00:00.000Z",
    });
  } finally {
    dbHandle.close();
  }

  try {
    fs.renameSync(wikiSourcePath, trashWikiSourcePath);
    const env = {
      ...process.env,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
    };

    const pending = runCli(["vault", "reconcile", "--json"], env);
    assert.equal(pending.status, 0, pending.stderr);
    const pendingReport = JSON.parse(pending.stdout) as {
      issues: Array<{ code: string; targetId: string; trashPath?: string }>;
    };
    assert.ok(pendingReport.issues.some((issue) => issue.code === "trash_pending" && issue.targetId === "bundle-trash" && issue.trashPath === trashWikiSourcePath));

    const apply = runCli(["vault", "trash-apply", "--apply", "--reason", "manual obsidian trash"], env);
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /applied vault trash-apply plans=1/);
    assert.equal(fs.existsSync(bundlePath), false);
    assert.equal(fs.existsSync(trashBundlePath), true);
    assert.equal(fs.existsSync(wikiSourcePath), false);
    assert.equal(fs.existsSync(trashWikiSourcePath), true);
    assert.equal(fs.existsSync(outputPath), false);

    const verify = openIngestDatabase(fixture.dbPath);
    let tombstoneId = "";
    try {
      migrate(verify.db);
      assert.equal(listJobOutputs(verify.db, "job-trash")[0]?.deletedAt !== undefined, true);
      const tombstones = listVaultTombstones(verify.db);
      assert.equal(tombstones.length, 1);
      assert.equal(tombstones[0]?.targetId, "bundle-trash");
      tombstoneId = tombstones[0]?.id ?? "";
      assert.ok(tombstones[0]?.paths.includes(trashWikiSourcePath));
    } finally {
      verify.close();
    }

    const reconciled = runCli(["vault", "reconcile", "--json"], env);
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const reconciledReport = JSON.parse(reconciled.stdout) as {
      issues: Array<{ code: string; targetId: string }>;
    };
    assert.equal(reconciledReport.issues.some((issue) => issue.code === "trash_pending"), false);

    const restore = runCli(["vault", "restore", tombstoneId, "--apply"], env);
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(fs.existsSync(bundlePath), true);
    assert.equal(fs.existsSync(wikiSourcePath), true);
    assert.equal(fs.existsSync(trashBundlePath), false);
    assert.equal(fs.existsSync(trashWikiSourcePath), false);
    const restoredDb = openIngestDatabase(fixture.dbPath);
    try {
      migrate(restoredDb.db);
      assert.equal(listVaultTombstones(restoredDb.db).length, 0);
    } finally {
      restoredDb.close();
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fx Korea Eximbank automation writes canonical raw bundle artifacts from a fixture", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const apiFixturePath = path.join(fixture.root, "koreaexim.json");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(apiFixturePath, `${JSON.stringify([
    {
      result: 1,
      cur_unit: "USD",
      cur_nm: "미국 달러",
      ttb: "1,380.12",
      tts: "1,407.33",
      deal_bas_r: "1,393.72",
      bkpr: "1,393",
      kftc_deal_bas_r: "1,393.72",
    },
    {
      result: 1,
      cur_unit: "JPY(100)",
      cur_nm: "일본 옌",
      ttb: "930.01",
      tts: "948.41",
      deal_bas_r: "939.21",
      bkpr: "939",
      kftc_deal_bas_r: "939.21",
    },
  ], null, 2)}\n`, "utf8");
  try {
    const env = {
      ...process.env,
      AUTOMATION_MODULES_DIR: path.join(repoRoot, "automations"),
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
      FX_KOREAEXIM_AUTHKEY: "dummy",
      FX_KOREAEXIM_FIXTURE_PATH: apiFixturePath,
      FX_SEARCH_DATE: "20260425",
      FX_CURRENCIES: "USD,JPY(100)",
      WIKI_INGEST_COMMAND: "",
    };

    const run = runCli(["automation", "run", "fx.koreaexim.daily", "--force"], env);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /succeeded fx_koreaexim_daily_/);
    const bundlePath = path.join(vaultPath, "raw", "2026-04-25", "fx_koreaexim_20260425");
    assert.equal(fs.existsSync(path.join(bundlePath, ".finalized")), true);
    assert.match(fs.readFileSync(path.join(bundlePath, "extracted", "rates-20260425.md"), "utf8"), /미국 달러/);
    assert.match(fs.readFileSync(path.join(bundlePath, "extracted", "rates-20260425.csv"), "utf8"), /JPY\(100\)/);
    assert.match(fs.readFileSync(path.join(bundlePath, "manifest.yaml"), "utf8"), /wiki_inputs:/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fx Korea Eximbank automation reports API RESULT errors", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const apiFixturePath = path.join(fixture.root, "koreaexim-error.json");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(apiFixturePath, `${JSON.stringify([{ result: 3 }], null, 2)}\n`, "utf8");
  try {
    const env = {
      ...process.env,
      AUTOMATION_MODULES_DIR: path.join(repoRoot, "automations"),
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
      FX_KOREAEXIM_AUTHKEY: "dummy",
      FX_KOREAEXIM_FIXTURE_PATH: apiFixturePath,
      FX_SEARCH_DATE: "20260425",
      WIKI_INGEST_COMMAND: "",
    };

    const run = runCli(["automation", "run", "fx.koreaexim.daily", "--force"], env);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /failed fx_koreaexim_daily_/);
    const resultPath = run.stdout.match(/^result=(.+)$/m)?.[1];
    assert.ok(resultPath);
    assert.match(fs.readFileSync(resultPath, "utf8"), /RESULT=3/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fx Korea Eximbank automation fails loudly when response schema shifts", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const apiFixturePath = path.join(fixture.root, "koreaexim-schema-shift.json");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(apiFixturePath, `${JSON.stringify([{ result: 1, currency: "USD", deal: "1,473.1" }], null, 2)}\n`, "utf8");
  try {
    const env = {
      ...process.env,
      AUTOMATION_MODULES_DIR: path.join(repoRoot, "automations"),
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
      FX_KOREAEXIM_AUTHKEY: "dummy",
      FX_KOREAEXIM_FIXTURE_PATH: apiFixturePath,
      FX_SEARCH_DATE: "20260425",
      WIKI_INGEST_COMMAND: "",
    };

    const run = runCli(["automation", "run", "fx.koreaexim.daily", "--force"], env);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /failed fx_koreaexim_daily_/);
    const resultPath = run.stdout.match(/^result=(.+)$/m)?.[1];
    assert.ok(resultPath);
    assert.match(fs.readFileSync(resultPath, "utf8"), /response schema may have changed/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fx Korea Eximbank automation can skip empty source days without writing a bundle", () => {
  const fixture = createFixture();
  const vaultPath = path.join(fixture.root, "vault");
  const apiFixturePath = path.join(fixture.root, "koreaexim-empty.json");
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(apiFixturePath, "[]\n", "utf8");
  try {
    const env = {
      ...process.env,
      AUTOMATION_MODULES_DIR: path.join(repoRoot, "automations"),
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OBSIDIAN_VAULT_PATH: vaultPath,
      FX_KOREAEXIM_AUTHKEY: "dummy",
      FX_KOREAEXIM_FIXTURE_PATH: apiFixturePath,
      FX_SEARCH_DATE: "20260426",
      FX_SKIP_EMPTY_BUNDLE: "1",
      WIKI_INGEST_COMMAND: "",
    };

    const run = runCli(["automation", "run", "fx.koreaexim.daily", "--force"], env);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /succeeded fx_koreaexim_daily_/);
    const resultPath = run.stdout.match(/^result=(.+)$/m)?.[1];
    assert.ok(resultPath);
    assert.match(fs.readFileSync(resultPath, "utf8"), /no_source_rows/);
    assert.equal(fs.existsSync(path.join(vaultPath, "raw", "2026-04-26", "fx_koreaexim_20260426")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(repoRoot, "apps/ops-cli/src/index.ts"), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

function createFixture(): { root: string; modulesRoot: string; runtimeDir: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automation-core-"));
  const modulesRoot = path.join(root, "automations");
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(modulesRoot, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  return {
    root,
    modulesRoot,
    runtimeDir,
    dbPath: path.join(runtimeDir, "ingest.db"),
  };
}

function writeAutomationModule(
  modulesRoot: string,
  manifest: {
    id: string;
    title: string;
    defaultEnabled: boolean;
    requiredEnv?: string[];
    schedule?: unknown;
  },
): void {
  const moduleDir = path.join(modulesRoot, manifest.id.replace(/\./g, "-"));
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "manifest.json"), `${JSON.stringify({
    id: manifest.id,
    title: manifest.title,
    entry: "run.mjs",
    defaultEnabled: manifest.defaultEnabled,
    ...(manifest.requiredEnv ? { requiredEnv: manifest.requiredEnv } : {}),
    ...(manifest.schedule ? { schedule: manifest.schedule } : {}),
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(moduleDir, "run.mjs"), [
    "process.stdout.write(`module=${process.env.AUTOMATION_MODULE_ID}\\n`);",
    "process.stdout.write(`run=${process.env.AUTOMATION_RUN_ID}\\n`);",
    "await import('node:fs/promises').then((fs) => fs.writeFile(process.env.AUTOMATION_RESULT_PATH, JSON.stringify({ artifact: 'demo', key: process.env.AUTOMATION_IDEMPOTENCY_KEY, scheduledAt: process.env.AUTOMATION_SCHEDULED_AT })));",
    "",
  ].join("\n"), "utf8");
}
