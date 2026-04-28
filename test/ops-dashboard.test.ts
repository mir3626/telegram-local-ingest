import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOpsDashboardServer } from "../apps/ops-dashboard/src/index.js";

const repoRoot = path.resolve(".");

test("ops dashboard reports automation readiness without exposing secret values", async () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.secret",
    title: "Demo Secret",
    defaultEnabled: false,
    requiredEnv: ["DEMO_SECRET_TOKEN"],
  });
  const env = {
    ...process.env,
    AUTOMATION_MODULES_DIR: fixture.modulesRoot,
    INGEST_RUNTIME_DIR: fixture.runtimeDir,
    SQLITE_DB_PATH: fixture.dbPath,
    DEMO_SECRET_TOKEN: "super-secret-value",
    OPS_DASHBOARD_TOKEN: "admin-token",
  };
  const dashboard = await createOpsDashboardServer({
    projectRoot: repoRoot,
    port: 0,
    env,
    loadEnvFile: false,
  });
  try {
    const stateResponse = await fetch(new URL("/api/state", dashboard.url));
    assert.equal(stateResponse.status, 200);
    const stateText = await stateResponse.text();
    assert.doesNotMatch(stateText, /super-secret-value/);
    const state = JSON.parse(stateText) as {
      modules: Array<{ id: string; readiness: { ready: boolean; missingEnv: string[] }; enabled: boolean }>;
      admin: { tokenRequired: boolean };
    };
    assert.equal(state.admin.tokenRequired, true);
    assert.equal(state.modules.find((module) => module.id === "demo.secret")?.readiness.ready, true);
    assert.equal(state.modules.find((module) => module.id === "demo.secret")?.enabled, false);

    const blocked = await fetch(new URL("/api/modules/demo.secret/enable", dashboard.url), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    assert.equal(blocked.status, 403);

    const enabled = await fetch(new URL("/api/modules/demo.secret/enable", dashboard.url), {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-ops-dashboard-token": "admin-token",
      },
    });
    assert.equal(enabled.status, 200);

    const nextState = await (await fetch(new URL("/api/state", dashboard.url))).json() as {
      modules: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(nextState.modules.find((module) => module.id === "demo.secret")?.enabled, true);
  } finally {
    await closeServer(dashboard.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops dashboard can run a module and return durable result logs", async () => {
  const fixture = createFixture();
  const bundlePath = path.join(fixture.root, "vault", "raw", "2026-04-28", "demo");
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.echo",
    title: "Demo Echo",
    defaultEnabled: false,
  });
  const env = {
    ...process.env,
    AUTOMATION_MODULES_DIR: fixture.modulesRoot,
    INGEST_RUNTIME_DIR: fixture.runtimeDir,
    SQLITE_DB_PATH: fixture.dbPath,
    DEMO_BUNDLE_PATH: bundlePath,
  };
  const dashboard = await createOpsDashboardServer({
    projectRoot: repoRoot,
    port: 0,
    env,
    loadEnvFile: false,
  });
  try {
    const runResponse = await fetch(new URL("/api/modules/demo.echo/run", dashboard.url), {
      method: "POST",
      body: JSON.stringify({ force: true }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(runResponse.status, 200);
    const runDetail = await runResponse.json() as {
      run: { id: string; status: string };
      stdout: string;
      result: { moduleResult?: { artifact?: string; bundlePath?: string } };
      links: { rawBundlePath?: string };
    };
    assert.equal(runDetail.run.status, "SUCCEEDED");
    assert.match(runDetail.stdout, /module=demo.echo/);
    assert.equal(runDetail.result.moduleResult?.artifact, "demo");
    assert.equal(runDetail.links.rawBundlePath, bundlePath);

    const detailResponse = await fetch(new URL(`/api/runs/${runDetail.run.id}`, dashboard.url));
    assert.equal(detailResponse.status, 200);
    const detailText = await detailResponse.text();
    assert.match(detailText, /demo.echo/);
    assert.match(detailText, /bundlePath/);
  } finally {
    await closeServer(dashboard.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ops dashboard CLI entrypoint keeps the server process alive", async () => {
  const fixture = createFixture();
  writeAutomationModule(fixture.modulesRoot, {
    id: "demo.cli",
    title: "Demo CLI",
    defaultEnabled: true,
  });
  const child = spawn(process.execPath, ["--import", "tsx", "apps/ops-dashboard/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AUTOMATION_MODULES_DIR: fixture.modulesRoot,
      INGEST_RUNTIME_DIR: fixture.runtimeDir,
      SQLITE_DB_PATH: fixture.dbPath,
      OPS_DASHBOARD_PORT: "0",
    },
  });
  try {
    const url = await waitForDashboardUrl(child);
    const response = await fetch(new URL("/api/state", url));
    assert.equal(response.status, 200);
    const state = await response.json() as { modules: Array<{ id: string }> };
    assert.ok(state.modules.some((module) => module.id === "demo.cli"));
    assert.equal(child.exitCode, null);
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(): { root: string; modulesRoot: string; runtimeDir: string; dbPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dashboard-"));
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
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(moduleDir, "run.mjs"), [
    "process.stdout.write(`module=${process.env.AUTOMATION_MODULE_ID}\\n`);",
    "await import('node:fs/promises').then((fs) => fs.writeFile(process.env.AUTOMATION_RESULT_PATH, JSON.stringify({ artifact: 'demo', bundlePath: process.env.DEMO_BUNDLE_PATH })));",
    "",
  ].join("\n"), "utf8");
}

function closeServer(server: { close(callback?: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForDashboardUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for dashboard URL. Output: ${output}`));
    }, 5_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const match = output.match(/ops dashboard listening (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Dashboard exited before listening: code=${code ?? "-"} signal=${signal ?? "-"}. Output: ${output}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}
