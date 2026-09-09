// Spec for the board's composer: a pure function from the five sources to the page's view
// model. Run: node --test board/compose.test.mjs
//
// Every state row in docs/ux/board-ux-spec.md pass 5 is a case here; the server only reads
// files and gh and hands the results in, so this is where the page's truth is decided.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeBoard } from "./compose.mjs";
import { ledgerSpend } from "../sluis/spend-ceiling.mjs";

const now = new Date("2026-09-09T21:31:00Z");
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();
const ceiling = { ceilingUsd: 250, windowDays: 30, flights: 15 };
const repos = [
  { slug: "Indemnia/indemnia", short: "indemnia" },
  { slug: "afettere/trekvaart-evals", short: "evals" },
];
const box = { timeoutMinutes: 240, sweepMinutes: 15, pollMinutes: 1 };

function issue(number, labels, extra = {}) {
  return {
    repo: "Indemnia/indemnia",
    number,
    title: `Issue ${number}`,
    url: `https://github.com/Indemnia/indemnia/issues/${number}`,
    labels,
    updatedAt: minutesAgo(60),
    comments: [],
    ...extra,
  };
}
const stop = (minutes, from = "trekvaart:planning") => ({
  body: `<!-- trekvaart:stop -->\n**Flight stopped without posting.** The issue carried \`${from}\` and no run is alive for this issue: run run_22e5 (pid 6568) is gone.\n\nRun: \`run_22e5\`.`,
  createdAt: minutesAgo(minutes),
});
const state = (stage, repairs = 0) => ({
  body: `<!-- trekvaart:foreman-state -->\n**Foreman state**\n\n| field | value |\n|---|---|\n| stage | ${stage} |\n| repair count | ${repairs} |`,
  createdAt: minutesAgo(30),
});
const prComment = (n) => ({ body: `<!-- trekvaart:foreman-pr -->\nPull request: https://github.com/Indemnia/indemnia/pull/${n}`, createdAt: minutesAgo(20) });

function row(runId, stage, usd, minutes, extra = {}) {
  return { recordedAt: minutesAgo(minutes), runId, stage, usd, priced: stage === "started" ? "reserve" : "list", ...extra };
}

const base = () => ({ now, ceiling, repos, box, issues: [], prs: [], ledger: [], markers: [], sweeps: [], errors: {} });

// ---- waiting on you

test("a needs-human issue is first on the page, with the stop comment's first sentence and its times", () => {
  const view = composeBoard({ ...base(), issues: [issue(6, ["trekvaart:needs-human"], { repo: "afettere/trekvaart-evals", comments: [stop(38)] })] });
  assert.equal(view.attention.length, 1);
  const a = view.attention[0];
  assert.equal(a.number, 6);
  assert.equal(a.repoShort, "evals");
  assert.equal(a.label, "trekvaart:needs-human");
  assert.match(a.quote, /^Flight stopped without posting\./);
  assert.equal(a.stoppedAt, minutesAgo(38));
  assert.match(a.action, /trekvaart:requested/);
});

test("a blocked issue is also waiting on you; ready-for-review is not", () => {
  const view = composeBoard({ ...base(), issues: [issue(1, ["trekvaart:blocked"]), issue(2, ["trekvaart:ready-for-review"])] });
  assert.deepEqual(view.attention.map((a) => a.number), [1]);
});

test("a requested issue nobody admitted after two poll intervals is waiting on you; a fresh one is not", () => {
  const stale = issue(3, ["trekvaart:requested"], { labeledAt: minutesAgo(5) });
  const fresh = issue(4, ["trekvaart:requested"], { labeledAt: minutesAgo(1) });
  const view = composeBoard({ ...base(), issues: [stale, fresh] });
  assert.deepEqual(view.attention.map((a) => a.number), [3]);
  assert.match(view.attention[0].quote, /not admitted/i);
});

test("with nothing waiting, attention is empty and carries the last sweep time", () => {
  const view = composeBoard({ ...base(), sweeps: [{ repo: "Indemnia/indemnia", at: minutesAgo(1), line: "stranded: 0 in-flight issue(s), none stranded" }] });
  assert.deepEqual(view.attention, []);
  assert.equal(view.lastSweepAt, minutesAgo(1));
});

// ---- flights

test("open issues with a trekvaart or machinist label are flights, classed by state, in the label order of the lifecycle", () => {
  const view = composeBoard({
    ...base(),
    issues: [
      issue(10, ["trekvaart:ready-for-review", "type: bug"]),
      issue(11, ["machinist:queued"]),
      issue(12, ["trekvaart:building"]),
      issue(13, ["phase: ready"]),
    ],
  });
  assert.deepEqual(view.flights.map((f) => [f.number, f.label, f.cls]), [
    [11, "machinist:queued", "queued"],
    [12, "trekvaart:building", "flight"],
    [10, "trekvaart:ready-for-review", "final-good"],
  ]);
});

test("a flight with a live marker shows its pid; one without says since when no run is behind it and when the sweeper acts", () => {
  const live = issue(12, ["trekvaart:building"], { labeledAt: minutesAgo(7) });
  const dead = issue(14, ["trekvaart:verifying"], { labeledAt: minutesAgo(29) });
  const markers = [
    { issue: 12, pid: 7412, alive: true, runId: "run_a", startedAt: minutesAgo(7) },
    { issue: 14, pid: 7000, alive: false, runId: "run_b", startedAt: minutesAgo(29) },
  ];
  const sweeps = [{ repo: "Indemnia/indemnia", at: minutesAgo(1), line: "stranded: 2 in-flight issue(s), none stranded" }];
  const view = composeBoard({ ...base(), issues: [live, dead], markers, sweeps });
  const [f12, f14] = view.flights;
  assert.equal(f12.live, true);
  assert.equal(f12.pid, 7412);
  assert.equal(f12.minutesInState, 7);
  assert.equal(f12.timeoutMinutes, 240);
  assert.equal(f14.live, false);
  assert.match(f14.liveNote, /no run alive/i);
  assert.equal(f14.sweeperActsAt, new Date(new Date(minutesAgo(1)).getTime() + 15 * 60_000).toISOString());
});

test("stage and repair count come from the state comment; the PR from the PR comment, with its checks", () => {
  const i = issue(15, ["trekvaart:verifying"], { comments: [state("ci (automation gate)", 1), prComment(12092)] });
  const prs = [{ repo: "Indemnia/indemnia", number: 12092, url: "https://github.com/Indemnia/indemnia/pull/12092", state: "OPEN", checks: { pass: 17, fail: 0, pending: 2 } }];
  const view = composeBoard({ ...base(), issues: [i], prs });
  const f = view.flights[0];
  assert.equal(f.stage, "ci (automation gate)");
  assert.equal(f.repairs, 1);
  assert.equal(f.pr.number, 12092);
  assert.deepEqual(f.pr.checks, { pass: 17, fail: 0, pending: 2 });
  const bare = composeBoard({ ...base(), issues: [issue(16, ["trekvaart:planning"])] }).flights[0];
  assert.equal(bare.stage, null);
  assert.equal(bare.pr, null);
});

test("a flight's spend is the sum of its runs' last rows; a run with only a started row is at the reserve, not yet priced", () => {
  const ledger = [
    row("run_x", "started", 16.67, 40, { issue: 12100 }),
    row("run_x", "provisional", 1.1, 30, { issue: 12100 }),
    row("run_x", "final", 2.92, 20, { issue: 12100 }),
    row("run_y", "started", 16.67, 5, { issue: 12100 }),
    row("run_z", "final", 9.99, 10, { issue: 999 }),
  ];
  const view = composeBoard({ ...base(), issues: [issue(12100, ["trekvaart:building"])], ledger });
  const f = view.flights[0];
  assert.equal(f.spend.usd, 19.59);
  assert.equal(f.spend.kind, "mixed");
  assert.deepEqual(f.runs.map((r) => [r.runId, r.usd, r.priced, r.endedAt === null]), [
    ["run_x", 2.92, "list", false],
    ["run_y", 16.67, "reserve", true],
  ]);
});

test("a live marker joins a run to its issue when the ledger row carries no issue", () => {
  const ledger = [row("run_m", "started", 16.67, 3)];
  const markers = [{ issue: 12100, pid: 1, alive: true, runId: "run_m", startedAt: minutesAgo(3) }];
  const view = composeBoard({ ...base(), issues: [issue(12100, ["trekvaart:building"])], ledger, markers });
  assert.equal(view.flights[0].spend.usd, 16.67);
  assert.equal(view.flights[0].spend.kind, "reserve");
});

// ---- spend

test("the spend block agrees with the sluis: left equals the ceiling minus ledgerSpend over the same window", () => {
  const ledger = [
    row("run_old", "final", 50, 31 * 24 * 60),
    row("run_1", "final", 14.27, 90),
    row("run_2", "started", 16.67, 60),
    row("run_2", "final", 2.92, 50),
    row("run_3", "started", 16.67, 2),
  ];
  const view = composeBoard({ ...base(), ledger });
  const spent = ledgerSpend(ledger, { now, windowDays: 30 });
  assert.equal(view.spend.spentUsd, spent);
  assert.equal(view.spend.leftUsd, Math.round((250 - spent) * 100) / 100);
  assert.equal(view.spend.pricedUsd, 17.19);
  assert.equal(view.spend.pricedRuns, 2);
  assert.equal(view.spend.reserveUsd, 16.67);
  assert.equal(view.spend.reserveRuns, 1);
  assert.equal(view.spend.reservePerFlight, 16.67);
  assert.equal(view.spend.fits, Math.floor(view.spend.leftUsd / 16.67));
});

test("an empty ledger is an empty spend block, at zero, not an error", () => {
  const view = composeBoard(base());
  assert.equal(view.spend.spentUsd, 0);
  assert.equal(view.spend.leftUsd, 250);
  assert.equal(view.spend.pricedRuns, 0);
});

// ---- sweeper and errors

test("the sweeper block has one line per repository, marking one that missed two ticks as stale", () => {
  const sweeps = [
    { repo: "Indemnia/indemnia", at: minutesAgo(1), line: "stranded: 1 in-flight issue(s), none stranded" },
    { repo: "afettere/trekvaart-evals", at: minutesAgo(32), line: "stranded: 0 in-flight issue(s), none stranded" },
  ];
  const view = composeBoard({ ...base(), sweeps });
  assert.deepEqual(view.sweeper.map((s) => [s.repoShort, s.stale]), [["indemnia", false], ["evals", true]]);
  assert.match(view.sweeper[1].note, /no tick in 32 min/);
  const none = composeBoard(base());
  assert.deepEqual(none.sweeper.map((s) => [s.repoShort, s.at, s.stale]), [["indemnia", null, true], ["evals", null, true]]);
});

test("a failed source degrades only its block: the error names the source, the time and the last good read, and the rest is composed", () => {
  const ledger = [row("run_1", "final", 3, 10)];
  const view = composeBoard({ ...base(), ledger, errors: { github: { message: "gh exited 1", at: minutesAgo(0), lastGoodAt: minutesAgo(1) } } });
  assert.equal(view.errors.github.message, "gh exited 1");
  assert.equal(view.errors.github.lastGoodAt, minutesAgo(1));
  assert.equal(view.spend.spentUsd, 3);
  assert.deepEqual(view.flights, []);
});

test("composeBoard refuses malformed input rather than drawing a wrong board", () => {
  assert.throws(() => composeBoard({ ...base(), now: "today" }), TypeError);
  assert.throws(() => composeBoard({ ...base(), issues: "nope" }), TypeError);
  assert.throws(() => composeBoard({ ...base(), ledger: [{ runId: "r", usd: "3" }] }), TypeError);
  assert.throws(() => composeBoard({ ...base(), issues: [{ number: 0, labels: [] }] }), TypeError);
});
