// Spec for the executor wrapper. Run: node --test runners/machinist/sluis-run.test.mjs
//
// Two things the pilot measured the wrapper must do beyond pricing:
//  1. Turn the agent CLI's own background-task ceiling off, so Machinist's timeout is the
//     only wall clock on a run (flight 3 died at the CLI's 600 s, ten minutes into a reach).
//  2. Repair a stranded lifecycle label when the agent exits on its own with the issue still
//     in flight (flight 3 ended with nothing posted and the issue at `building`).
// The wrapper also leaves a marker for the sweeper while the agent runs, so a kill that
// takes the whole process group can still be seen afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, "bin", "sluis-run");
const repoRoot = join(here, "..", "..");

function fixture({ agentExit = 0, viewLabels = ["trekvaart:building"], comments = [], readyAfterRuns = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sluis-run-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const ghLog = join(dir, "gh.log");
  const labelsFile = join(dir, "labels.json");
  writeFileSync(labelsFile, JSON.stringify(viewLabels));
  const view = (labels) => JSON.stringify({ labels: labels.map((name) => ({ name })), comments: comments.map((body) => ({ body })) });
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
case "$1 $2" in
  "issue view") node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({labels:l.map(n=>({name:n})),comments:${JSON.stringify(comments.map((body) => ({ body })))}}))' "${labelsFile}" ;;
  *) : ;;
esac
`,
  );
  void view;
  chmodSync(join(bin, "gh"), 0o755);
  // A stand-in agent: records the environment it was given and the prompt it read, emits
  // one result event so the sluis has something to price, and exits as told. It counts its
  // runs; after readyAfterRuns runs it flips the issue to ready-for-review, the way a
  // resumed foreman finishes the gate.
  const agentLog = join(dir, "agent.log");
  const runsLog = join(dir, "runs.log");
  writeFileSync(
    join(bin, "fake-agent"),
    `#!/usr/bin/env bash
prompt="$(cat)"
printf 'BG=%s\\nMARKERS=%s\\nPATH=%s\\nPROMPT=%s\\n' "\${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-unset}" "$(ls "\${TREKVAART_ACTIVE_DIR}" 2>/dev/null | tr '\\n' ' ')" "$PATH" "$prompt" > "${agentLog}"
printf '%s\\n' "\${MACHINIST_RUN_ID:-}" >> "${runsLog}"
runs="$(wc -l < "${runsLog}")"
if [[ ${readyAfterRuns} -gt 0 && "$runs" -ge ${readyAfterRuns} ]]; then printf '%s' '["trekvaart:ready-for-review"]' > "${labelsFile}"; fi
printf '%s\\n' '{"type":"result","subtype":"success","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}'
exit ${agentExit}
`,
  );
  chmodSync(join(bin, "fake-agent"), 0o755);
  const ceiling = JSON.parse(readFileSync(join(repoRoot, "sluis", "ceiling.json"), "utf8"));
  ceiling.ledger = join(dir, "ledger.jsonl");
  const config = join(dir, "ceiling.json");
  writeFileSync(config, JSON.stringify(ceiling));
  const markers = join(dir, "active");
  return {
    dir,
    bin,
    markers,
    config,
    ghCalls: () => (existsSync(ghLog) ? readFileSync(ghLog, "utf8").trim().split("\n") : []),
    agent: () => (existsSync(agentLog) ? readFileSync(agentLog, "utf8") : ""),
    runs: () => (existsSync(runsLog) ? readFileSync(runsLog, "utf8").trim().split("\n").filter(Boolean) : []),
    ledger: () => (existsSync(join(dir, "ledger.jsonl")) ? readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
  };
}

function runWrapper(f, { prompt = "Complete https://github.com/o/r/issues/8138", runId = "run_t", env = {} } = {}) {
  return spawnSync("bash", [wrapper, "fake-agent", "--model=claude-opus-5"], {
    input: prompt,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${f.bin}:${process.env.PATH}`,
      MACHINIST_RUN_ID: runId,
      TREKVAART_CEILING: f.config,
      TREKVAART_ACTIVE_DIR: f.markers,
    },
  });
}

test("the wrapper parses", () => {
  const r = spawnSync("bash", ["-n", wrapper], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the agent runs with the CLI's background-task ceiling turned off", () => {
  const f = fixture();
  const r = runWrapper(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.agent(), /^BG=0$/m);
});

test("the prompt reaches the agent unchanged, and the agent's stream reaches stdout", () => {
  const f = fixture();
  const r = runWrapper(f, { prompt: "Complete https://github.com/o/r/issues/8138" });
  assert.match(f.agent(), /PROMPT=Complete https:\/\/github.com\/o\/r\/issues\/8138/);
  assert.match(r.stdout, /"type":"result"/);
});

test("a marker for the issue exists while the agent runs and is gone after it exits", () => {
  const f = fixture();
  const r = runWrapper(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.agent(), /^MARKERS=8138\.json ?$/m);
  assert.deepEqual(existsSync(f.markers) ? readdirSync(f.markers) : [], []);
});

test("an agent that exits with the issue still in flight gets its label repaired and a stop comment", () => {
  const f = fixture({ agentExit: 3, viewLabels: ["trekvaart:building"] });
  const r = runWrapper(f, { runId: "run_exit3" });
  assert.equal(r.status, 3, "the agent's exit code is the wrapper's");
  const calls = f.ghCalls();
  assert.ok(calls.some((c) => /issue edit 8138 .*--remove-label trekvaart:building.*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => /^issue comment 8138 /.test(c)), calls.join("\n"));
  assert.match(calls.join("\n"), /run_exit3/);
  assert.match(calls.join("\n"), /exited 3/);
});

test("an agent that ends on a terminal label leaves the issue alone", () => {
  const f = fixture({ agentExit: 0, viewLabels: ["trekvaart:ready-for-review"] });
  const r = runWrapper(f);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!f.ghCalls().some((c) => /issue edit|issue comment/.test(c)), f.ghCalls().join("\n"));
});

test("a prompt that names no issue still runs, prices, and repairs nothing", () => {
  const f = fixture({ agentExit: 0 });
  const r = runWrapper(f, { prompt: "Run the smoke check" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!f.ghCalls().some((c) => /issue/.test(c)));
  assert.ok(existsSync(join(f.dir, "ledger.jsonl")), "the ledger row is still written");
});

test("the issue comes from the work request, not from the first URL in the rendered prompt", () => {
  // The foreman prompt's own header links its upstream and the adoption issue before the
  // <prompt> block. The first flight on the box keyed its marker and its exit repair on that
  // header link (#11866 in the product repo) instead of the issue Machinist rendered.
  const f = fixture({ agentExit: 3, viewLabels: ["trekvaart:building"] });
  const prompt = [
    "# Foreman",
    "> Adopted by decision A of the pilot (https://github.com/Indemnia/indemnia/issues/11866).",
    "",
    "<prompt>",
    "Complete https://github.com/o/r/issues/8138",
    "</prompt>",
  ].join("\n");
  const r = runWrapper(f, { prompt, runId: "run_hdr" });
  assert.equal(r.status, 3);
  assert.match(f.agent(), /^MARKERS=8138\.json ?$/m);
  const calls = f.ghCalls();
  assert.ok(!calls.some((c) => /11866/.test(c)), "the header's issue must never be touched:\n" + calls.join("\n"));
  assert.ok(calls.some((c) => /issue edit 8138 .*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
});

// ---- the automation gate: an agent that ends its turn while checks are pending.
//
// The first product flight (2026-09-09, #11997) opened its pull request, entered the CI wait,
// and exited 0 two minutes later with the issue at verifying and the PR comment posted. The
// foreman's own contract is to hold up to AUTOMATION_GATE_MINUTES; an early exit 0 there is a
// turn ending, not a strand. The wrapper resumes the foreman (its resume path revalidates the
// branch, the PR and the checks) a capped number of times before it calls it stranded.

const PR_COMMENT = "<!-- trekvaart:foreman-pr -->\nPull request: https://github.com/o/r/pull/9";

test("an agent that exits 0 at verifying with its PR posted is resumed until the issue is terminal", () => {
  const f = fixture({ agentExit: 0, viewLabels: ["trekvaart:verifying"], comments: [PR_COMMENT], readyAfterRuns: 2 });
  const r = runWrapper(f, { runId: "run_gate" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.runs(), ["run_gate", "run_gate-r1"], "one resume, under its own run id");
  assert.ok(!f.ghCalls().some((c) => /issue edit|issue comment/.test(c)), "nothing repaired:\n" + f.ghCalls().join("\n"));
  assert.match(r.stderr, /resum/i);
  const finals = f.ledger().filter((row) => row.stage === "final").map((row) => row.runId);
  assert.deepEqual(finals, ["run_gate", "run_gate-r1"], "each resume is priced as its own run");
});

test("resumes are capped at three; after that the label is repaired and the stop comment says how many", () => {
  const f = fixture({ agentExit: 0, viewLabels: ["trekvaart:verifying"], comments: [PR_COMMENT] });
  const r = runWrapper(f, { runId: "run_cap" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.runs(), ["run_cap", "run_cap-r1", "run_cap-r2", "run_cap-r3"]);
  const calls = f.ghCalls();
  assert.ok(calls.some((c) => /issue edit 8138 .*--remove-label trekvaart:verifying.*--add-label trekvaart:needs-human/.test(c)), calls.join("\n"));
  assert.match(calls.join("\n"), /3 resume/);
});

test("no resume without the PR comment: an exit 0 at verifying with nothing posted is repaired at once", () => {
  const f = fixture({ agentExit: 0, viewLabels: ["trekvaart:verifying"], comments: [] });
  const r = runWrapper(f, { runId: "run_nopr" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.runs(), ["run_nopr"]);
  assert.ok(f.ghCalls().some((c) => /--add-label trekvaart:needs-human/.test(c)));
});

test("a non-zero exit is never resumed, PR or not", () => {
  const f = fixture({ agentExit: 3, viewLabels: ["trekvaart:verifying"], comments: [PR_COMMENT] });
  const r = runWrapper(f, { runId: "run_err" });
  assert.equal(r.status, 3);
  assert.deepEqual(f.runs(), ["run_err"]);
  assert.ok(f.ghCalls().some((c) => /--add-label trekvaart:needs-human/.test(c)));
});

test("an exit 0 at building is not a gate exit: repaired, not resumed", () => {
  const f = fixture({ agentExit: 0, viewLabels: ["trekvaart:building"], comments: [PR_COMMENT] });
  const r = runWrapper(f, { runId: "run_bld" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.runs(), ["run_bld"]);
  assert.ok(f.ghCalls().some((c) => /--remove-label trekvaart:building.*--add-label trekvaart:needs-human/.test(c)));
});

// ---- the runtime user's own tools first. The box's distro Node is 18 and carries no npm; the
// bootstrap installs Node 24 for the runtime user under ~/.local/bin, and the worker's PATH
// order is the distro's. The wrapper puts ~/.local/bin first so a flight's `node`, `npm` and
// `npx` are the runtime user's, and `npm run verify` can run in a worktree at all.

test("the agent sees ~/.local/bin first on PATH when it exists", () => {
  const f = fixture();
  mkdirSync(join(f.dir, ".local", "bin"), { recursive: true });
  const r = runWrapper(f, { env: { HOME: f.dir } });
  assert.equal(r.status, 0, r.stderr);
  const path = /^PATH=(.*)$/m.exec(f.agent())?.[1] ?? "";
  assert.equal(path.split(":")[0], join(f.dir, ".local", "bin"), path);
});
