# Trekvaart

A thin, stage-only orchestration layer for coding agents.

Named after the 17th-century Dutch tow-canals: fixed routes between cities, barges pulled along on a published timetable, locks at every change of level. A flight through Trekvaart moves one piece of work through a fixed series of stages, and the orchestrator that moves it knows the stages and nothing else. Each stage's rules live in that stage's own prompt.

**Status:** pre-pilot scaffold. The prompts here are drafts for a two-week pilot; nothing in this repository has yet built production code.

## The idea

A single coding agent can write code. A reliable system also has to define the work, hand it between specialists, check the result, handle failures, and keep a record. Most orchestrators do that by giving one agent a very large prompt that knows every rule. Trekvaart does the opposite:

- **The orchestrator is thin.** The sluiswachter knows the reaches, the order between them, the artifact each hands to the next, and when to stop. It never plans a solution, never edits code, never reviews work, never merges.
- **Each reach is its own prompt** with declared inputs, outputs, tools, and a stop condition. A reach can be swapped, evaluated, or run on a cheaper model without touching the others.
- **Handoffs are durable artifacts,** never conversation memory: an issue label, a branch, a pull request, a comment with a marker. Any reach can be resumed from what is written down.
- **Deterministic things stay deterministic.** Whether checks pass, whether a PR merges, whether a deploy happens: those are code, not prompts. Trekvaart waits for them and reads their result.
- **The author never reviews its own work.** Planning, building, each repair, and each review run in fresh contexts.

## Vocabulary

| Word | Means | In practice |
| :-- | :-- | :-- |
| **schuit** | the barge | one unit of work, usually a GitHub issue |
| **flight** | one run through the stages | from `trekvaart:requested` to a pull request or a stop |
| **reach** | one stage | plan, build, review, repair |
| **sluis** | a gate between reaches | a check that must pass before the next reach starts |
| **sluiswachter** | the lock keeper | the thin orchestrator prompt |

## Lifecycle labels

The sluiswachter records where a schuit is by setting exactly one of these labels on the issue. Labels are the handoff; a resumed flight reads them first.

`trekvaart:requested` · `trekvaart:planning` · `trekvaart:building` · `trekvaart:verifying` · `trekvaart:ready-for-review` · `trekvaart:needs-human` · `trekvaart:blocked`

See [docs/labels.md](docs/labels.md) for what each means and who may set it.

## Layout

```
prompts/
  sluiswachter.md        the orchestrator
  reaches/
    plan.md              schuit in, specification out
    build.md             specification in, branch and commits out
    review.md            branch in, findings out (read-only)
    repair.md            findings in, commits out
docs/
  labels.md              the lifecycle labels
sluis/
  ceiling.json           the pilot's spend ceiling, derived from one constant
  spend-ceiling.mjs      the spend sluis: refuses a flight once the ceiling is reached
runners/
  machinist/             config, worker and executor wrapper for running on Machinist
install/
  bootstrap.sh           the box: Machinist pinned, this repo cloned, firewall applied
```

## What Trekvaart is not

It is not a runner, a scheduler, a merge queue, or a CI system. It is the prompts and the contract between them. It runs on a job runner that can start one agent process in one repository with a prompt on stdin and a timeout, and record what happened. [Machinist](https://github.com/owainlewis/machinist) is the first runner it is configured for; others that fit the same shape should work. The box recipe for a pilot is in [install/](install/README.md).

## Licence

MIT. See [LICENSE](LICENSE).
