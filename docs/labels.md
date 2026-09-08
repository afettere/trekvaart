# Lifecycle labels

A schuit carries exactly one `trekvaart:` label at a time. The foreman is the only writer during a flight; a human may set `requested` to start one and may clear any label to stop one. Two exceptions, both outside the flight: the executor wrapper and the stranded-flight sweeper move an in-flight label to `needs-human` when the run behind it has ended (see below). The label is the handoff: a flight that resumes after an interruption reads it before doing anything else.

| Label | Means | Set by | Leaves when |
| :-- | :-- | :-- | :-- |
| `trekvaart:requested` | a human has asked for a flight | a human, or a trusted automation the human configured | the foreman picks it up |
| `trekvaart:planning` | the plan reach is rewriting the issue into a specification | foreman | the specification is on the issue |
| `trekvaart:building` | the build reach is committing on a branch against the specification | foreman | the branch is pushed and checks are requested |
| `trekvaart:verifying` | checks are running, or a review or repair reach is in progress | foreman | checks pass and the review finds nothing blocking, or the repair budget is spent |
| `trekvaart:ready-for-review` | one pull request is open, checks green, review clean; a human decides what ships | foreman | a human merges or closes the PR |
| `trekvaart:needs-human` | a product decision, a diverging history, more than one open PR, or a run that ended without posting; the flight has stopped and says why | foreman, wrapper, sweeper | a human answers and re-labels `requested` |
| `trekvaart:blocked` | the runner, a tool, or a credential failed; the flight has stopped and says what | foreman | the infrastructure is fixed and a human re-labels `requested` |

## Rules

- A flight never opens a second pull request for the same schuit. If one exists, it is reused or the flight stops `needs-human`.
- A flight never merges. `ready-for-review` is its last word.
- Every stop leaves a comment on the issue stating the reason and the next human action, so the label is never the only record.
- The repair budget is a small fixed number per flight, set in the runner's config and never raised by the flight itself.

## The flight's record

Beside the label, the foreman keeps exactly one issue comment marked `<!-- trekvaart:foreman-state -->` (stage, branch, worktree, base and head SHAs, approved SHA, pull request, checks, repair count) and one marked `<!-- trekvaart:foreman-pr -->` with the pull request URL. Its log prints one line per phase boundary, `FOREMAN phase=<planning|building|reviewing|repairing|ci> attempt=<n> outcome=<started|passed|failed|needs-human>`, which is the machine-readable record of a run.

## When a run ends without posting

A run the runner kills at its timeout, or an agent that exits early, leaves the label where it was. Nothing re-admits it: the runner admits only `requested`, and a human's filter does not show it. Two mechanisms make it visible again, both writing a comment marked `<!-- trekvaart:stop -->` and moving the label to `needs-human`:

- **The executor wrapper**, at the agent's own exit, if the issue still carries `planning`, `building` or `verifying`.
- **The stranded-flight sweeper** (`sluis/stranded.mjs sweep`), on the runner's cron trigger, for the kill path: an in-flight label with no live run behind it (the wrapper's marker file is gone, or its process is). It waits a short grace period after a label change so it never races a run that is starting.

Neither ever sets `requested`; only a human re-admits a flight.

## Runner labels

A runner may add labels of its own between `requested` and `planning`. Machinist swaps `trekvaart:requested` for `machinist:queued` when it admits an issue; the foreman removes that label as it sets `trekvaart:planning`. A runner label is never the flight's record.
