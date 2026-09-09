# The board

A read-only page for the box, beside Machinist's UI. It answers one question, "is anything
waiting on me, and how much of the month's allowance is left?", from the three sources a flight
already leaves behind: the label on GitHub is the state, the ledger is the cost, the sweeper is
the witness. It never writes; every row links to the issue or pull request where the change is
made. Spec: [`docs/ux/board-ux-spec.md`](../docs/ux/board-ux-spec.md).

| File | Does |
| :-- | :-- |
| [`compose.mjs`](compose.mjs) | `composeBoard({ now, ceiling, repos, box, issues, prs, ledger, markers, sweeps, errors })`: the pure composer from the sources to the page's view model. Every state in the spec's pass 5 is decided here and pinned in [`compose.test.mjs`](compose.test.mjs). |
| [`server.mjs`](server.mjs) | One HTTP server, no framework: `/` is the page, `/api/board` the view, cached for `--refresh-seconds` (60). Reads GitHub through the box's `gh` login (one `issue list` per lifecycle label per repository, the comments and timeline of each flight, the PR's check rollup), the ledger and the markers under `~/.trekvaart`, the sweeper's tick files, and the box (control plane probe on Machinist's `listen`, `gh api user`, versions). A source that fails keeps its last good read and reports beside it. |
| [`page.html`](page.html) | The page: renders `/api/board` and refreshes every 60 s. Times are shown in Mountain Time. |
| [`../install/trekvaart-board.service`](../install/trekvaart-board.service) | The user service that keeps it up. |

## Reading it

Over the same tunnel as Machinist's UI, one more port:

```sh
ssh -N -L 7331:127.0.0.1:7331 -L 7332:127.0.0.1:7332 machinist@VM_HOST
```

Then <http://127.0.0.1:7332>. Do not expose 7332.

## What each block reads

- **Waiting on you**: open issues at `trekvaart:needs-human` or `trekvaart:blocked`, with the first sentence of the stop comment; a `trekvaart:requested` issue nobody admitted after two poll intervals; a `machinist:queued` issue with no run behind it after one.
- **Flights**: every open issue carrying a lifecycle label, in lifecycle order. The live dot is a marker in `~/.trekvaart/active` whose pid answers `kill -0`; without one, the row says since when and when the sweeper acts next. Time in state is the timeline's last `labeled` event for the current label (falls back to the issue's last update, marked). Stage and repair count come from the `<!-- trekvaart:foreman-state -->` comment, the PR from `<!-- trekvaart:foreman-pr -->`. Spend so far sums the last row of every ledger run carrying the issue (rows carry `issue` since tv9; a live marker joins older runs).
- **Spend**: the sluis's own arithmetic (`ledgerSpend` over the same window), split into priced runs and runs still at the reserve, and how many flights fit in what is left.
- **Sweeper and box**: the last tick file per repository (`~/.trekvaart/ticks/OWNER__REPO.json`, written by every sweep), Machinist's control plane answering on its `listen`, the timeout and cadences read from `~/.machinist/config.toml`, the `gh` login, versions.

## Running the spec

```sh
node --test board/compose.test.mjs board/server.test.mjs
```
