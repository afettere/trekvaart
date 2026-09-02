# Lifecycle labels

A schuit carries exactly one `trekvaart:` label at a time. The sluiswachter is the only writer during a flight; a human may set `requested` to start one and may clear any label to stop one. The label is the handoff: a flight that resumes after an interruption reads it before doing anything else.

| Label | Means | Set by | Leaves when |
| :-- | :-- | :-- | :-- |
| `trekvaart:requested` | a human has asked for a flight | a human, or a trusted automation the human configured | the sluiswachter picks it up |
| `trekvaart:planning` | the plan reach is producing a specification from the issue | sluiswachter | a specification is posted on the issue |
| `trekvaart:building` | the build reach is committing on a branch against the specification | sluiswachter | the branch is pushed and checks are requested |
| `trekvaart:verifying` | checks are running, or a review or repair reach is in progress | sluiswachter | checks pass and the review finds nothing blocking, or the repair budget is spent |
| `trekvaart:ready-for-review` | one pull request is open, checks green, review clean; a human decides what ships | sluiswachter | a human merges or closes the PR |
| `trekvaart:needs-human` | a product decision, a diverging history, or more than one open PR; the flight has stopped and says why | sluiswachter | a human answers and re-labels `requested` |
| `trekvaart:blocked` | the runner, a tool, or a credential failed; the flight has stopped and says what | sluiswachter | the infrastructure is fixed and a human re-labels `requested` |

## Rules

- A flight never opens a second pull request for the same schuit. If one exists, it is reused or the flight stops `needs-human`.
- A flight never merges. `ready-for-review` is its last word.
- Every stop leaves a comment on the issue stating the reason and the next human action, so the label is never the only record.
- The repair budget is a small fixed number per flight, set in the runner's config and never raised by the flight itself.
