# Running Trekvaart on Machinist

[Machinist](https://github.com/owainlewis/machinist) is a job runner: a trigger starts one process in one repository with a prompt on stdin and a timeout, and records what happened in a SQLite ledger. Trekvaart supplies the prompts, the labels, the spend sluis, and the box recipe in [`install/`](../../install/README.md). Machinist's configuration schema has changed more than once in a week, so check these files against the current [configuration guide](https://github.com/owainlewis/machinist/blob/main/docs/configuration.md) before use; they were last checked against **v0.4.0** on 2026-09-03.

| File | Goes to | Holds |
| :-- | :-- | :-- |
| [`config.example.toml`](config.example.toml) | `~/.machinist/config.toml` | the server, the `sluiswachter` command, the registered repositories, and the `trekvaart:requested` label trigger |
| [`worker.example.toml`](worker.example.toml) | `~/.machinist/worker.toml` | the `trekvaart-claude` executor (the agent CLI behind the spend sluis) and the repository paths |
| [`bin/sluis-run`](bin/sluis-run) | referenced by the executor | the spend sluis: refuses a flight once the ceiling is reached, records usage by token class |

## How a flight starts

1. A human with write access applies `trekvaart:requested` to an open issue in a registered repository.
2. Machinist's control plane sees it on its next poll (`every` in the trigger), checks the labelling actor's permission, creates a job, and swaps the label for **`machinist:queued`**. That label is Machinist's, not Trekvaart's; it means "admitted, not yet running" and the sluiswachter replaces it with `trekvaart:planning` as its first act.
3. The worker leases the job, runs the executor in the repository's checkout with the rendered prompt on stdin, and streams the agent's output. The spend sluis runs first and either refuses (the run fails before the agent starts, and the flight is left for a human) or hands over to the agent.
4. Machinist records `duration_millis`, `exit_code` and a single `token_usage` total per run. Trekvaart's ledger records the four token classes and the list-price spend beside it.

## What Machinist needs on the box

- `gh` authenticated as an account with write access to the registered repositories: the trigger polls and relabels through `gh`.
- The agent CLI logged in as the same unprivileged user that runs the worker.
- A clone of this repository for the prompt file and the spend sluis, and a clone of each registered repository.

Nothing in this repository fires on its own; the label is the only trigger.
