// Spec for the stranded-flight sweeper. Run: node --test sluis/stranded.test.mjs
//
// A flight that ends without posting leaves its issue at an in-flight label with nothing
// running for it: the runner will not re-admit it (it admits only `requested`) and a human's
// filter does not show it. Two pilot runs ended that way (a timeout kill and a silent exit).
// The wrapper repairs the label when the agent exits on its own; this sweeper covers the
// kill path, where nothing inside the process group survives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { strandedFlights, IN_FLIGHT_LABELS, parseIssueUrl, stopComment, exitVerdict, PR_MARKER } from "./stranded.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "stranded.mjs");

const now = new Date("2026-09-08T22:00:00Z");
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();

function issue(number, label, { updatedMinutesAgo = 60 } = {}) {
  return { number, labels: [label], updatedAt: minutesAgo(updatedMinutesAgo) };
}

// ---- the decision

test("the in-flight labels are planning, building and verifying, and nothing else", () => {
  assert.deepEqual([...IN_FLIGHT_LABELS].sort(), ["trekvaart:building", "trekvaart:planning", "trekvaart:verifying"]);
});

test("an in-flight issue with no live run is stranded and goes to needs-human", () => {
  const actions = strandedFlights({ issues: [issue(8138, "trekvaart:building")], active: [], now });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].issue, 8138);
  assert.equal(actions[0].from, "trekvaart:building");
  assert.equal(actions[0].to, "trekvaart:needs-human");
  assert.match(actions[0].reason, /no run/i);
});

test("an in-flight issue whose run is alive is left alone", () => {
  const active = [{ issue: 8138, pid: 4242, alive: true, runId: "run_a", startedAt: minutesAgo(30) }];
  assert.deepEqual(strandedFlights({ issues: [issue(8138, "trekvaart:verifying")], active, now }), []);
});

test("a marker whose process is dead does not count as a live run: that is the kill path", () => {
  const active = [{ issue: 8138, pid: 4242, alive: false, runId: "run_a", startedAt: minutesAgo(200) }];
  const actions = strandedFlights({ issues: [issue(8138, "trekvaart:building")], active, now });
  assert.equal(actions.length, 1);
  assert.match(actions[0].reason, /run_a/);
});

test("requested, ready-for-review, needs-human and blocked are never touched", () => {
  const issues = [
    issue(1, "trekvaart:requested"),
    issue(2, "trekvaart:ready-for-review"),
    issue(3, "trekvaart:needs-human"),
    issue(4, "trekvaart:blocked"),
    issue(5, "machinist:queued"),
  ];
  assert.deepEqual(strandedFlights({ issues, active: [], now }), []);
});

test("an issue labelled in-flight inside the grace period is not yet stranded: its run may still be starting", () => {
  const fresh = issue(9, "trekvaart:planning", { updatedMinutesAgo: 2 });
  assert.deepEqual(strandedFlights({ issues: [fresh], active: [], now, graceMinutes: 5 }), []);
  const past = issue(9, "trekvaart:planning", { updatedMinutesAgo: 6 });
  assert.equal(strandedFlights({ issues: [past], active: [], now, graceMinutes: 5 }).length, 1);
});

test("the sweeper never proposes requested: only a human re-admits a flight", () => {
  const actions = strandedFlights({ issues: [issue(8138, "trekvaart:building")], active: [], now });
  for (const a of actions) assert.notEqual(a.to, "trekvaart:requested");
});

test("strandedFlights refuses malformed input rather than sweeping on it", () => {
  assert.throws(() => strandedFlights({ issues: "nope", active: [], now }), TypeError);
  assert.throws(() => strandedFlights({ issues: [], active: null, now }), TypeError);
  assert.throws(() => strandedFlights({ issues: [], active: [], now: "today" }), TypeError);
  assert.throws(() => strandedFlights({ issues: [{ number: 1 }], active: [], now }), TypeError);
  assert.throws(() => strandedFlights({ issues: [{ number: 0, labels: [] }], active: [], now }), TypeError);
});

// ---- helpers shared with the wrapper

test("parseIssueUrl reads the issue Machinist renders into the prompt, and nothing looser", () => {
  assert.deepEqual(parseIssueUrl("Complete https://github.com/Indemnia/indemnia/issues/8138"), {
    owner: "Indemnia",
    repo: "indemnia",
    number: 8138,
    url: "https://github.com/Indemnia/indemnia/issues/8138",
  });
  assert.equal(parseIssueUrl("Complete https://github.com/Indemnia/indemnia/pull/8138"), null);
  assert.equal(parseIssueUrl("no url here"), null);
  assert.throws(() => parseIssueUrl(42), TypeError);
});

test("the stop comment names the exit, the label it found, and the one human action", () => {
  const text = stopComment({ from: "trekvaart:building", reason: "the agent exited 137", runId: "run_x" });
  assert.match(text, /trekvaart:building/);
  assert.match(text, /exited 137/);
  assert.match(text, /run_x/);
  assert.match(text, /trekvaart:requested/);
  assert.match(text, /<!-- trekvaart:stop -->/);
});

// ---- the exit verdict: what the wrapper does when the agent exits on its own

test("exitVerdict resumes only an exit 0 at verifying with the PR posted and budget left", () => {
  const base = { exitCode: 0, from: "trekvaart:verifying", hasPr: true, resumesLeft: 1 };
  assert.equal(exitVerdict(base), "resume");
  assert.equal(exitVerdict({ ...base, resumesLeft: 0 }), "repair");
  assert.equal(exitVerdict({ ...base, hasPr: false }), "repair");
  assert.equal(exitVerdict({ ...base, exitCode: 1 }), "repair");
  assert.equal(exitVerdict({ ...base, exitCode: null }), "repair");
  assert.equal(exitVerdict({ ...base, from: "trekvaart:building" }), "repair");
  assert.equal(exitVerdict({ ...base, from: null }), "none");
  assert.equal(PR_MARKER, "<!-- trekvaart:foreman-pr -->");
});

test("exitVerdict refuses malformed input", () => {
  assert.throws(() => exitVerdict({ exitCode: 0, from: "trekvaart:verifying", hasPr: "yes", resumesLeft: 1 }), TypeError);
  assert.throws(() => exitVerdict({ exitCode: 0, from: "trekvaart:verifying", hasPr: true, resumesLeft: -1 }), RangeError);
});

// ---- the CLI, through a fake gh

function fakeGh(dir, { issues = [], viewLabels = [], comments = [] } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "gh.log");
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "issue list") printf '%s' '${JSON.stringify(issues)}' ;;
  "issue view") printf '%s' '${JSON.stringify({ labels: viewLabels.map((name) => ({ name })), comments: comments.map((body) => ({ body })) })}' ;;
  *) : ;;
esac
`;
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

function marker(dir, { issue, pid, runId = "run_m", startedAt = minutesAgo(60) }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issue}.json`), JSON.stringify({ issue, pid, runId, startedAt, url: `https://github.com/o/r/issues/${issue}` }));
}

function runCli(args, { bin, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

test("sweep moves a stranded issue to needs-human with a stop comment, through gh", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, {
    issues: [{ number: 8138, labels: [{ name: "trekvaart:building" }], updatedAt: minutesAgo(90) }],
  });
  const markers = join(dir, "active");
  marker(markers, { issue: 8138, pid: 999999 }); // no such process
  const r = runCli(["sweep", "--repo", "o/r", "--markers", markers], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  const calls = gh.log();
  assert.ok(calls.some((c) => /issue edit 8138 .*--remove-label trekvaart:building.*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => /issue comment 8138/.test(c)), calls.join("\n"));
  assert.match(r.stderr, /8138/);
  // The marker has been read and acted on; leaving it would name a dead run forever
  // (the strand of 2026-09-09 left 6.json behind after the sweep).
  assert.equal(existsSync(join(markers, "8138.json")), false, "the acted-on marker is removed");
});

test("sweep leaves an issue with a live run alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, {
    issues: [{ number: 8138, labels: [{ name: "trekvaart:verifying" }], updatedAt: minutesAgo(90) }],
  });
  const markers = join(dir, "active");
  marker(markers, { issue: 8138, pid: process.pid }); // this test process is alive
  const r = runCli(["sweep", "--repo", "o/r", "--markers", markers], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!gh.log().some((c) => /issue edit/.test(c)), gh.log().join("\n"));
  assert.equal(existsSync(join(markers, "8138.json")), true, "a live run's marker stays");
});

test("sweep --dry-run prints the actions and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, {
    issues: [{ number: 8138, labels: [{ name: "trekvaart:building" }], updatedAt: minutesAgo(90) }],
  });
  const r = runCli(["sweep", "--repo", "o/r", "--markers", join(dir, "active"), "--dry-run"], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /8138.*trekvaart:building.*trekvaart:needs-human/);
  assert.ok(!gh.log().some((c) => /issue edit|issue comment/.test(c)));
});

test("sweep removes a dead marker whose issue is no longer in flight: the flight ended and the marker is spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, { issues: [] });
  const markers = join(dir, "active");
  marker(markers, { issue: 8138, pid: 999999 });
  const r = runCli(["sweep", "--repo", "o/r", "--markers", markers], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(markers, "8138.json")), false);
});

test("sweep refuses to run without --repo, and a gh failure is an error, not an empty sweep", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir);
  assert.notEqual(runCli(["sweep", "--markers", join(dir, "active")], { bin: gh.bin }).status, 0);
  const broken = join(dir, "broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "gh"), "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(join(broken, "gh"), 0o755);
  const r = runCli(["sweep", "--repo", "o/r", "--markers", join(dir, "active")], { bin: broken });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gh/);
});

test("repair swaps the label and comments when the agent exits with the issue in flight, and does nothing otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, { viewLabels: ["trekvaart:building", "cuj: 6-ops"] });
  const r = runCli(
    ["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "137", "--run-id", "run_k"],
    { bin: gh.bin },
  );
  assert.equal(r.status, 0, r.stderr);
  const calls = gh.log();
  assert.ok(calls.some((c) => /issue edit 8138 .*--remove-label trekvaart:building.*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => /^issue comment 8138 /.test(c)), calls.join("\n"));
  assert.match(calls.join("\n"), /exited 137/);

  const quiet = fakeGh(mkdtempSync(join(tmpdir(), "stranded-")), { viewLabels: ["trekvaart:ready-for-review"] });
  const r2 = runCli(["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "0", "--run-id", "run_k"], { bin: quiet.bin });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!quiet.log().some((c) => /issue edit|issue comment/.test(c)), quiet.log().join("\n"));
});

test("repair prints resume, and touches nothing, for a gate exit with budget; prints repaired once the budget is gone", () => {
  const pr = "<!-- trekvaart:foreman-pr -->\nPull request: https://github.com/o/r/pull/9";
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, { viewLabels: ["trekvaart:verifying"], comments: [pr] });
  const r = runCli(["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "0", "--run-id", "run_g", "--resume-budget", "2"], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "resume");
  assert.ok(!gh.log().some((c) => /issue edit|issue comment/.test(c)), gh.log().join("\n"));

  const spent = fakeGh(mkdtempSync(join(tmpdir(), "stranded-")), { viewLabels: ["trekvaart:verifying"], comments: [pr] });
  const r2 = runCli(["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "0", "--run-id", "run_g", "--resume-budget", "0", "--resumed", "3"], { bin: spent.bin });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), "repaired");
  const calls = spent.log();
  assert.ok(calls.some((c) => /--remove-label trekvaart:verifying.*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
  assert.match(calls.join("\n"), /3 resume/);
  assert.match(calls.join("\n"), /automation gate/i);
});

test("repair without --resume-budget behaves as before: a gate exit is repaired, and a terminal issue prints none", () => {
  const pr = "<!-- trekvaart:foreman-pr -->\nPull request: https://github.com/o/r/pull/9";
  const gh = fakeGh(mkdtempSync(join(tmpdir(), "stranded-")), { viewLabels: ["trekvaart:verifying"], comments: [pr] });
  const r = runCli(["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "0", "--run-id", "run_g"], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "repaired");
  const done = fakeGh(mkdtempSync(join(tmpdir(), "stranded-")), { viewLabels: ["trekvaart:ready-for-review"] });
  const r2 = runCli(["repair", "--issue", "https://github.com/o/r/issues/8138", "--exit", "0", "--run-id", "run_g"], { bin: done.bin });
  assert.equal(r2.stdout.trim(), "none");
});

test("sweep records its tick per repository in the ticks directory, so the board can read it without the journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "stranded-"));
  const gh = fakeGh(dir, { issues: [] });
  const ticks = join(dir, "ticks");
  const r = runCli(["sweep", "--repo", "o/r", "--markers", join(dir, "active"), "--ticks", ticks], { bin: gh.bin });
  assert.equal(r.status, 0, r.stderr);
  const tick = JSON.parse(readFileSync(join(ticks, "o__r.json"), "utf8"));
  assert.equal(tick.repo, "o/r");
  assert.ok(!Number.isNaN(Date.parse(tick.at)));
  assert.match(tick.line, /0 in-flight issue\(s\), none stranded/);
  assert.equal(tick.moved, 0);
});
