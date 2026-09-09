#!/usr/bin/env node
// The spend sluis: a refusing cap on what the box may spend on model calls per rolling window.
//
//   check   exit 0 while recorded spend is below the ceiling, 75 once it is reached.
//   record  pass the agent's stream from stdin to stdout unchanged, then append one
//           priced row to the ledger from the stream's final result event. The event's
//           modelUsage (one entry per model, subagents included) is priced when present;
//           its top-level usage covers only the orchestrator's own turns and is the fallback.
//
// The ceiling lives in ceiling.json beside this file: one constant per rolling window of
// windowDays, and the number of flights it is meant to cover.
// There is no flag and no environment variable that raises it. A run whose usage cannot
// be read is charged one flight's share of the ceiling, so a broken reading spends budget
// visibly rather than hiding it.
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const CLASSES = ["input", "cacheWrite", "cacheRead", "output"];
const STREAM_KEYS = {
  input: "input_tokens",
  cacheWrite: "cache_creation_input_tokens",
  cacheRead: "cache_read_input_tokens",
  output: "output_tokens",
};
const MODEL_USAGE_KEYS = {
  input: "inputTokens",
  cacheWrite: "cacheCreationInputTokens",
  cacheRead: "cacheReadInputTokens",
  output: "outputTokens",
};
const EXIT_REFUSED = 75;

function roundCents(usd) {
  return Math.round(usd * 100) / 100;
}

function assertCount(name, value) {
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

export function priceRun(usage, prices) {
  return roundCents(priceRunExact(usage, prices));
}

function priceRunExact(usage, prices) {
  if (!usage || typeof usage !== "object") throw new TypeError("usage must be an object");
  if (!prices || typeof prices !== "object") throw new TypeError("prices must be an object");
  let usd = 0;
  for (const cls of CLASSES) {
    if (!(cls in usage)) throw new TypeError(`usage.${cls} is missing`);
    assertCount(`usage.${cls}`, usage[cls]);
    const rate = prices[cls];
    if (typeof rate !== "number" || !(rate >= 0)) throw new TypeError(`prices.${cls} must be a non-negative number`);
    usd += (usage[cls] / 1e6) * rate;
  }
  return usd;
}

// Returns { [modelId]: { input, cacheWrite, cacheRead, output } } from the stream's last
// result event, or null when no usable usage is present. modelUsage wins because it is the
// only place subagent tokens appear; the top-level usage block is attributed to runModel.
export function parseUsage(streamText, runModel) {
  if (typeof streamText !== "string") throw new TypeError("stream must be a string");
  let found = null;
  for (const line of streamText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || event.type !== "result") continue;
    found = usageFromEvent(event, runModel);
  }
  return found;
}

function countsFrom(raw, keys) {
  if (!raw || typeof raw !== "object") return null;
  const usage = {};
  for (const cls of CLASSES) {
    const value = raw[keys[cls]];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    usage[cls] = value;
  }
  return usage;
}

function usageFromEvent(event, runModel) {
  const byModel = event.modelUsage;
  if (byModel && typeof byModel === "object" && Object.keys(byModel).length > 0) {
    const out = {};
    for (const [model, raw] of Object.entries(byModel)) {
      const usage = countsFrom(raw, MODEL_USAGE_KEYS);
      if (!usage) return null;
      out[model] = usage;
    }
    return out;
  }
  const single = countsFrom(event.usage, STREAM_KEYS);
  if (!single) return null;
  if (typeof runModel !== "string" || !runModel) return null;
  return { [runModel]: single };
}

// A model id may carry a date suffix (claude-haiku-4-5-20251001); price rows are keyed
// without it. Throws RangeError when no row matches, so the caller charges the reserve.
export function priceRowFor(model, prices) {
  if (prices[model]) return prices[model];
  const undated = model.replace(/-\d{8}$/, "");
  if (prices[undated]) return prices[undated];
  throw new RangeError(`no price row for model ${model}`);
}

export function priceModelUsage(byModel, prices) {
  if (!byModel || typeof byModel !== "object") throw new TypeError("byModel must be an object");
  let usd = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    usd += priceRunExact(usage, priceRowFor(model, prices));
  }
  return roundCents(usd);
}

export function loadCeiling(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.ceilingUsd !== "number") throw new TypeError("ceilingUsd must be a number");
  if (!(parsed.ceilingUsd > 0)) throw new RangeError("ceilingUsd must be positive");
  if (typeof parsed.windowDays !== "number") throw new TypeError("windowDays must be a number: the ceiling is per rolling window");
  if (!Number.isInteger(parsed.windowDays) || parsed.windowDays < 1) throw new RangeError("windowDays must be a positive integer");
  if (typeof parsed.flights !== "number") throw new TypeError("flights must be a number");
  if (!Number.isInteger(parsed.flights) || parsed.flights < 1) throw new RangeError("flights must be a positive integer");
  if (typeof parsed.model !== "string" || !parsed.model) throw new TypeError("model must be a string");
  const prices = parsed.pricesUsdPerMillion;
  if (!prices || typeof prices !== "object") throw new TypeError("pricesUsdPerMillion must be an object");
  if (!prices[parsed.model]) throw new RangeError(`no price row for model ${parsed.model}`);
  for (const [model, row] of Object.entries(prices)) {
    for (const cls of CLASSES) {
      if (typeof row[cls] !== "number" || !(row[cls] >= 0)) throw new TypeError(`price for ${model}.${cls} must be a non-negative number`);
    }
  }
  if (typeof parsed.ledger !== "string" || !parsed.ledger) throw new TypeError("ledger must be a path");
  return {
    ceilingUsd: parsed.ceilingUsd,
    windowDays: parsed.windowDays,
    flights: parsed.flights,
    model: parsed.model,
    pricesUsdPerMillion: prices,
    priceBasis: typeof parsed.priceBasis === "string" ? parsed.priceBasis : "",
    ledger: parsed.ledger,
  };
}

export function reserveCharge(ceiling) {
  return roundCents(ceiling.ceilingUsd / ceiling.flights);
}

// Rows for one runId carry cumulative usage (a provisional row per result event, a final
// row at EOF), so a run's figure is its LAST row, never the sum of its rows. Rows without a
// runId (hand-recorded, older ledgers) count one each.
//
// With a window ({ now, windowDays }) a run counts when its last row was recorded inside
// the window; a row with no recordedAt always counts, since an undated dollar is not a free
// one. A final row dated before its provisional one cannot happen on a real ledger and is
// refused rather than read either way.
export function ledgerSpend(rows, window) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  let since = null;
  if (window !== undefined) {
    const { now, windowDays } = window ?? {};
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("window.now must be a Date");
    if (!Number.isInteger(windowDays) || windowDays < 1) throw new RangeError("window.windowDays must be a positive integer");
    since = now.getTime() - windowDays * 86_400_000;
  }
  const lastByRun = new Map();
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row.usd !== "number") throw new TypeError("ledger row usd must be a number");
    if (!(row.usd >= 0)) throw new RangeError("ledger row usd must be non-negative");
    let at = null;
    if (row.recordedAt !== undefined) {
      at = Date.parse(row.recordedAt);
      if (Number.isNaN(at)) throw new RangeError("ledger row recordedAt is not a date");
    }
    if (typeof row.runId === "string" && row.runId) {
      const prior = lastByRun.get(row.runId);
      if (prior && prior.at !== null && at !== null && at < prior.at) {
        throw new RangeError(`ledger rows for run ${row.runId} are out of order`);
      }
      lastByRun.set(row.runId, { usd: row.usd, at: at ?? prior?.at ?? null });
    } else if (since === null || at === null || at >= since) {
      total += row.usd;
    }
  }
  for (const { usd, at } of lastByRun.values()) {
    if (since === null || at === null || at >= since) total += usd;
  }
  return roundCents(total);
}

export function verdict({ spentUsd, ceilingUsd }) {
  if (typeof spentUsd !== "number" || typeof ceilingUsd !== "number") throw new TypeError("spentUsd and ceilingUsd must be numbers");
  const remainingUsd = roundCents(Math.max(0, ceilingUsd - spentUsd));
  return { allowed: spentUsd < ceilingUsd, remainingUsd };
}

// ---- files

function expandHome(p) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`ledger ${path} has a line that is not JSON`);
    }
    rows.push(row);
  }
  return rows;
}

function appendLedger(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

// ---- CLI

const KNOWN_FLAGS = new Set(["--config", "--ledger", "--run-id", "--model", "--issue", "--repo"]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown argument ${flag}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
    i++;
  }
  return { command, flags };
}

function resolveConfig(flags) {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(flags.config ?? join(here, "ceiling.json"));
  const ceiling = loadCeiling(configPath);
  const ledgerPath = resolve(expandHome(flags.ledger ?? ceiling.ledger));
  return { ceiling, ledgerPath };
}

function check(flags) {
  const { ceiling, ledgerPath } = resolveConfig(flags);
  const spentUsd = ledgerSpend(readLedger(ledgerPath), { now: new Date(), windowDays: ceiling.windowDays });
  const v = verdict({ spentUsd, ceilingUsd: ceiling.ceilingUsd });
  if (!v.allowed) {
    process.stderr.write(
      `spend sluis: ceiling reached: $${spentUsd.toFixed(2)} recorded in the last ${ceiling.windowDays} days of a $${ceiling.ceilingUsd.toFixed(2)} ceiling in ${ledgerPath}; no flight starts until a human decides\n`,
    );
    return EXIT_REFUSED;
  }
  // stderr, so the runner's stdout stays the agent's stream alone
  process.stderr.write(`spend sluis: remaining $${v.remainingUsd.toFixed(2)} of $${ceiling.ceilingUsd.toFixed(2)} in the last ${ceiling.windowDays} days (ledger ${ledgerPath})\n`);
  return 0;
}

async function record(flags) {
  const { ceiling, ledgerPath } = resolveConfig(flags);
  const runId = flags["run-id"];
  const model = flags.model;
  if (!runId) throw new Error("--run-id is required");
  if (!model) throw new Error("--model is required");
  const prices = ceiling.pricesUsdPerMillion[model];
  if (!prices) throw new Error(`model ${model} has no price row in the ceiling; refusing to record an unpriced run`);
  // The issue and repository the wrapper read from the prompt, on every row: a run's marker
  // names its issue only while the run is alive, and the board joins runs to flights afterwards.
  let issue = null;
  if (flags.issue !== undefined) {
    issue = Number(flags.issue);
    if (!Number.isInteger(issue) || issue < 1) throw new Error(`--issue must be a positive integer, got ${flags.issue}`);
  }
  const repo = flags.repo ?? null;

  // Pass every line through as it arrives so the runner's own collector sees the live
  // Stream the agent's output through unchanged. Every result event carries the session's
  // cumulative usage, so price each one as it passes and append a provisional row: a run the
  // runner kills at its timeout never reaches EOF, and a ledger written only at EOF charged
  // flight 2's 120 minutes at $0. The final row at EOF supersedes the provisional ones
  // (ledgerSpend counts the last row per runId).
  const priceOrReserve = (byModel) => {
    if (!byModel) return null;
    try {
      return priceModelUsage(byModel, ceiling.pricesUsdPerMillion);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      process.stderr.write(`spend sluis: ${err.message}; charging the reserve\n`);
      return null;
    }
  };
  const rowFor = (stage, byModel) => {
    const usd = priceOrReserve(byModel);
    return {
      recordedAt: new Date().toISOString(),
      runId,
      model,
      stage,
      usage: byModel,
      usd: usd ?? reserveCharge(ceiling),
      priced: usd === null ? "reserve" : "list",
      priceBasis: ceiling.priceBasis,
      ...(issue === null ? {} : { issue }),
      ...(repo === null ? {} : { repo }),
    };
  };
  // A result event arrives only at the END of a print-mode session, so a run the runner kills
  // before that leaves no provisional row either (the deliberate strand of 2026-09-09: three
  // minutes of a foreman run, no row). Charge the reserve before the first byte; every later
  // row for this runId supersedes it, since ledgerSpend counts a run's last row.
  const started = rowFor("started", null);
  appendLedger(ledgerPath, started);
  process.stderr.write(`spend sluis: started ${runId} at the reserve ${started.usd.toFixed(2)} until a result event prices it\n`);
  let lastUsage = null;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    process.stdout.write(line + "\n");
    const byModel = parseUsage(line, model);
    if (!byModel) continue;
    lastUsage = byModel;
    const row = rowFor("provisional", byModel);
    appendLedger(ledgerPath, row);
    process.stderr.write(`spend sluis: provisional ${runId} at $${row.usd.toFixed(2)} (${row.priced})\n`);
  }
  const row = rowFor("final", lastUsage);
  appendLedger(ledgerPath, row);
  process.stderr.write(`spend sluis: recorded ${runId} at $${row.usd.toFixed(2)} (${row.priced})\n`);
  return 0;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === "check") return check(flags);
  if (command === "record") return record(flags);
  throw new Error(`usage: spend-ceiling.mjs check|record [--config path] [--ledger path] [--run-id id] [--model model] [--issue N --repo OWNER/REPO]`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`spend sluis: ${err.message}\n`);
      process.exit(EXIT_REFUSED);
    },
  );
}
