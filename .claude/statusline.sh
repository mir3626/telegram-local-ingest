#!/usr/bin/env bash

node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";

try {
  const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  const readJsonOptional = (filePath) => {
    try {
      return readJson(filePath);
    } catch {
      return undefined;
    }
  };
  const getString = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
  const parseStatuslineInput = (raw) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  };
  const readStatuslineInput = () => {
    if (process.env.VIBE_STATUSLINE_READ_STDIN !== "1") return undefined;
    try {
      const stat = fs.fstatSync(0);
      if (stat.isCharacterDevice()) return undefined;
      return parseStatuslineInput(fs.readFileSync(0, "utf8"));
    } catch {
      return undefined;
    }
  };
  const getFiniteNumber = (value) => (Number.isFinite(value) ? value : 0);
  const getUsageTotal = (usage) => {
    return usage && typeof usage === "object" && !Array.isArray(usage)
      ? getFiniteNumber(usage.input_tokens) + getFiniteNumber(usage.output_tokens)
      : 0;
  };
  const getClaudeTokens = (input) => {
    const transcriptPath = getString(input?.transcript_path);
    if (!transcriptPath) return undefined;
    try {
      if (!fs.statSync(transcriptPath).isFile()) return undefined;
      let total = 0;
      for (const line of fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const entry = JSON.parse(trimmed);
          total += getUsageTotal(entry?.message?.usage ?? entry?.usage);
        } catch {
        }
      }
      return total;
    } catch {
      return undefined;
    }
  };
  const normalizeVersion = (version) => version.trim().replace(/^v/i, "");
  const toVersionParts = (version) => {
    const normalized = normalizeVersion(version);
    if (!/^\d+(?:\.\d+)*$/.test(normalized)) {
      return undefined;
    }

    return normalized.split(".").map((part) => Number.parseInt(part, 10));
  };
  const compareVersions = (left, right) => {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = left[index] ?? 0;
      const rightPart = right[index] ?? 0;
      if (leftPart !== rightPart) {
        return leftPart > rightPart ? 1 : -1;
      }
    }

    return 0;
  };
  const getVersionSuffix = () => {
    const config = readJsonOptional(path.join(root, ".vibe", "config.json"));
    const installedRaw = getString(config?.harnessVersionInstalled) ?? getString(config?.harnessVersion);
    const installedParts = installedRaw ? toVersionParts(installedRaw) : undefined;
    if (!installedRaw || !installedParts) {
      return undefined;
    }

    const installedVersion = normalizeVersion(installedRaw);
    const syncCache = readJsonOptional(path.join(root, ".vibe", "sync-cache.json"));
    const latestRaw = getString(syncCache?.latestVersion);
    const latestParts = latestRaw ? toVersionParts(latestRaw) : undefined;
    if (latestRaw && latestParts && compareVersions(installedParts, latestParts) < 0) {
      return `v${installedVersion} \u26A0 v${normalizeVersion(latestRaw)} (/vibe-sync)`;
    }

    return `v${installedVersion}`;
  };
  const root = process.cwd();
  const statusPath = path.join(root, ".vibe", "agent", "sprint-status.json");
  if (!fs.existsSync(statusPath)) {
    process.exit(0);
  }

  const status = readJson(statusPath);
  const statuslineInput = readStatuslineInput();
  const claudeTokens = getClaudeTokens(statuslineInput);
  const sprints = Array.isArray(status.sprints) ? status.sprints : [];
  const pendingRisks = Array.isArray(status.pendingRisks) ? status.pendingRisks : [];
  const sprintsSinceLastAudit = Number.isInteger(status.sprintsSinceLastAudit)
    ? status.sprintsSinceLastAudit
    : 0;
  const currentSprintId =
    typeof status.handoff?.currentSprintId === "string" && status.handoff.currentSprintId.length > 0
      ? status.handoff.currentSprintId
      : "idle";
  const passedCount = sprints.filter((entry) => entry?.status === "passed").length;
  const totalCount = sprints.length;
  const openRisks = pendingRisks.filter((entry) => entry?.status === "open").length;
  const parts = [`🎯 ${currentSprintId} (${passedCount}/${totalCount})`];
  void sprintsSinceLastAudit;

  const tokensPath = path.join(root, ".vibe", "agent", "tokens.json");
  if (fs.existsSync(tokensPath)) {
    const tokens = readJson(tokensPath);
    const elapsedSeconds = Number.isFinite(tokens.elapsedSeconds) ? tokens.elapsedSeconds : 0;
    const cumulativeTokens = Number.isFinite(tokens.cumulativeTokens) ? tokens.cumulativeTokens : 0;
    parts.push(`⏱️ ${Math.round(elapsedSeconds / 60)}m`);
    if (typeof claudeTokens === "number") {
      parts.push(`💭 Claude ${Math.floor(claudeTokens / 1000)}K`);
    }
    parts.push(`🔧 Codex ${Math.floor(cumulativeTokens / 1000)}K`);
  } else if (typeof claudeTokens === "number") {
    parts.push(`💭 Claude ${Math.floor(claudeTokens / 1000)}K`);
  }

  parts.push(`⚠️ ${openRisks}`);
  const versionSuffix = getVersionSuffix();
  if (versionSuffix) {
    parts.push(`🏷️ ${versionSuffix}`);
  }
  process.stdout.write(parts.join(" | "));
} catch {
  process.exit(0);
}
' 2>/dev/null || true
