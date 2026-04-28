#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { buildRawBundlePaths, writeRawBundle } from "@telegram-local-ingest/vault";
import { runWikiIngestAdapter } from "@telegram-local-ingest/wiki-adapter";

const DEFAULT_API_BASE_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";
const DEFAULT_CURRENCIES = ["USD", "JPY(100)", "EUR", "CNH"];

async function main() {
  const env = process.env;
  const projectRoot = env.AUTOMATION_PROJECT_ROOT ?? process.cwd();
  const runtimeDir = path.resolve(env.AUTOMATION_RUNTIME_DIR ?? path.join(projectRoot, "runtime"));
  const vaultPath = requiredEnv("OBSIDIAN_VAULT_PATH");
  const rawRoot = env.OBSIDIAN_RAW_ROOT?.trim() || "raw";
  const searchDate = resolveSearchDate(env);
  const localDate = `${searchDate.slice(0, 4)}-${searchDate.slice(4, 6)}-${searchDate.slice(6, 8)}`;
  const sourceId = `fx_koreaexim_${searchDate}`;
  const paths = buildRawBundlePaths({ vaultPath, rawRoot, date: localDate, sourceId });
  const resultPath = env.AUTOMATION_RESULT_PATH;

  if (await exists(paths.finalizedMarker)) {
    await writeResult(resultPath, {
      status: "skipped",
      reason: "raw_bundle_exists",
      searchDate,
      bundlePath: paths.root,
    });
    process.stdout.write(`raw bundle already exists ${paths.root}\n`);
    return;
  }

  const workDir = path.join(runtimeDir, "automation", "fx-koreaexim-daily", searchDate);
  await fs.mkdir(workDir, { recursive: true });
  const apiRows = await loadExchangeRows(searchDate, env);
  const selectedRows = filterRows(apiRows, parseTargetCurrencies(env.FX_CURRENCIES));
  if (apiRows.length === 0 && truthy(env.FX_SKIP_EMPTY_BUNDLE)) {
    await writeResult(resultPath, {
      status: "skipped",
      reason: "no_source_rows",
      searchDate,
      rowCount: 0,
      selectedCount: 0,
      bundlePath: paths.root,
    });
    process.stdout.write(`skipped fx searchDate=${searchDate} reason=no_source_rows\n`);
    return;
  }
  const rawJsonPath = path.join(workDir, "koreaexim-ap01.json");
  const ratesCsvPath = path.join(workDir, "rates.csv");
  const ratesMdPath = path.join(workDir, "rates.md");
  await fs.writeFile(rawJsonPath, `${JSON.stringify(apiRows, null, 2)}\n`, "utf8");
  await fs.writeFile(ratesCsvPath, renderCsv(selectedRows), "utf8");
  await fs.writeFile(ratesMdPath, renderMarkdown(searchDate, selectedRows, apiRows.length), "utf8");

  const bundle = await writeRawBundle({
    vaultPath,
    rawRoot,
    job: {
      id: sourceId,
      source: "local",
      status: "COMPLETED",
      tags: ["fx", "koreaexim", "daily"],
      retryCount: 0,
      createdAt: `${localDate}T00:00:00.000Z`,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      project: "fx",
      instructions: "Daily Korea Eximbank AP01 exchange-rate capture.",
    },
    files: [{
      id: `${sourceId}_api_json`,
      jobId: sourceId,
      originalName: `koreaexim-ap01-${searchDate}.json`,
      mimeType: "application/json",
      sizeBytes: (await fs.stat(rawJsonPath)).size,
      sha256: await sha256File(rawJsonPath),
      localPath: rawJsonPath,
      createdAt: new Date().toISOString(),
    }],
    extractedArtifacts: [
      {
        id: `${sourceId}_rates_md`,
        sourcePath: ratesMdPath,
        name: `rates-${searchDate}.md`,
        kind: "fx_rates_markdown",
        mimeType: "text/markdown",
        sizeBytes: (await fs.stat(ratesMdPath)).size,
        sha256: await sha256File(ratesMdPath),
        wikiRole: "canonical_text",
        derivedFromPath: "original/koreaexim-ap01.json",
      },
      {
        id: `${sourceId}_rates_csv`,
        sourcePath: ratesCsvPath,
        name: `rates-${searchDate}.csv`,
        kind: "fx_rates_csv",
        mimeType: "text/csv",
        sizeBytes: (await fs.stat(ratesCsvPath)).size,
        sha256: await sha256File(ratesCsvPath),
        wikiRole: "canonical_text",
        derivedFromPath: "original/koreaexim-ap01.json",
      },
    ],
    now: new Date().toISOString(),
  });

  const wiki = await maybeRunWikiIngest({
    env,
    projectRoot,
    vaultPath,
    rawRoot,
    bundlePath: bundle.paths.root,
    sourceId,
  });
  await writeResult(resultPath, {
    status: selectedRows.length > 0 ? "captured" : "skipped",
    reason: selectedRows.length > 0 ? undefined : "no_rate_rows",
    searchDate,
    rowCount: apiRows.length,
    selectedCount: selectedRows.length,
    bundlePath: bundle.paths.root,
    wiki,
  });
  process.stdout.write(`captured fx searchDate=${searchDate} rows=${selectedRows.length} bundle=${bundle.paths.root}\n`);
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function resolveSearchDate(env) {
  if (env.FX_SEARCH_DATE?.trim()) {
    const value = env.FX_SEARCH_DATE.trim();
    if (!/^\d{8}$/.test(value)) {
      throw new Error("FX_SEARCH_DATE must be YYYYMMDD");
    }
    return value;
  }
  const base = env.AUTOMATION_SCHEDULED_AT ? new Date(env.AUTOMATION_SCHEDULED_AT) : new Date();
  return formatSeoulDate(base).replace(/-/g, "");
}

function formatSeoulDate(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

async function loadExchangeRows(searchDate, env) {
  if (env.FX_KOREAEXIM_FIXTURE_PATH?.trim()) {
    return parseApiRows(JSON.parse(await fs.readFile(path.resolve(env.FX_KOREAEXIM_FIXTURE_PATH), "utf8")));
  }
  const url = new URL(env.FX_KOREAEXIM_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL);
  url.searchParams.set("authkey", requiredEnv("FX_KOREAEXIM_AUTHKEY"));
  url.searchParams.set("searchdate", searchDate);
  url.searchParams.set("data", "AP01");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Korea Eximbank API failed: HTTP ${response.status}`);
  }
  return parseApiRows(await response.json());
}

function parseApiRows(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Korea Eximbank API returned non-array JSON");
  }
  if (payload.length === 1 && payload[0] && typeof payload[0] === "object") {
    const result = pick(payload[0], "RESULT", "result");
    const currency = pick(payload[0], "CUR_UNIT", "cur_unit");
    if (result && result !== 1 && !currency) {
      throw new Error(`Korea Eximbank API returned RESULT=${result}`);
    }
  }
  const rows = payload.filter((row) => row && typeof row === "object" && typeof pick(row, "CUR_UNIT", "cur_unit") === "string");
  if (payload.length > 0 && rows.length === 0) {
    throw new Error("Korea Eximbank API returned no currency rows; response schema may have changed");
  }
  return rows;
}

function parseTargetCurrencies(value) {
  if (!value?.trim()) {
    return new Set(DEFAULT_CURRENCIES);
  }
  if (value.trim().toLowerCase() === "all") {
    return null;
  }
  return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
}

function filterRows(rows, targetCurrencies) {
  const filtered = targetCurrencies
    ? rows.filter((row) => targetCurrencies.has(String(pick(row, "CUR_UNIT", "cur_unit")).trim()))
    : rows;
  return filtered.map((row) => ({
    result: clean(pick(row, "RESULT", "result")),
    curUnit: clean(pick(row, "CUR_UNIT", "cur_unit")),
    curName: clean(pick(row, "CUR_NM", "cur_nm")),
    ttb: clean(pick(row, "TTB", "ttb")),
    tts: clean(pick(row, "TTS", "tts")),
    dealBasR: clean(pick(row, "DEAL_BAS_R", "deal_bas_r")),
    bkpr: clean(pick(row, "BKPR", "bkpr")),
    kftcDealBasR: clean(pick(row, "KFTC_DEAL_BAS_R", "kftc_deal_bas_r")),
  }));
}

function renderCsv(rows) {
  const lines = [["cur_unit", "cur_name", "ttb", "tts", "deal_bas_r", "bkpr", "kftc_deal_bas_r"]];
  for (const row of rows) {
    lines.push([row.curUnit, row.curName, row.ttb, row.tts, row.dealBasR, row.bkpr, row.kftcDealBasR]);
  }
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

function renderMarkdown(searchDate, rows, sourceCount) {
  const titleDate = `${searchDate.slice(0, 4)}-${searchDate.slice(4, 6)}-${searchDate.slice(6, 8)}`;
  const lines = [
    `# Korea Eximbank FX Rates ${titleDate}`,
    "",
    `- Source: Korea Eximbank Open API AP01`,
    `- Search date: ${searchDate}`,
    `- Source rows: ${sourceCount}`,
    `- Selected rows: ${rows.length}`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("No selected exchange-rate rows were returned. This can happen on non-business days or if the target currency filter excludes all rows.", "");
    return lines.join("\n");
  }
  lines.push("| Currency | Name | TTB | TTS | Deal Basis | KFTC Deal Basis |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(`| ${escapeTable(row.curUnit)} | ${escapeTable(row.curName)} | ${escapeTable(row.ttb)} | ${escapeTable(row.tts)} | ${escapeTable(row.dealBasR)} | ${escapeTable(row.kftcDealBasR)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function maybeRunWikiIngest(input) {
  const command = input.env.WIKI_INGEST_COMMAND?.trim();
  if (!command) {
    return { status: "skipped", reason: "WIKI_INGEST_COMMAND not set" };
  }
  const wikiRoot = path.resolve(input.vaultPath, "wiki");
  const rawRootPath = path.resolve(input.vaultPath, input.rawRoot);
  const lockPath = path.resolve(input.projectRoot, input.env.WIKI_WRITE_LOCK_PATH?.trim() || "runtime/wiki.lock");
  const result = await runWikiIngestAdapter({
    command,
    bundlePath: input.bundlePath,
    rawRoot: rawRootPath,
    wikiRoot,
    lockPath,
    jobId: input.sourceId,
    project: "fx",
    tags: ["fx", "koreaexim", "daily"],
    instructions: "Ingest the canonical exchange-rate markdown/csv inputs as daily FX facts. Keep pages token-efficient.",
  });
  return { status: "completed", stdout: result.stdout, stderr: result.stderr };
}

async function writeResult(resultPath, result) {
  if (!resultPath) {
    return;
  }
  const normalized = Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(resultPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function pick(row, upperKey, lowerKey) {
  return row[upperKey] ?? row[lowerKey];
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function escapeTable(value) {
  return String(value).replace(/\|/g, "\\|");
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

main().catch(async (error) => {
  await writeResult(process.env.AUTOMATION_RESULT_PATH, {
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
