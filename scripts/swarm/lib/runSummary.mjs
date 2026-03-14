import fs from "node:fs";

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

  if (summary.shareLink?.url) {
    lines.push(`Share link: ${summary.shareLink.url}`);
  }

  return `${lines.join("\n")}\n`;
}
