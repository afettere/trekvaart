# Running Trekvaart on Machinist

[Machinist](https://github.com/owainlewis/machinist) is a job runner: a trigger starts one process in one repository with a prompt on stdin and a timeout, and records what happened in a SQLite ledger. Trekvaart supplies the prompts, the labels, the spend sluis, and the box recipe in [`install/`](../../install/README.md). Machinist's configuration schema has changed more than once in a week, so check these files against the current [configuration guide](https://github.com/owainlewis/machinist/blob/main/docs/configuration.md) before use; they were last checked against **v0.4.0** and the tip `b387fc7` on 2026-09-08. Install release tags only.

| File | Goes to | Holds |
| :-- | :-- | :-- |
| [`config.example.toml`](config.example.toml) | `~/.machinist/config.toml` | the server, the `foreman` and `sweep` commands, the registered repositories, the `trekvaart:requested` label trigger and the sweeper's cron trigger |
| [`worker.example.toml`](worker.example.toml) | `~/.machinist/worker.toml` | the `trekvaart-claude` executor (the agent CLI behind the wrapper), the `trekvaart-sweep` executor, and the repository paths |
| [`bin/sluis-run`](bin/sluis-run) | the flight's executor | the wrapper: refuses a flight once the rolling ceiling is reached, turns the agent CLI's background-task ceiling off, keeps a marker for the sweeper, records usage by token class, repairs a stranded label at the agent's exit |
| [`bin/sweep-stranded`](bin/sweep-stranded) | the sweeper's executor | runs `sluis/stranded.mjs sweep` against the checkout's repository |

## How a flight starts

1. A human with write access applies `trekvaart:requested` to an open issue in a registered repository.
2. Machinist's control plane sees it on its next poll (`every` in the trigger), checks the labelling actor's permission, creates a job, and swaps the label for **`machinist:queued`**. That label is Machinist's, not Trekvaart's; it means "admitted, not yet running" and the foreman replaces it with `trekvaart:planning` as its first act.
3. The worker leases the job, runs the executor in the repository's checkout with the rendered prompt on stdin, and streams the agent's output. The wrapper runs the spend sluis first and either refuses (the run fails before the agent starts, and the flight is left for a human) or hands over to the agent with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so Machinist's `timeout` is the only wall clock on the run.
4. Machinist records `duration_millis`, `exit_code` and a single `token_usage` total per run. Trekvaart's ledger records the four token classes and the list-price spend beside it: a `started` row at the reserve before the first byte, a provisional row at every result event, and a final row when the agent exits; the ledger counts a run's last row. A print-mode session emits its result event only at the end, so a run Machinist kills at the command's `timeout` is counted at the reserve (the deliberate strand of 2026-09-09 ran three minutes and, before the started row, left no row at all). The example timeout is 240 minutes: flight 2 (2026-09-04) reached its verify reach at 120 and was killed there.

## How a flight ends without posting

Machinist ends a run at its `timeout` by sending `SIGKILL` to the whole process group, wrapper included, with no hook. An agent can also exit on its own (flight 3, 2026-09-06, died at the agent CLI's own 600-second background-task ceiling). Either way the issue keeps its in-flight label and nothing re-admits it. Two mechanisms make it visible again as `trekvaart:needs-human` with a stop comment: the wrapper, at the agent's own exit; and the sweeper, on the cron trigger, for the kill path, using the marker file the wrapper leaves while the agent runs. See [`docs/labels.md`](../../docs/labels.md).

## What Machinist needs on the box

- `gh` authenticated as an account with write access to the registered repositories: the trigger polls and relabels through `gh`.
- The agent CLI logged in as the same unprivileged user that runs the worker.
- A clone of this repository for the prompt file and the spend sluis, and a clone of each registered repository.

Nothing in this repository fires on its own; the label is the only trigger.
