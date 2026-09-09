#!/usr/bin/env node
// The stranded-flight sweeper: a flight that ends without posting leaves its issue at an
// in-flight label with nothing running for it. The runner re-admits only `requested`, so the
// issue is invisible to it, and it is invisible to a human's filter too. Two pilot runs ended
// that way: one killed by the runner at its timeout, one that exited on its own.
//
//   sweep   --repo OWNER/REPO [--markers DIR] [--grace-minutes N] [--dry-run]
//           Every issue carrying planning, building or verifying with no live run for it is
//           moved to needs-human with a stop comment. Meant to run from the runner's own cron
//           trigger, since a kill takes the whole process group and nothing inside it can do
//           this afterwards.
//   repair  --issue URL --exit CODE --run-id ID
//           One issue, on the executor wrapper's behalf at the agent's own exit: if the issue
//           still carries an in-flight label, swap it for needs-human and comment.
//
// Liveness is a marker file per issue in the markers directory, written by the wrapper before
// the agent starts and removed when it exits; a marker whose pid is dead is a killed run.
// The sweeper never sets `requested`: only a human re-admits a flight.
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const IN_FLIGHT_LABELS = new Set(["trekvaart:planning", "trekvaart:building", "trekvaart:verifying"]);
export const STOP_LABEL = "trekvaart:needs-human";
export const STOP_MARKER = "<!-- trekvaart:stop -->";
export const DEFAULT_MARKERS_DIR = "~/.trekvaart/active";
export const DEFAULT_GRACE_MINUTES = 5;

// ---- the decision

function assertIssue(issue) {
  if (!issue || typeof issue !== "object") throw new TypeError("each issue must be an object");
  if (!Number.isInteger(issue.number) || issue.number < 1) throw new TypeError("issue.number must be a positive integer");
  if (!Array.isArray(issue.labels)) throw new TypeError("issue.labels must be an array");
}

function labelNames(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l && l.name)).filter((n) => typeof n === "string");
}

function inFlightLabel(issue) {
  const names = labelNames(issue);
  return names.find((n) => IN_FLIGHT_LABELS.has(n)) ?? null;
}

/**
 * Which in-flight issues have no live run, and where each goes.
 *
 * @param {{ issues: Array<{number:number, labels:Array<string|{name:string}>, updatedAt?:string}>,
 *           active: Array<{issue:number, pid?:number, alive:boolean, runId?:string, startedAt?:string}>,
 *           now: Date, graceMinutes?: number }} input
 * @returns {Array<{issue:number, from:string, to:string, reason:string, runId:string|null}>}
 */
export function strandedFlights({ issues, active, now, graceMinutes = DEFAULT_GRACE_MINUTES }) {
  if (!Array.isArray(issues)) throw new TypeError("issues must be an array");
  if (!Array.isArray(active)) throw new TypeError("active must be an array");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("now must be a Date");
  if (typeof graceMinutes !== "number" || !(graceMinutes >= 0)) throw new RangeError("graceMinutes must be a non-negative number");

  const liveByIssue = new Map();
  const deadByIssue = new Map();
  for (const run of active) {
    if (!run || typeof run !== "object" || !Number.isInteger(run.issue)) throw new TypeError("each active entry must name an issue");
    (run.alive === true ? liveByIssue : deadByIssue).set(run.issue, run);
  }

  const actions = [];
  for (const issue of issues) {
    assertIssue(issue);
    const from = inFlightLabel(issue);
    if (!from) continue;
    if (liveByIssue.has(issue.number)) continue;
    if (typeof issue.updatedAt === "string") {
      const updated = Date.parse(issue.updatedAt);
      if (Number.isNaN(updated)) throw new TypeError(`issue #${issue.number} has an unreadable updatedAt`);
      if (now.getTime() - updated < graceMinutes * 60_000) continue;
    }
    const dead = deadByIssue.get(issue.number) ?? null;
    const reason = dead
      ? `no run is alive for this issue: run ${dead.runId ?? "(unknown)"} (pid ${dead.pid ?? "?"}) is gone, so the runner ended it without the flight posting`
      : "no run is recorded for this issue while it carries an in-flight label";
    actions.push({ issue: issue.number, from, to: STOP_LABEL, reason, runId: dead?.runId ?? null });
  }
  return actions;
}

// ---- helpers shared with the wrapper

const ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/;

export function parseIssueUrl(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const m = ISSUE_URL.exec(text);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]), url: m[0] };
}

export function stopComment({ from, reason, runId }) {
  return [
    STOP_MARKER,
    `**Flight stopped without posting.** The issue carried \`${from}\` and ${reason}.`,
    "",
    `Run: \`${runId ?? "unknown"}\`. Moved to \`${STOP_LABEL}\` so the flight is visible again.`,
    "",
    "Next human action: read the run's journal on the box, fix what ended it, then re-label `trekvaart:requested` to run the flight again. It resumes from what is already on the branch and the issue.",
  ].join("\n");
}

// ---- gh

function gh(args, { input } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", input });
  if (r.error) throw new Error(`gh could not be run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${r.status}: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function ghJson(args) {
  const out = gh(args);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`gh ${args.slice(0, 2).join(" ")} returned something that is not JSON`);
  }
}

function listInFlightIssues(repo) {
  const seen = new Map();
  for (const label of IN_FLIGHT_LABELS) {
    const rows = ghJson(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", "100", "--json", "number,labels,updatedAt"]);
    if (!Array.isArray(rows)) throw new Error("gh issue list did not return a list");
    for (const row of rows) seen.set(row.number, row);
  }
  return [...seen.values()];
}

function applyAction(repo, action, { dryRun }) {
  const line = `#${action.issue}: ${action.from} -> ${action.to} (${action.reason})`;
  if (dryRun) {
    process.stdout.write(`would move ${line}\n`);
    return;
  }
  gh(["issue", "edit", String(action.issue), "--repo", repo, "--remove-label", action.from, "--add-label", action.to]);
  gh(["issue", "comment", String(action.issue), "--repo", repo, "--body", stopComment(action)]);
  process.stderr.write(`stranded: moved ${line}\n`);
}

// ---- markers

function expandHome(p) {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

export function readMarkers(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      throw new Error(`marker ${join(dir, name)} is not JSON`);
    }
    if (!Number.isInteger(marker.issue)) throw new Error(`marker ${name} names no issue`);
    out.push({ issue: marker.issue, pid: marker.pid, runId: marker.runId ?? null, startedAt: marker.startedAt ?? null, alive: processAlive(marker.pid), path: join(dir, name) });
  }
  return out;
}

// A dead marker is spent once the sweep has acted on its issue, or once its issue no longer
// carries an in-flight label at all (the flight ended some other way). Left behind, it names
// a dead run forever; the strand of 2026-09-09 left 6.json after the sweep that used it. A
// dead marker inside the grace period stays, so the next tick can still name its run.
function removeSpentMarkers(active, issues, actions) {
  const acted = new Set(actions.map((a) => a.issue));
  const inFlight = new Set(issues.map((i) => i.number));
  for (const run of active) {
    if (run.alive || !run.path) continue;
    if (acted.has(run.issue) || !inFlight.has(run.issue)) rmSync(run.path, { force: true });
  }
}

// ---- CLI

const KNOWN_FLAGS = new Set(["--repo", "--markers", "--grace-minutes", "--issue", "--exit", "--run-id"]);
const KNOWN_SWITCHES = new Set(["--dry-run"]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (KNOWN_SWITCHES.has(flag)) {
      flags[flag.slice(2)] = true;
      continue;
    }
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown argument ${flag}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
    i++;
  }
  return { command, flags };
}

function sweep(flags) {
  if (!flags.repo) throw new Error("--repo OWNER/REPO is required");
  const markers = resolve(expandHome(flags.markers ?? DEFAULT_MARKERS_DIR));
  const graceMinutes = flags["grace-minutes"] === undefined ? DEFAULT_GRACE_MINUTES : Number(flags["grace-minutes"]);
  const issues = listInFlightIssues(flags.repo);
  const active = readMarkers(markers);
  const actions = strandedFlights({ issues, active, now: new Date(), graceMinutes });
  const dryRun = flags["dry-run"] === true;
  if (actions.length === 0) {
    process.stderr.write(`stranded: ${issues.length} in-flight issue(s), none stranded\n`);
  }
  for (const action of actions) applyAction(flags.repo, action, { dryRun });
  if (!dryRun) removeSpentMarkers(active, issues, actions);
  return 0;
}

function repair(flags) {
  if (!flags.issue) throw new Error("--issue URL is required");
  const issue = parseIssueUrl(flags.issue);
  if (!issue) throw new Error(`--issue must be a GitHub issue URL, got ${flags.issue}`);
  const exitCode = flags.exit === undefined ? null : Number(flags.exit);
  const repo = `${issue.owner}/${issue.repo}`;
  const view = ghJson(["issue", "view", String(issue.number), "--repo", repo, "--json", "labels"]);
  const from = inFlightLabel({ number: issue.number, labels: Array.isArray(view.labels) ? view.labels : [] });
  if (!from) {
    process.stderr.write(`stranded: #${issue.number} is not in flight; nothing to repair\n`);
    return 0;
  }
  const action = {
    issue: issue.number,
    from,
    to: STOP_LABEL,
    reason: `the agent exited ${exitCode ?? "(code unknown)"} with nothing posted`,
    runId: flags["run-id"] ?? null,
  };
  applyAction(repo, action, { dryRun: false });
  return 0;
}

async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (command === "sweep") return sweep(flags);
  if (command === "repair") return repair(flags);
  throw new Error("usage: stranded.mjs sweep --repo OWNER/REPO [--markers DIR] [--grace-minutes N] [--dry-run] | repair --issue URL --exit CODE --run-id ID");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`stranded: ${err.message}\n`);
      process.exit(1);
    },
  );
}
