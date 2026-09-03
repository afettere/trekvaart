// Spec for the spend sluis. Run: node --test sluis/spend-ceiling.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  priceRun,
  parseUsage,
  priceModelUsage,
  reserveCharge,
  ledgerSpend,
  verdict,
  loadCeiling,
} from "./spend-ceiling.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "spend-ceiling.mjs");
const committedConfig = join(here, "ceiling.json");

const opus = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };

function tmp() {
  return mkdtempSync(join(tmpdir(), "sluis-"));
}
function writeConfig(dir, overrides = {}) {
  const base = JSON.parse(readFileSync(committedConfig, "utf8"));
  const p = join(dir, "ceiling.json");
  writeFileSync(p, JSON.stringify({ ...base, ...overrides }));
  return p;
}
function run(args, { input, env } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
function resultLine(usage) {
  return JSON.stringify({ type: "result", subtype: "success", usage }) + "\n";
}
const fullUsage = {
  input_tokens: 1_000_000,
  cache_creation_input_tokens: 2_000_000,
  cache_read_input_tokens: 10_000_000,
  output_tokens: 100_000,
};

// ---- priceRun

test("priceRun prices each class at its own rate, in dollars", () => {
  const usd = priceRun({ input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }, opus);
  assert.equal(usd, 5 + 6.25 + 0.5 + 25);
});

test("priceRun is not the output rate on the sum", () => {
  const usage = { input: 1_000_000, cacheWrite: 2_000_000, cacheRead: 10_000_000, output: 100_000 };
  const usd = priceRun(usage, opus);
  assert.equal(usd, 5 + 12.5 + 5 + 2.5);
  assert.notEqual(usd, 13.1 * 25);
});

test("priceRun rounds to cents at the boundary only", () => {
  assert.equal(priceRun({ input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }, opus), 0);
  assert.equal(priceRun({ input: 333_333, cacheWrite: 0, cacheRead: 0, output: 0 }, opus), 1.67);
});

test("priceRun refuses a negative, fractional or missing count", () => {
  assert.throws(() => priceRun({ input: -1, cacheWrite: 0, cacheRead: 0, output: 0 }, opus), RangeError);
  assert.throws(() => priceRun({ input: 1.5, cacheWrite: 0, cacheRead: 0, output: 0 }, opus), RangeError);
  assert.throws(() => priceRun({ input: 1, cacheWrite: 0, cacheRead: 0 }, opus), TypeError);
  assert.throws(() => priceRun({ input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }, { input: 5 }), TypeError);
});

// ---- parseUsage

test("parseUsage reads the four classes from the result event", () => {
  const stream = JSON.stringify({ type: "system", subtype: "init" }) + "\n" +
    JSON.stringify({ type: "assistant", message: {} }) + "\n" +
    resultLine(fullUsage);
  assert.deepEqual(parseUsage(stream, "claude-opus-5"), { "claude-opus-5": { input: 1_000_000, cacheWrite: 2_000_000, cacheRead: 10_000_000, output: 100_000 } });
});

test("parseUsage takes the last result event and ignores non-JSON lines", () => {
  const stream = "warming up\n" + resultLine({ ...fullUsage, output_tokens: 1 }) + "not json {\n" + resultLine(fullUsage) + "\n";
  assert.equal(parseUsage(stream, "claude-opus-5")["claude-opus-5"].output, 100_000);
});

test("parseUsage returns null when a class is missing or negative, or there is no result", () => {
  const { output_tokens, ...threeOnly } = fullUsage;
  assert.equal(parseUsage(resultLine(threeOnly), "m"), null);
  assert.equal(parseUsage(resultLine({ ...fullUsage, input_tokens: -5 }), "m"), null);
  assert.equal(parseUsage(JSON.stringify({ type: "assistant" }) + "\n", "m"), null);
  assert.equal(parseUsage("", "m"), null);
});

// ---- ceiling config

test("the committed ceiling is $60 over five flights on a priced model, and prices the subagent model too", () => {
  const c = loadCeiling(committedConfig);
  assert.equal(c.ceilingUsd, 60);
  assert.equal(c.flights, 5);
  assert.ok(c.pricesUsdPerMillion[c.model], "the named model has a price row");
  assert.ok(c.pricesUsdPerMillion["claude-haiku-4-5"], "Claude Code's Explore subagent runs on Haiku 4.5");
  assert.equal(reserveCharge(c), 12);
});

test("loadCeiling refuses a non-positive ceiling, a non-integer flight count, or an unpriced model", () => {
  const dir = tmp();
  assert.throws(() => loadCeiling(writeConfig(dir, { ceilingUsd: 0 })), RangeError);
  assert.throws(() => loadCeiling(writeConfig(dir, { ceilingUsd: "60" })), TypeError);
  assert.throws(() => loadCeiling(writeConfig(dir, { flights: 2.5 })), RangeError);
  assert.throws(() => loadCeiling(writeConfig(dir, { model: "claude-nothing" })), RangeError);
});

test("no environment variable can move the ceiling", () => {
  const before = loadCeiling(committedConfig).ceilingUsd;
  process.env.TREKVAART_CEILING_USD = "100000";
  process.env.CEILING_USD = "100000";
  try {
    assert.equal(loadCeiling(committedConfig).ceilingUsd, before);
  } finally {
    delete process.env.TREKVAART_CEILING_USD;
    delete process.env.CEILING_USD;
  }
});

// ---- ledger and verdict

test("ledgerSpend sums the dollar column and refuses a corrupt row", () => {
  assert.equal(ledgerSpend([{ usd: 1.25 }, { usd: 2.5 }]), 3.75);
  assert.equal(ledgerSpend([]), 0);
  assert.throws(() => ledgerSpend([{ usd: "1" }]), TypeError);
  assert.throws(() => ledgerSpend([{ usd: -1 }]), RangeError);
});

test("verdict allows below the ceiling and refuses at or above it", () => {
  assert.deepEqual(verdict({ spentUsd: 59.99, ceilingUsd: 60 }), { allowed: true, remainingUsd: 0.01 });
  assert.deepEqual(verdict({ spentUsd: 60, ceilingUsd: 60 }), { allowed: false, remainingUsd: 0 });
  assert.equal(verdict({ spentUsd: 61, ceilingUsd: 60 }).allowed, false);
});

// ---- CLI: check

test("check exits 0 with an empty or absent ledger and prints the remaining budget", () => {
  const dir = tmp();
  const r = run(["check", "--config", writeConfig(dir), "--ledger", join(dir, "ledger.jsonl")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /remaining \$60\.00 of \$60\.00/);
  assert.equal(r.stdout, "");
});

test("check exits 75 once the ledger reaches the ceiling, and says so", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, [{ usd: 30 }, { usd: 30 }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = run(["check", "--config", writeConfig(dir), "--ledger", ledger]);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /ceiling reached/);
});

test("check refuses when the ledger is unreadable rather than treating it as empty", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, '{"usd": 1}\nnot json\n');
  const r = run(["check", "--config", writeConfig(dir), "--ledger", ledger]);
  assert.equal(r.status, 75);
  assert.match(r.stderr, /ledger/);
});

test("check has no flag that raises the ceiling", () => {
  const dir = tmp();
  const r = run(["check", "--config", writeConfig(dir), "--ledger", join(dir, "l.jsonl"), "--ceiling", "1000"]);
  assert.notEqual(r.status, 0);
});

// ---- CLI: record

test("record passes the stream through byte for byte and appends a priced row", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const stream = "hello\n" + JSON.stringify({ type: "assistant" }) + "\n" + resultLine(fullUsage);
  const r = run(["record", "--config", writeConfig(dir), "--ledger", ledger, "--run-id", "run-1", "--model", "claude-opus-5"], { input: stream });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, stream);
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, "run-1");
  assert.equal(rows[0].model, "claude-opus-5");
  assert.equal(rows[0].priced, "list");
  assert.deepEqual(rows[0].usage, { "claude-opus-5": { input: 1_000_000, cacheWrite: 2_000_000, cacheRead: 10_000_000, output: 100_000 } });
  assert.equal(rows[0].usd, 25);
});

test("record charges the reserve when the stream carries no usable usage", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const r = run(["record", "--config", writeConfig(dir), "--ledger", ledger, "--run-id", "run-2", "--model", "claude-opus-5"], { input: "the agent crashed\n" });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(readFileSync(ledger, "utf8").trim());
  assert.equal(row.priced, "reserve");
  assert.equal(row.usd, 12);
  assert.equal(row.usage, null);
});

test("record refuses a model the ceiling does not price, without writing a row", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const r = run(["record", "--config", writeConfig(dir), "--ledger", ledger, "--run-id", "run-3", "--model", "claude-nothing"], { input: resultLine(fullUsage) });
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(ledger), false);
});

test("a recorded run moves the next check toward refusal", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const cfg = writeConfig(dir);
  for (let i = 0; i < 5; i++) {
    run(["record", "--config", cfg, "--ledger", ledger, "--run-id", `r${i}`, "--model", "claude-opus-5"], { input: "no usage\n" });
  }
  const r = run(["check", "--config", cfg, "--ledger", ledger]);
  assert.equal(r.status, 75);
});

// ---- modelUsage: the result event's top-level usage covers only the orchestrator's own
// turns; subagents show up only in modelUsage. Measured on the first smoke flight
// (2026-09-03): usage priced at $0.58, modelUsage at $1.29 for the same run.

const modelUsageEvent = {
  type: "result",
  usage: { input_tokens: 26, cache_creation_input_tokens: 26331, cache_read_input_tokens: 355531, output_tokens: 9605 },
  modelUsage: {
    "claude-opus-5": { inputTokens: 58, outputTokens: 19737, cacheReadInputTokens: 606441, cacheCreationInputTokens: 78608 },
    "claude-haiku-4-5-20251001": { inputTokens: 1916, outputTokens: 18, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  },
};

test("parseUsage prefers modelUsage and returns one entry per model", () => {
  const parsed = parseUsage(JSON.stringify(modelUsageEvent) + "\n");
  assert.deepEqual(parsed, {
    "claude-opus-5": { input: 58, cacheWrite: 78608, cacheRead: 606441, output: 19737 },
    "claude-haiku-4-5-20251001": { input: 1916, cacheWrite: 0, cacheRead: 0, output: 18 },
  });
});

test("parseUsage falls back to the single usage block under the run's model when modelUsage is absent", () => {
  const parsed = parseUsage(resultLine(fullUsage), "claude-opus-5");
  assert.deepEqual(parsed, { "claude-opus-5": { input: 1_000_000, cacheWrite: 2_000_000, cacheRead: 10_000_000, output: 100_000 } });
});

test("priceModelUsage sums every model at its own row and resolves dated ids to their price row", () => {
  const c = loadCeiling(committedConfig);
  const usd = priceModelUsage(parseUsage(JSON.stringify(modelUsageEvent) + "\n"), c.pricesUsdPerMillion);
  // opus: 58*5 + 78608*6.25 + 606441*0.5 + 19737*25 = 0.00029 + 0.4913 + 0.30322 + 0.49343 = 1.28824
  // haiku 4.5: 1916*1 + 18*5 = 0.001916 + 0.00009
  assert.equal(usd, 1.29);
});

test("priceModelUsage throws on a model with no price row, so the caller can charge the reserve", () => {
  assert.throws(() => priceModelUsage({ "claude-nothing": { input: 1, cacheWrite: 0, cacheRead: 0, output: 0 } }, opus && loadCeiling(committedConfig).pricesUsdPerMillion), RangeError);
});

test("record prices a subagent-heavy run from modelUsage, not the orchestrator's usage alone", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const r = run(["record", "--config", writeConfig(dir), "--ledger", ledger, "--run-id", "run-mu", "--model", "claude-opus-5"], { input: JSON.stringify(modelUsageEvent) + "\n" });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(readFileSync(ledger, "utf8").trim());
  assert.equal(row.priced, "list");
  assert.equal(row.usd, 1.29);
  assert.deepEqual(Object.keys(row.usage).sort(), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
});

test("record charges the reserve when modelUsage names a model the ceiling does not price", () => {
  const dir = tmp();
  const ledger = join(dir, "ledger.jsonl");
  const ev = { type: "result", modelUsage: { "claude-mystery-9": { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
  const r = run(["record", "--config", writeConfig(dir), "--ledger", ledger, "--run-id", "run-mu2", "--model", "claude-opus-5"], { input: JSON.stringify(ev) + "\n" });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(readFileSync(ledger, "utf8").trim());
  assert.equal(row.priced, "reserve");
  assert.equal(row.usd, 12);
});
