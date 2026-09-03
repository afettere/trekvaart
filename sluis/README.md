# The spend sluis

A sluis is a gate. This one stands in front of every flight and refuses to open once the pilot has spent its ceiling on model calls.

## The ceiling

[`ceiling.json`](ceiling.json) holds one constant, `ceilingUsd`, and the number of flights it is meant to cover. Everything else is derived: the reserve charged to a run whose usage could not be read is `ceilingUsd / flights`. Nothing raises the ceiling at run time: the CLI has no flag for it and reads no environment variable. Changing it is a commit to this file, which is the point.

Spend is priced per token class at the model's published list rates (input, cache write, cache read, output), never as one rate on a summed total: a coding agent reads far more cache than it writes output, and pricing cache reads at the output rate overstates spend by more than an order of magnitude. The price rows carry the date they were read; re-read them when the pilot starts.

## The two commands

```sh
node sluis/spend-ceiling.mjs check
node sluis/spend-ceiling.mjs record --run-id <id> --model <model-id> < agent-stream > agent-stream
```

`check` exits 0 while recorded spend is below the ceiling and 75 once it is reached (or when the ledger cannot be read, which is refused rather than treated as empty). `record` passes the agent's stream through unchanged, then appends one row to the ledger: the four token counts **per model** read from the stream's final `result` event, the dollar figure, and whether it was priced from usage (`list`) or charged the reserve (`reserve`).

The per-model counts come from the event's `modelUsage`, which is the only place subagent tokens appear; the event's top-level `usage` covers the orchestrator's own turns alone. Measured on the first smoke flight (2026-09-03): the same run priced at $0.58 from `usage` and $1.29 from `modelUsage`. A model id with a date suffix (`claude-haiku-4-5-20251001`) resolves to its undated price row; a model with no row at all charges the reserve rather than guessing.

[`runners/machinist/bin/sluis-run`](../runners/machinist/bin/sluis-run) wires both around the agent CLI as Machinist's executor.

## The ledger

One JSON object per line at the path in `ceiling.json` (default `~/.trekvaart/ledger.jsonl`):

```json
{"recordedAt":"2026-09-03T22:15:18.000Z","runId":"…","model":"claude-opus-5","usage":{"claude-opus-5":{"input":58,"cacheWrite":78608,"cacheRead":606441,"output":19737},"claude-haiku-4-5-20251001":{"input":1916,"cacheWrite":0,"cacheRead":0,"output":18}},"usd":1.29,"priced":"list","priceBasis":"…"}
```

Read it with `jq -s 'map(.usd) | add' ~/.trekvaart/ledger.jsonl`. Machinist's own SQLite ledger keeps the run state and a single summed token count beside it; the two are joined on the run id.

## Tests

```sh
node --test sluis/spend-ceiling.test.mjs
```

The spec covers the pricing arithmetic, the stream parser (both `modelUsage` and the single-block fallback), dated-id resolution, the config validation, the no-override property, both commands end to end through a temporary ledger, and that five unreadable runs exhaust the ceiling.
