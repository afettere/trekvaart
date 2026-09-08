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

function fixture({ agentExit = 0, viewLabels = ["trekvaart:building"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sluis-run-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const ghLog = join(dir, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
case "$1 $2" in
  "issue view") printf '%s' '${JSON.stringify({ labels: viewLabels.map((name) => ({ name })) })}' ;;
  *) : ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  // A stand-in agent: records the environment it was given and the prompt it read, emits
  // one result event so the sluis has something to price, and exits as told.
  const agentLog = join(dir, "agent.log");
  writeFileSync(
    join(bin, "fake-agent"),
    `#!/usr/bin/env bash
prompt="$(cat)"
printf 'BG=%s\\nMARKERS=%s\\nPROMPT=%s\\n' "\${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-unset}" "$(ls "\${TREKVAART_ACTIVE_DIR}" 2>/dev/null | tr '\\n' ' ')" "$prompt" > "${agentLog}"
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
  };
}

function runWrapper(f, { prompt = "Complete https://github.com/o/r/issues/8138", runId = "run_t" } = {}) {
  return spawnSync("bash", [wrapper, "fake-agent", "--model=claude-opus-5"], {
    input: prompt,
    encoding: "utf8",
    env: {
      ...process.env,
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
  assert.ok(calls.some((c) => /issue comment 8138 .*run_exit3/.test(c)), calls.join("\n"));
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
