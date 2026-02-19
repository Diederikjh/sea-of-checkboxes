function toBool(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function createNoopPerfProbe() {
  return Object.freeze({
    enabled: false,
    measure(_name, fn) {
      return fn();
    },
    increment(_name, _delta = 1) {},
    gauge(_name, _value) {},
    flushMaybe() {},
  });
}

function recordSampleOnWindow(sample) {
  if (typeof window === "undefined") {
    return;
  }

  const key = "__seaPerfSamples";
  const existing = window[key];
  const samples = Array.isArray(existing) ? existing : [];
  samples.push(sample);
  if (samples.length > 600) {
    samples.shift();
  }
  window[key] = samples;
}

export function isPerfProbeEnabled({
  env = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {},
  locationLike = typeof window !== "undefined" ? window.location : undefined,
} = {}) {
  const params = new URLSearchParams(locationLike?.search ?? "");
  return toBool(env.VITE_PERF) || toBool(params.get("perf"));
}

export function createPerfProbe({ enabled = false, windowMs = 1_000 } = {}) {
  if (!enabled) {
    return createNoopPerfProbe();
  }

  const counters = new Map();
  const gauges = new Map();
  const timings = new Map();
  let windowStartMs = performance.now();

  function increment(name, delta = 1) {
    counters.set(name, (counters.get(name) ?? 0) + delta);
  }

  function gauge(name, value) {
    gauges.set(name, value);
  }

  function addTiming(name, durationMs) {
    const existing = timings.get(name) ?? {
      totalMs: 0,
      maxMs: 0,
      calls: 0,
    };
    existing.totalMs += durationMs;
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    existing.calls += 1;
    timings.set(name, existing);
  }

  function measure(name, fn) {
    const startMs = performance.now();
    try {
      return fn();
    } finally {
      addTiming(name, performance.now() - startMs);
    }
  }

  function flushMaybe() {
    const nowMs = performance.now();
    const elapsedMs = nowMs - windowStartMs;
    if (elapsedMs < windowMs) {
      return;
    }

    const timingSummary = {};
    for (const [name, stats] of timings.entries()) {
      timingSummary[name] = {
        totalMs: Number(stats.totalMs.toFixed(2)),
        avgMs: Number((stats.totalMs / Math.max(1, stats.calls)).toFixed(3)),
        maxMs: Number(stats.maxMs.toFixed(3)),
        calls: stats.calls,
      };
    }

    const counterSummary = {};
    for (const [name, value] of counters.entries()) {
      counterSummary[name] = Number(value.toFixed ? value.toFixed(2) : value);
    }

    const gaugeSummary = {};
    for (const [name, value] of gauges.entries()) {
      gaugeSummary[name] = Number(value.toFixed ? value.toFixed(2) : value);
    }

    const sample = {
      elapsedMs: Number(elapsedMs.toFixed(1)),
      counters: counterSummary,
      timings: timingSummary,
      gauges: gaugeSummary,
    };

    recordSampleOnWindow(sample);
    console.log("[perf]", sample);
    console.log("[perf-json]", JSON.stringify(sample));

    counters.clear();
    timings.clear();
    windowStartMs = nowMs;
  }

  return {
    enabled: true,
    measure,
    increment,
    gauge,
    flushMaybe,
  };
}
