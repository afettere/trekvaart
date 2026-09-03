#!/usr/bin/env node
// The spend sluis: a refusing cap on what a pilot may spend on model calls.
//
//   check   exit 0 while recorded spend is below the ceiling, 75 once it is reached.
//   record  pass the agent's stream from stdin to stdout unchanged, then append one
//           priced row to the ledger from the stream's final usage event.
//
// The ceiling lives in ceiling.json beside this file and is derived from one constant.
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
const EXIT_REFUSED = 75;

function roundCents(usd) {
  return Math.round(usd * 100) / 100;
}

function assertCount(name, value) {
  if (typeof value !== "number") throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

export function priceRun(usage, prices) {
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
  return roundCents(usd);
}

export function parseUsage(streamText) {
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
    found = usageFromEvent(event);
  }
  return found;
}

function usageFromEvent(event) {
  const raw = event.usage;
  if (!raw || typeof raw !== "object") return null;
  const usage = {};
  for (const cls of CLASSES) {
    const value = raw[STREAM_KEYS[cls]];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    usage[cls] = value;
  }
  return usage;
}

export function loadCeiling(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed.ceilingUsd !== "number") throw new TypeError("ceilingUsd must be a number");
  if (!(parsed.ceilingUsd > 0)) throw new RangeError("ceilingUsd must be positive");
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

export function ledgerSpend(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row.usd !== "number") throw new TypeError("ledger row usd must be a number");
    if (!(row.usd >= 0)) throw new RangeError("ledger row usd must be non-negative");
    total += row.usd;
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

const KNOWN_FLAGS = new Set(["--config", "--ledger", "--run-id", "--model"]);

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
  const spentUsd = ledgerSpend(readLedger(ledgerPath));
  const v = verdict({ spentUsd, ceilingUsd: ceiling.ceilingUsd });
  if (!v.allowed) {
    process.stderr.write(
      `spend sluis: ceiling reached: $${spentUsd.toFixed(2)} recorded of a $${ceiling.ceilingUsd.toFixed(2)} ceiling in ${ledgerPath}; no flight starts until a human decides\n`,
    );
    return EXIT_REFUSED;
  }
  // stderr, so the runner's stdout stays the agent's stream alone
  process.stderr.write(`spend sluis: remaining $${v.remainingUsd.toFixed(2)} of $${ceiling.ceilingUsd.toFixed(2)} (ledger ${ledgerPath})\n`);
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

  // Pass every line through as it arrives so the runner's own collector sees the live
  // stream; keep the text to read the final usage event once the agent has exited.
  const chunks = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    process.stdout.write(line + "\n");
    chunks.push(line);
  }
  const usage = parseUsage(chunks.join("\n"));
  const row = {
    recordedAt: new Date().toISOString(),
    runId,
    model,
    usage,
    usd: usage ? priceRun(usage, prices) : reserveCharge(ceiling),
    priced: usage ? "list" : "reserve",
    priceBasis: ceiling.priceBasis,
  };
  appendLedger(ledgerPath, row);
  process.stderr.write(`spend sluis: recorded ${runId} at $${row.usd.toFixed(2)} (${row.priced})\n`);
  return 0;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === "check") return check(flags);
  if (command === "record") return record(flags);
  throw new Error(`usage: spend-ceiling.mjs check|record [--config path] [--ledger path] [--run-id id] [--model model]`);
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
