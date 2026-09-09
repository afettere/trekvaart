// The board's composer: a pure function from what the server read to what the page shows.
//
//   composeBoard({ now, ceiling, repos, box, issues, prs, ledger, markers, sweeps, errors })
//
// The label is the state, the ledger is the cost, the sweeper is the witness: three sources,
// shown as three things, never blended into one invented status. Every state row in
// docs/ux/board-ux-spec.md pass 5 is decided here; the server only reads and hands in.
import { ledgerSpend } from "../sluis/spend-ceiling.mjs";
import { STOP_MARKER, PR_MARKER } from "../sluis/stranded.mjs";

export const STATE_MARKER = "<!-- trekvaart:foreman-state -->";

// Lifecycle order on the page: what is queued first, then what is moving, then what is done.
const FLIGHT_LABELS = [
  ["trekvaart:requested", "queued"],
  ["machinist:queued", "queued"],
  ["trekvaart:planning", "flight"],
  ["trekvaart:building", "flight"],
  ["trekvaart:verifying", "flight"],
  ["trekvaart:ready-for-review", "final-good"],
];
const ATTENTION_LABELS = new Set(["trekvaart:needs-human", "trekvaart:blocked"]);

const round2 = (n) => Math.round(n * 100) / 100;
const minutesBetween = (later, earlier) => Math.max(0, Math.round((later - earlier) / 60_000));

function assertDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${name} must be a Date`);
}
function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}
function parseTime(value) {
  if (value === undefined || value === null) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new TypeError(`unreadable time ${value}`);
  return t;
}

function labelNames(issue) {
  return issue.labels.map((l) => (typeof l === "string" ? l : l && l.name)).filter((n) => typeof n === "string");
}

// Markdown to a sentence: drop the HTML marker, bold and code marks, keep the first sentence.
function firstSentence(body) {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.*?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}

function commentWith(issue, marker) {
  const hits = issue.comments.filter((c) => c && typeof c.body === "string" && c.body.includes(marker));
  return hits.length ? hits[hits.length - 1] : null;
}

function stateFields(issue) {
  const c = commentWith(issue, STATE_MARKER);
  if (!c) return { stage: null, repairs: null };
  const cell = (name) => {
    const m = new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^|]*?)\\s*\\|`, "i").exec(c.body);
    return m ? m[1].replace(/\*/g, "").trim() : null;
  };
  const repairs = cell("repair count");
  const n = repairs === null ? null : parseInt(repairs, 10);
  return { stage: cell("stage"), repairs: Number.isInteger(n) ? n : null };
}

function prFor(issue, prs) {
  const c = commentWith(issue, PR_MARKER);
  if (!c) return null;
  const m = /\/pull\/(\d+)/.exec(c.body);
  if (!m) return null;
  const number = Number(m[1]);
  const pr = prs.find((p) => p.number === number && (!p.repo || p.repo === issue.repo));
  return {
    number,
    url: pr?.url ?? `https://github.com/${issue.repo}/pull/${number}`,
    state: pr?.state ?? null,
    checks: pr?.checks ?? null,
  };
}

// Rows for one run in file order; a run's figure is its last row (as the sluis counts it).
function runsFromLedger(ledger) {
  const runs = new Map();
  for (const row of ledger) {
    if (typeof row.usd !== "number") throw new TypeError("ledger row usd must be a number");
    const at = parseTime(row.recordedAt);
    const id = typeof row.runId === "string" && row.runId ? row.runId : null;
    if (!id) continue;
    let run = runs.get(id);
    if (!run) {
      run = { runId: id, startedAt: at, endedAt: null, usd: 0, priced: "list", issue: null, repo: null, lastAt: at };
      runs.set(id, run);
    }
    run.usd = row.usd;
    run.priced = row.priced === "reserve" ? "reserve" : "list";
    run.lastAt = at ?? run.lastAt;
    run.endedAt = row.stage === "final" ? at : null;
    if (Number.isInteger(row.issue)) run.issue = row.issue;
    if (typeof row.repo === "string") run.repo = row.repo;
  }
  return [...runs.values()];
}

export function composeBoard({ now, ceiling, repos, box, issues, prs, ledger, markers, sweeps, errors = {} }) {
  assertDate(now, "now");
  assertArray(issues, "issues");
  assertArray(prs, "prs");
  assertArray(ledger, "ledger");
  assertArray(markers, "markers");
  assertArray(sweeps, "sweeps");
  assertArray(repos, "repos");
  if (!ceiling || typeof ceiling.ceilingUsd !== "number" || !Number.isInteger(ceiling.windowDays) || !Number.isInteger(ceiling.flights)) {
    throw new TypeError("ceiling must carry ceilingUsd, windowDays and flights");
  }
  const timeoutMinutes = box?.timeoutMinutes ?? 240;
  const sweepMinutes = box?.sweepMinutes ?? 15;
  const pollMinutes = box?.pollMinutes ?? 1;
  const nowMs = now.getTime();
  const shortOf = (slug) => repos.find((r) => r.slug === slug)?.short ?? slug;

  for (const issue of issues) {
    if (!issue || typeof issue !== "object") throw new TypeError("each issue must be an object");
    if (!Number.isInteger(issue.number) || issue.number < 1) throw new TypeError("issue.number must be a positive integer");
    if (!Array.isArray(issue.labels)) throw new TypeError("issue.labels must be an array");
    if (!Array.isArray(issue.comments)) issue.comments = [];
  }

  // ---- sweeper: one line per registered repository
  const sweeper = repos.map((r) => {
    const ticks = sweeps.filter((s) => s.repo === r.slug && s.at);
    const latest = ticks.length ? ticks.reduce((a, b) => (parseTime(a.at) >= parseTime(b.at) ? a : b)) : null;
    const at = latest ? parseTime(latest.at) : null;
    const age = at === null ? null : minutesBetween(nowMs, at);
    const stale = at === null || age > 2 * sweepMinutes;
    const note = at === null ? "no tick yet" : stale ? `no tick in ${age} min` : null;
    return { repo: r.slug, repoShort: r.short, at: latest ? latest.at : null, line: latest ? latest.line : null, stale, note };
  });
  const lastSweepMs = sweeps.reduce((max, s) => Math.max(max, parseTime(s.at) ?? 0), 0);
  const lastSweepAt = lastSweepMs ? new Date(lastSweepMs).toISOString() : null;
  const sweepFor = (slug) => sweeper.find((s) => s.repo === slug);

  // ---- runs and markers
  const runs = runsFromLedger(ledger);
  const markerRun = new Map(markers.filter((m) => m.runId).map((m) => [m.runId, m]));
  for (const run of runs) {
    const m = markerRun.get(run.runId);
    if (m && run.issue === null && Number.isInteger(m.issue)) {
      run.issue = m.issue;
      if (typeof m.repo === "string") run.repo = m.repo;
    }
  }
  const markersFor = (issue) => markers.filter((m) => m.issue === issue.number && (!m.repo || m.repo === issue.repo));
  const runsFor = (issue) => runs.filter((r) => r.issue === issue.number && (!r.repo || r.repo === issue.repo));

  // ---- attention
  const attention = [];
  for (const issue of issues) {
    const names = labelNames(issue);
    const label = names.find((n) => ATTENTION_LABELS.has(n));
    const labeledAt = parseTime(issue.labeledAt) ?? parseTime(issue.updatedAt);
    if (label) {
      const stop = commentWith(issue, STOP_MARKER);
      const stateC = commentWith(issue, STATE_MARKER);
      const source = stop ?? stateC;
      const quote = source ? firstSentence(source.body) : label === "trekvaart:blocked" ? "The flight stopped on a runner, tool or credential failure." : "The flight stopped and left no comment.";
      attention.push({
        repo: issue.repo,
        repoShort: shortOf(issue.repo),
        number: issue.number,
        title: issue.title ?? "",
        url: issue.url,
        label,
        quote,
        stoppedAt: source?.createdAt ?? issue.updatedAt ?? null,
        commentUrl: source?.url ?? issue.url,
        action:
          label === "trekvaart:blocked"
            ? `Fix what the comment on #${issue.number} names, then re-label trekvaart:requested.`
            : `Read the stop comment on #${issue.number}, then re-label trekvaart:requested to run it again, or close it.`,
      });
      continue;
    }
    const age = labeledAt === null ? null : minutesBetween(nowMs, labeledAt);
    if (names.includes("trekvaart:requested") && age !== null && age > 2 * pollMinutes) {
      attention.push({
        repo: issue.repo,
        repoShort: shortOf(issue.repo),
        number: issue.number,
        title: issue.title ?? "",
        url: issue.url,
        label: "trekvaart:requested",
        quote: `Requested ${age} min ago and not admitted by Machinist.`,
        stoppedAt: issue.labeledAt ?? issue.updatedAt ?? null,
        commentUrl: issue.url,
        action: "Check the control plane is up and the labelling account has write access.",
      });
    } else if (names.includes("machinist:queued") && age !== null && age > pollMinutes && !markersFor(issue).some((m) => m.alive)) {
      attention.push({
        repo: issue.repo,
        repoShort: shortOf(issue.repo),
        number: issue.number,
        title: issue.title ?? "",
        url: issue.url,
        label: "machinist:queued",
        quote: `Admitted ${age} min ago and no run has started.`,
        stoppedAt: issue.labeledAt ?? issue.updatedAt ?? null,
        commentUrl: issue.url,
        action: "Check the worker is up and the spend sluis has room.",
      });
    }
  }
  attention.sort((a, b) => (parseTime(b.stoppedAt) ?? 0) - (parseTime(a.stoppedAt) ?? 0));

  // ---- flights
  const flights = [];
  for (const issue of issues) {
    const names = labelNames(issue);
    const hit = FLIGHT_LABELS.find(([label]) => names.includes(label));
    if (!hit) continue;
    const [label, cls] = hit;
    const labeledAt = parseTime(issue.labeledAt);
    const sinceMs = labeledAt ?? parseTime(issue.updatedAt);
    const live = markersFor(issue).find((m) => m.alive) ?? null;
    const dead = markersFor(issue).find((m) => !m.alive) ?? null;
    const inFlight = cls === "flight";
    let liveNote = null;
    let sweeperActsAt = null;
    if (inFlight && !live) {
      const sinceDead = dead?.startedAt ? parseTime(dead.startedAt) : sinceMs;
      liveNote = `no run alive since ${sinceDead === null ? "the label changed" : new Date(sinceDead).toISOString()}`;
      const tick = sweepFor(issue.repo);
      if (tick?.at) sweeperActsAt = new Date(parseTime(tick.at) + sweepMinutes * 60_000).toISOString();
    }
    const issueRuns = runsFor(issue).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const usd = round2(issueRuns.reduce((sum, r) => sum + r.usd, 0));
    const kinds = new Set(issueRuns.map((r) => r.priced));
    const kind = kinds.size === 0 ? "none" : kinds.size > 1 ? "mixed" : kinds.has("reserve") ? "reserve" : "priced";
    const { stage, repairs } = stateFields(issue);
    flights.push({
      repo: issue.repo,
      repoShort: shortOf(issue.repo),
      number: issue.number,
      title: issue.title ?? "",
      url: issue.url,
      label,
      cls,
      live: !!live,
      pid: live ? live.pid : null,
      liveNote,
      sweeperActsAt,
      sinceAt: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      sinceIsApprox: labeledAt === null,
      minutesInState: sinceMs === null ? null : minutesBetween(nowMs, sinceMs),
      timeoutMinutes,
      stage,
      repairs,
      pr: prFor(issue, prs),
      spend: { usd, kind, runs: issueRuns.length },
      runs: issueRuns.map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt === null ? null : new Date(r.startedAt).toISOString(),
        endedAt: r.endedAt === null ? null : new Date(r.endedAt).toISOString(),
        usd: r.usd,
        priced: r.priced,
      })),
    });
  }
  const order = new Map(FLIGHT_LABELS.map(([label], i) => [label, i]));
  flights.sort((a, b) => order.get(a.label) - order.get(b.label) || a.number - b.number);

  // ---- spend, agreeing with the sluis by construction
  const window = { now, windowDays: ceiling.windowDays };
  const spentUsd = ledgerSpend(ledger, window);
  const since = nowMs - ceiling.windowDays * 86_400_000;
  let pricedUsd = 0;
  let reserveUsd = 0;
  let pricedRuns = 0;
  let reserveRuns = 0;
  for (const run of runs) {
    if (run.lastAt !== null && run.lastAt < since) continue;
    if (run.priced === "reserve") {
      reserveUsd += run.usd;
      reserveRuns += 1;
    } else {
      pricedUsd += run.usd;
      pricedRuns += 1;
    }
  }
  const reservePerFlight = round2(ceiling.ceilingUsd / ceiling.flights);
  const leftUsd = round2(ceiling.ceilingUsd - spentUsd);
  const spend = {
    ceilingUsd: ceiling.ceilingUsd,
    windowDays: ceiling.windowDays,
    spentUsd,
    leftUsd,
    pricedUsd: round2(pricedUsd),
    pricedRuns,
    reserveUsd: round2(reserveUsd),
    reserveRuns,
    reservePerFlight,
    fits: Math.max(0, Math.floor(leftUsd / reservePerFlight)),
  };

  return {
    readAt: now.toISOString(),
    lastSweepAt,
    attention,
    flights,
    spend,
    sweeper,
    box: box ?? {},
    errors: Object.fromEntries(
      Object.entries(errors).map(([source, e]) => [source, { message: e?.message ?? String(e), at: e?.at ?? now.toISOString(), lastGoodAt: e?.lastGoodAt ?? null }]),
    ),
  };
}
