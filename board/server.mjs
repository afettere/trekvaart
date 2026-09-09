#!/usr/bin/env node
// The Trekvaart board: a read-only page for the box, beside Machinist's UI.
//
//   server.mjs [--listen 127.0.0.1:7332] [--refresh-seconds 60] [--config sluis/ceiling.json]
//              [--machinist-config ~/.machinist/config.toml] [--worker-config ~/.machinist/worker.toml]
//
// Serves one page and one JSON endpoint (/api/board). Every refresh reads the five sources
// (GitHub through the box's gh login, the ledger, the markers, the sweeper's tick files, the
// box itself), hands them to composeBoard, and caches the result for --refresh-seconds. A source
// that fails keeps its last good read and reports the failure beside it; the rest is current.
// Nothing here writes to GitHub, the ledger or the box.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { composeBoard } from "./compose.mjs";
import { loadCeiling } from "../sluis/spend-ceiling.mjs";
import { readMarkers, DEFAULT_MARKERS_DIR, DEFAULT_TICKS_DIR, PR_MARKER } from "../sluis/stranded.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const FLIGHT_LABELS = [
  "trekvaart:requested",
  "machinist:queued",
  "trekvaart:planning",
  "trekvaart:building",
  "trekvaart:verifying",
  "trekvaart:ready-for-review",
  "trekvaart:needs-human",
  "trekvaart:blocked",
];

// ---- flags

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) throw new Error(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    flags[flag.slice(2)] = value;
    i++;
  }
  return flags;
}

// ---- Machinist's own configuration, read for the repositories, the timeout and the cadence.
// A hand-rolled read of the few TOML lines we need; the schema is Machinist's and may move.

function readMachinistConfig(configPath, workerPath) {
  const out = { repos: [], timeoutMinutes: 240, sweepMinutes: 15, pollMinutes: 1, listen: "127.0.0.1:7331" };
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const worker = existsSync(workerPath) ? readFileSync(workerPath, "utf8") : "";
  const repoBlock = /\[github\.repositories\]([\s\S]*?)(?:\n\[|$)/.exec(config);
  if (repoBlock) {
    for (const line of repoBlock[1].split("\n")) {
      const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/.exec(line);
      if (m) out.repos.push({ short: m[1], slug: m[2] });
    }
  }
  const foreman = /\[commands\.foreman\]([\s\S]*?)(?:\n\[|$)/.exec(config);
  const timeout = foreman && /^\s*timeout\s*=\s*"(\d+)m"/m.exec(foreman[1]);
  if (timeout) out.timeoutMinutes = Number(timeout[1]);
  const cron = /\[triggers\.cron\.sweep[^\]]*\]([\s\S]*?)(?:\n\[|$)/.exec(config);
  const schedule = cron && /^\s*schedule\s*=\s*"\*\/(\d+) /m.exec(cron[1]);
  if (schedule) out.sweepMinutes = Number(schedule[1]);
  const every = /^\s*every\s*=\s*"(\d+)([sm])"/m.exec(config);
  if (every) out.pollMinutes = every[2] === "s" ? Math.max(1, Math.round(Number(every[1]) / 60)) : Number(every[1]);
  const listen = /^\s*listen\s*=\s*"([^"]+)"/m.exec(config);
  if (listen) out.listen = listen[1];
  void worker;
  return out;
}

// ---- sources

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  if (r.error) throw new Error(`gh could not be run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} exited ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

function readGitHub(repos) {
  const issues = [];
  const prs = [];
  for (const repo of repos) {
    const seen = new Map();
    for (const label of FLIGHT_LABELS) {
      const rows = gh(["issue", "list", "--repo", repo.slug, "--state", "open", "--label", label, "--limit", "100", "--json", "number,title,url,labels,updatedAt"]);
      for (const row of rows) seen.set(row.number, row);
    }
    for (const row of seen.values()) {
      const view = gh(["issue", "view", String(row.number), "--repo", repo.slug, "--json", "comments"]);
      const comments = (view.comments ?? []).map((c) => ({ body: c.body, createdAt: c.createdAt, url: c.url }));
      const labeledAt = labelTime(repo.slug, row.number, row.labels.map((l) => l.name));
      issues.push({ repo: repo.slug, number: row.number, title: row.title, url: row.url, labels: row.labels.map((l) => l.name), updatedAt: row.updatedAt, labeledAt, comments });
      const prComment = comments.find((c) => c.body.includes(PR_MARKER));
      const m = prComment && /\/pull\/(\d+)/.exec(prComment.body);
      if (m) prs.push(readPr(repo.slug, Number(m[1])));
    }
  }
  return { issues, prs };
}

// When the current lifecycle label was applied: the last `labeled` event for it on the timeline.
function labelTime(slug, number, labels) {
  const current = labels.find((l) => FLIGHT_LABELS.includes(l));
  if (!current) return null;
  try {
    const events = gh(["api", `repos/${slug}/issues/${number}/timeline`, "--paginate", "-q", `[.[] | select(.event == "labeled" and .label.name == "${current}") | .created_at]`]);
    const list = Array.isArray(events) ? events.flat() : [];
    return list.length ? list[list.length - 1] : null;
  } catch {
    return null;
  }
}

function readPr(slug, number) {
  const pr = gh(["pr", "view", String(number), "--repo", slug, "--json", "number,url,state,statusCheckRollup"]);
  const checks = { pass: 0, fail: 0, pending: 0 };
  for (const c of pr.statusCheckRollup ?? []) {
    const s = (c.conclusion || c.state || "").toUpperCase();
    if (s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED") checks.pass += 1;
    else if (s === "FAILURE" || s === "ERROR" || s === "TIMED_OUT" || s === "CANCELLED" || s === "ACTION_REQUIRED") checks.fail += 1;
    else checks.pending += 1;
  }
  return { repo: slug, number: pr.number, url: pr.url, state: pr.state, checks };
}

function readLedger(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`line ${i + 1} of ${path} is not JSON`);
    }
  }
  return rows;
}

function readMarkersWithRepo(dir) {
  const markers = readMarkers(dir);
  for (const m of markers) {
    try {
      const raw = JSON.parse(readFileSync(m.path, "utf8"));
      const slug = typeof raw.url === "string" && /github\.com\/([^/]+\/[^/]+)\/issues/.exec(raw.url)?.[1];
      if (slug) m.repo = slug;
    } catch {
      /* the marker was readable a moment ago; keep it without a repo */
    }
  }
  return markers;
}

function readSweeps(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
}

function readBox(machinist) {
  const box = { timeoutMinutes: machinist.timeoutMinutes, sweepMinutes: machinist.sweepMinutes, pollMinutes: machinist.pollMinutes };
  const tryRun = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      return null;
    }
  };
  box.controlPlane = probe(machinist.listen);
  box.gh = tryRun("gh", ["api", "user", "-q", ".login"]);
  box.trekvaart = tryRun("git", ["-C", join(here, ".."), "rev-parse", "--short", "HEAD"]);
  box.machinistVersion = tryRun("machinist", ["--version"]);
  box.node = tryRun("node", ["--version"]);
  return box;
}

function probe(listen) {
  const [host, port] = listen.split(":");
  const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", `http://${host}:${port}/`], { encoding: "utf8" });
  const code = Number(r.stdout);
  return { up: r.status === 0 && code > 0 && code < 500, listen };
}

// ---- the refresh, with last-good per source

function makeReader({ ceilingPath, ledgerPath, markersDir, ticksDir, machinist }) {
  const lastGood = {};
  const lastGoodAt = {};
  const read = (name, fn) => {
    try {
      const value = fn();
      lastGood[name] = value;
      lastGoodAt[name] = new Date().toISOString();
      return { value, error: null };
    } catch (err) {
      return { value: lastGood[name] ?? null, error: { message: err.message, at: new Date().toISOString(), lastGoodAt: lastGoodAt[name] ?? null } };
    }
  };
  return () => {
    const errors = {};
    const ceiling = loadCeiling(ceilingPath);
    const github = read("github", () => readGitHub(machinist.repos));
    if (github.error) errors.github = github.error;
    const ledger = read("ledger", () => readLedger(ledgerPath));
    if (ledger.error) errors.ledger = ledger.error;
    const markers = read("markers", () => readMarkersWithRepo(markersDir));
    if (markers.error) errors.markers = markers.error;
    const sweeps = read("sweeps", () => readSweeps(ticksDir));
    if (sweeps.error) errors.sweeps = sweeps.error;
    const box = readBox(machinist);
    return composeBoard({
      now: new Date(),
      ceiling,
      repos: machinist.repos,
      box,
      issues: github.value?.issues ?? [],
      prs: github.value?.prs ?? [],
      ledger: ledger.value ?? [],
      markers: markers.value ?? [],
      sweeps: sweeps.value ?? [],
      errors,
    });
  };
}

// ---- HTTP

export function startServer({ listen, refreshSeconds, reader, pagePath }) {
  const [host, port] = listen.split(":");
  let cache = null;
  let cachedAt = 0;
  const page = readFileSync(pagePath, "utf8");
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/api/board") {
      const nowMs = Date.now();
      if (!cache || nowMs - cachedAt > refreshSeconds * 1000) {
        try {
          cache = reader();
          cachedAt = nowMs;
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(cache));
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(Number(port), host);
  return server;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const flags = parseArgs(process.argv.slice(2));
  const ceilingPath = resolve(expandHome(flags.config ?? join(here, "..", "sluis", "ceiling.json")));
  const ceiling = loadCeiling(ceilingPath);
  const machinist = readMachinistConfig(
    resolve(expandHome(flags["machinist-config"] ?? "~/.machinist/config.toml")),
    resolve(expandHome(flags["worker-config"] ?? "~/.machinist/worker.toml")),
  );
  if (machinist.repos.length === 0) {
    process.stderr.write("board: no repositories found in Machinist's config; the flights block will be empty\n");
  }
  const reader = makeReader({
    ceilingPath,
    ledgerPath: resolve(expandHome(ceiling.ledger)),
    markersDir: resolve(expandHome(DEFAULT_MARKERS_DIR)),
    ticksDir: resolve(expandHome(DEFAULT_TICKS_DIR)),
    machinist,
  });
  const listen = flags.listen ?? "127.0.0.1:7332";
  startServer({ listen, refreshSeconds: Number(flags["refresh-seconds"] ?? 60), reader, pagePath: join(here, "page.html") });
  process.stderr.write(`board: listening on http://${listen} (reads every ${flags["refresh-seconds"] ?? 60} s; ${machinist.repos.length} repositories)\n`);
}
