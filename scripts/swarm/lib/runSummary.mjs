import fs from "node:fs";

const BEST_EFFORT_SCENARIO_IDS = new Set(["cursor-heavy", "viewport-churn"]);
const BEST_EFFORT_MIN_RESOLUTION_RATIO = 0.95;

function toNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundIfNumber(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(3))
    : null;
}

function rangeSummary(values) {
  if (values.length === 0) {
    return {
      min: null,
      max: null,
    };
  }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function sumObjects(entries) {
  const totals = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      totals[key] = (totals[key] ?? 0) + value;
    }
  }
  return totals;
}

function collectLatencies(botSummaries, metricName) {
  const metrics = botSummaries
    .map((bot) => bot?.summary?.latencyMs?.[metricName] ?? null)
    .filter((metric) => metric && typeof metric === "object" && (metric.count ?? 0) > 0);

  if (metrics.length === 0) {
    return {
      botsWithSamples: 0,
      sampleCount: 0,
      observedMinMs: null,
      observedMaxMs: null,
      avgOfAveragesMs: null,
      botP50Ms: {
        min: null,
        max: null,
      },
      botP95Ms: {
        min: null,
        max: null,
      },
      botP99Ms: {
        min: null,
        max: null,
      },
    };
  }

  const sampleCounts = metrics
    .map((metric) => toNumberOrNull(metric.count))
    .filter((value) => value !== null);
  const observedMins = metrics
    .map((metric) => toNumberOrNull(metric.minMs))
    .filter((value) => value !== null);
  const observedMaxes = metrics
    .map((metric) => toNumberOrNull(metric.maxMs))
    .filter((value) => value !== null);
  const averages = metrics
    .map((metric) => toNumberOrNull(metric.avgMs))
    .filter((value) => value !== null);
  const p50s = metrics
    .map((metric) => toNumberOrNull(metric.p50Ms))
    .filter((value) => value !== null);
  const p95s = metrics
    .map((metric) => toNumberOrNull(metric.p95Ms))
    .filter((value) => value !== null);
  const p99s = metrics
    .map((metric) => toNumberOrNull(metric.p99Ms))
    .filter((value) => value !== null);

  const avgOfAveragesMs = averages.length === 0
    ? null
    : roundIfNumber(averages.reduce((sum, value) => sum + value, 0) / averages.length);

  return {
    botsWithSamples: metrics.length,
    sampleCount: sampleCounts.reduce((sum, value) => sum + value, 0),
    observedMinMs: observedMins.length === 0 ? null : Math.min(...observedMins),
    observedMaxMs: observedMaxes.length === 0 ? null : Math.max(...observedMaxes),
    avgOfAveragesMs,
    botP50Ms: rangeSummary(p50s),
    botP95Ms: rangeSummary(p95s),
    botP99Ms: rangeSummary(p99s),
  };
}

function summarizeRemoteCursorVisibility(botSummaries) {
  const peerCounts = botSummaries
    .map((bot) => toNumberOrNull(bot?.summary?.counters?.firstRemoteCursorPeers))
    .filter((value) => value !== null);
  const uniquePeerUids = new Set();
  let botsWithAnyRemoteCursor = 0;

  for (const bot of botSummaries) {
    const peers = bot?.summary?.remoteCursorCountsByPeer ?? {};
    const peerIds = Object.keys(peers);
    if (peerIds.length > 0) {
      botsWithAnyRemoteCursor += 1;
    }
    for (const peerId of peerIds) {
      uniquePeerUids.add(peerId);
    }
  }

  return {
    botsWithAnyRemoteCursor,
    uniquePeerUidCount: uniquePeerUids.size,
    peersSeenPerBot: rangeSummary(peerCounts),
  };
}

function summarizeDurations(botSummaries) {
  const values = botSummaries
    .map((bot) => toNumberOrNull(bot?.summary?.durationMs))
    .filter((value) => value !== null);
  return {
    count: values.length,
    ...rangeSummary(values),
    avgMs: values.length === 0
      ? null
      : roundIfNumber(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

function buildRoleCounts(botSummaries) {
  let readonly = 0;
  let active = 0;
  for (const bot of botSummaries) {
    if (bot?.summary?.readonly) {
      readonly += 1;
      continue;
    }
    active += 1;
  }
  return {
    active,
    readonly,
  };
}

function collectShards(botSummaries) {
  return [...new Set(
    botSummaries
      .map((bot) => bot?.summary?.shard)
      .filter((value) => typeof value === "string" && value.length > 0)
  )].sort();
}

function collectScenarioCounts(botSummaries) {
  const counts = {};
  for (const bot of botSummaries) {
    const scenarioId = bot?.summary?.scenarioId;
    if (typeof scenarioId !== "string" || scenarioId.length === 0) {
      continue;
    }
    counts[scenarioId] = (counts[scenarioId] ?? 0) + 1;
  }
  return counts;
}

function buildScenarioOutcomeTotals(botSummaries) {
  const totals = {};
  for (const bot of botSummaries) {
    const scenarioId = bot?.summary?.scenarioId;
    if (typeof scenarioId !== "string" || scenarioId.length === 0) {
      continue;
    }
    const counters = bot?.summary?.counters ?? {};
    const pending = bot?.summary?.pending ?? {};
    const errorsByCode = bot?.summary?.errorsByCode ?? {};
    const entry = totals[scenarioId] ?? {
      bots: 0,
      setCellSent: 0,
      setCellResolved: 0,
      setCellSuperseded: 0,
      pendingSetCell: 0,
      errorsByCode: {},
    };
    entry.bots += 1;
    entry.setCellSent += counters.setCellSent ?? 0;
    entry.setCellResolved += counters.setCellResolved ?? 0;
    entry.setCellSuperseded += counters.setCellSuperseded ?? 0;
    entry.pendingSetCell += pending.setCell ?? 0;
    entry.errorsByCode = sumObjects([entry.errorsByCode, errorsByCode]);
    totals[scenarioId] = entry;
  }
  return totals;
}

function assessRun({
  failedBots,
  forcedKillCount,
  botResults,
  scenarioOutcomes,
}) {
  const failures = [];
  const warnings = [];

  if (failedBots > 0) {
    failures.push(`${failedBots} bot process failures`);
  }
  if (forcedKillCount > 0) {
    failures.push(`${forcedKillCount} force-killed bots`);
  }

  for (const bot of botResults) {
    const scenarioId = bot?.summary?.scenarioId;
    const errorsByCode = bot?.summary?.errorsByCode ?? {};
    const pendingSetCell = bot?.summary?.pending?.setCell ?? 0;
    const toleratedNotSubscribed = BEST_EFFORT_SCENARIO_IDS.has(scenarioId)
      ? (errorsByCode.not_subscribed ?? 0)
      : 0;
    const fatalErrors = { ...errorsByCode };
    if (toleratedNotSubscribed > 0) {
      delete fatalErrors.not_subscribed;
    }
    if (Object.keys(fatalErrors).length > 0) {
      failures.push(`${bot.botId} reported fatal errors ${JSON.stringify(fatalErrors)}`);
    }
    if (!BEST_EFFORT_SCENARIO_IDS.has(scenarioId) && pendingSetCell > 0) {
      failures.push(`${bot.botId} finished with ${pendingSetCell} pending setCell writes`);
    }
  }

  for (const [scenarioId, outcome] of Object.entries(scenarioOutcomes)) {
    const expectedResolutions = Math.max(0, outcome.setCellSent - outcome.setCellSuperseded);
    const unresolvedWrites = Math.max(0, expectedResolutions - outcome.setCellResolved);
    if (!BEST_EFFORT_SCENARIO_IDS.has(scenarioId)) {
      if (unresolvedWrites > 0) {
        failures.push(`${scenarioId} left ${unresolvedWrites} unresolved writes`);
      }
      continue;
    }

    if (expectedResolutions === 0) {
      continue;
    }

    const resolutionRatio = outcome.setCellResolved / expectedResolutions;
    const notSubscribed = outcome.errorsByCode.not_subscribed ?? 0;
    const ratioText = `${(resolutionRatio * 100).toFixed(1)}%`;
    if (resolutionRatio < BEST_EFFORT_MIN_RESOLUTION_RATIO) {
      failures.push(
        `${scenarioId} resolved ${outcome.setCellResolved}/${expectedResolutions} writes (${ratioText})`
      );
      continue;
    }
    if (unresolvedWrites > 0 || notSubscribed > 0 || outcome.pendingSetCell > 0) {
      warnings.push(
        `${scenarioId} best-effort writes: resolved ${outcome.setCellResolved}/${expectedResolutions} (${ratioText}), pending=${outcome.pendingSetCell}, not_subscribed=${notSubscribed}`
      );
    }
  }

  return {
    status: failures.length === 0
      ? (warnings.length === 0 ? "pass" : "pass_with_warnings")
      : "fail",
    failures,
    warnings,
  };
}

export function loadBotRunResults(childResults) {
  return childResults.map((result) => {
    let summary = null;
    try {
      summary = JSON.parse(fs.readFileSync(result.summaryOutput, "utf8"));
    } catch {
      summary = null;
    }
    return {
      botId: result.botId,
      code: result.code,
      signal: result.signal,
      forced: result.forced,
      summary,
    };
  });
}

export function buildRunSummary({
  config,
  botResults,
  stopReason,
  shareLink,
}) {
  const forcedKillCount = botResults.filter((item) => item.forced).length;
  const failedBots = botResults.filter(
    (item) => item.code !== 0 || item.signal !== null
  ).length;
  const roleCounts = buildRoleCounts(botResults);
  const counters = sumObjects(botResults.map((bot) => bot?.summary?.counters ?? null));
  const errorsByCode = sumObjects(botResults.map((bot) => bot?.summary?.errorsByCode ?? null));
  const scenarioOutcomes = buildScenarioOutcomeTotals(botResults);
  const assessment = assessRun({
    failedBots,
    forcedKillCount,
    botResults,
    scenarioOutcomes,
  });

  return {
    ok: failedBots === 0,
    runId: config.runId,
    stopReason,
    shareLink,
    botCount: config.botCount,
    forcedKillCount,
    failedBots,
    roleCounts,
    scenarioCounts: collectScenarioCounts(botResults),
    scenarioOutcomes,
    assessment,
    counters,
    errorsByCode,
    shards: collectShards(botResults),
    durationMs: summarizeDurations(botResults),
    remoteCursorVisibility: summarizeRemoteCursorVisibility(botResults),
    latencyMs: {
      hello: collectLatencies(botResults, "hello"),
      subscribeAck: collectLatencies(botResults, "subscribeAck"),
      setCellSync: collectLatencies(botResults, "setCellSync"),
      reconnect: collectLatencies(botResults, "reconnect"),
      stop: collectLatencies(botResults, "stop"),
      firstRemoteCursor: collectLatencies(botResults, "firstRemoteCursor"),
    },
    bots: botResults,
  };
}

function formatRange(range, suffix = "") {
  if (!range || range.min === null || range.max === null) {
    return "n/a";
  }
  if (range.min === range.max) {
    return `${range.min}${suffix}`;
  }
  return `${range.min}-${range.max}${suffix}`;
}

function formatLatencyLine(label, metric) {
  if (!metric || metric.sampleCount === 0) {
    return `${label}: no samples`;
  }
  return `${label}: ${metric.sampleCount} samples across ${metric.botsWithSamples} bots | observed ${formatRange({ min: metric.observedMinMs, max: metric.observedMaxMs }, "ms")} | bot p50 ${formatRange(metric.botP50Ms, "ms")}`;
}

export function formatRunSummaryText(summary) {
  const lines = [
    `Run ${summary.runId}`,
    `Status: ${summary.ok ? "ok" : "failed"}${summary.stopReason ? ` (${summary.stopReason})` : ""}`,
    `Assessment: ${summary.assessment?.status ?? "n/a"}`,
    `Bots: ${summary.botCount} total | ${summary.roleCounts.active} active | ${summary.roleCounts.readonly} readonly | ${summary.failedBots} failed | ${summary.forcedKillCount} force-killed`,
    `Scenarios: ${Object.keys(summary.scenarioCounts).length === 0 ? "n/a" : Object.entries(summary.scenarioCounts).map(([scenarioId, count]) => `${scenarioId}=${count}`).join(" ")}`,
    `Duration: ${formatRange({ min: summary.durationMs.min, max: summary.durationMs.max }, "ms")} avg ${summary.durationMs.avgMs ?? "n/a"}ms`,
    `Shards: ${summary.shards.length === 0 ? "n/a" : summary.shards.join(", ")}`,
    `Counters: cursorSent=${summary.counters.cursorSent ?? 0} setCellSent=${summary.counters.setCellSent ?? 0} setCellResolved=${summary.counters.setCellResolved ?? 0} setCellSuperseded=${summary.counters.setCellSuperseded ?? 0} authoritativeUpdates=${summary.counters.authoritativeUpdates ?? 0} reconnects=${summary.counters.reconnects ?? 0}`,
    `Remote cursors: ${summary.remoteCursorVisibility.botsWithAnyRemoteCursor}/${summary.botCount} bots saw peers | peers per bot ${formatRange(summary.remoteCursorVisibility.peersSeenPerBot)} | unique peer uids ${summary.remoteCursorVisibility.uniquePeerUidCount}`,
    "Latency:",
    `  ${formatLatencyLine("hello", summary.latencyMs.hello)}`,
    `  ${formatLatencyLine("subscribeAck", summary.latencyMs.subscribeAck)}`,
    `  ${formatLatencyLine("firstRemoteCursor", summary.latencyMs.firstRemoteCursor)}`,
    `  ${formatLatencyLine("setCellSync", summary.latencyMs.setCellSync)}`,
    `  ${formatLatencyLine("reconnect", summary.latencyMs.reconnect)}`,
    `  ${formatLatencyLine("stop", summary.latencyMs.stop)}`,
    `Errors: ${Object.keys(summary.errorsByCode).length === 0 ? "none" : JSON.stringify(summary.errorsByCode)}`,
  ];

  for (const warning of summary.assessment?.warnings ?? []) {
    lines.push(`Warning: ${warning}`);
  }
  for (const failure of summary.assessment?.failures ?? []) {
    lines.push(`Failure: ${failure}`);
  }

  if (summary.shareLink?.url) {
    lines.push(`Share link: ${summary.shareLink.url}`);
  }

  return `${lines.join("\n")}\n`;
}
