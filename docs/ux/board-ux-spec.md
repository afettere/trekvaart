# The Trekvaart board: UX spec

A read-only operator page for the box. It runs beside Machinist's UI (127.0.0.1:7332, reached
over the same SSH tunnel as 7331), as the `machinist` user, and reads what the box already has:
the ledger and the markers on disk, Machinist's SQLite run records, and GitHub labels and
comments through the box's `gh` login. It changes nothing. Every row deep-links to the issue or
pull request where the change is made. Decisions (Andrew, 2026-09-09, 15:25 MT): on the box, over
the tunnel; read-only.

Structure before pixels: the six passes below fix what the page is, then the mock-up fixes how it
looks. Spec home is this repository because the page ships here; the product's process rules
(`ux-spec`) are the ones followed.

## 1. Mental model

**Andrew's one-sentence intent:** "Is anything waiting on me, and how much of the month's
allowance is left?"

Wrong models he may bring, and the correction each gets:

- *The board is where I act.* It is not: labels on GitHub are the control surface, audited under
  his account. Every row links to the exact issue or PR; the page never carries a button that
  writes.
- *A green board means every flight is fine.* A flight at `planning`/`building`/`verifying` is
  running, not fine; only the sweeper can tell a live run from a stranded one, and the board shows
  the sweeper's last verdict beside every in-flight row.
- *The dollars are a bill.* They are list-price shadows of the subscription allowance (the box holds
  no API key). The spend panel says so in its label, once, and never elsewhere.

Principle to reinforce: **the label is the state, the ledger is the cost, the sweeper is the
witness.** Three sources, shown as three things, never blended into one invented status.

## 2. Information architecture

Every concept the reader meets, grouped, and classified Primary (visible at rest) / Secondary
(one interaction away) / Hidden (in the source, not on the page).

**Flights** (one row per open issue carrying a `trekvaart:*` or `machinist:queued` label)

| Concept | Class | Source |
|---|---|---|
| Issue number, title, repository | Primary | GitHub |
| State (the label) | Primary | GitHub |
| Live run behind it (marker present, pid alive) or none | Primary | markers + `kill -0` |
| Time in state (since the label changed) | Primary | GitHub timeline |
| Pull request, its check summary | Primary when it exists | GitHub |
| Spend so far on this issue (all runs, last row per run) | Primary | ledger |
| Repair count, stage from the state comment | Secondary (row expands) | GitHub state comment |
| Run ids, Machinist exit code and duration per run | Secondary | Machinist SQLite |
| The rendered prompt, the stream | Hidden (Machinist's UI has it) | — |

**Attention** (rows that need a human)

| Concept | Class |
|---|---|
| `needs-human` and `blocked` issues with the stop comment's first line | Primary, first on the page |
| A `requested` issue Machinist has not admitted after two poll intervals | Primary |
| A `machinist:queued` issue older than the poll interval with no run | Primary |

**Spend** (the sluis)

| Concept | Class |
|---|---|
| Spent in the rolling window vs the ceiling, remaining | Primary |
| Reserve per flight and how many flights fit in what is left | Primary |
| Per-run rows (date, issue, list price, priced or reserve) | Secondary |
| Price basis and model rates | Hidden (in `ceiling.json`) |

**Sweeper and box**

| Concept | Class |
|---|---|
| Last sweep tick per repository, its verdict line | Primary |
| Machinist control plane and worker: up, and when last polled | Primary |
| Box login (which GitHub account, which Claude account) | Secondary |
| Versions: Trekvaart commit, Machinist tag, Node | Secondary |

Order on the page: Attention, Flights, Spend, Sweeper and box. The question "waiting on me?" is
answered by the first block or by its absence.

## 3. Affordances

| Element | Looks like | Is |
|---|---|---|
| Issue number and title | link (underline on hover, link color) | opens the issue on GitHub in a new tab |
| PR number | link | opens the PR |
| State chip | a pill with a semantic hue, not a button | read-only; the hue is the state class |
| Flight row | plain row with a disclosure chevron at the end | expands to the run list; the chevron is the only click target beside the links |
| Spend bar | a filled track with the figure beside it | read-only |
| "Read on the box at 15:31 MT" line | quiet caption under the title | the page's freshness; it refreshes itself every 60 s and says so |
| Sweeper tick | timestamp with a verdict | read-only |

Nothing on the page is editable. Nothing looks pressable except links and the row chevron. A
final state (`ready-for-review`, `needs-human`, `blocked`) reads as final: chip filled; an
in-progress state reads as moving: chip outlined with a small live dot when a marker's pid is
alive.

## 4. Cognitive load

Moments of choice, uncertainty or waiting, and what the page does about each:

- *Which of these needs me?* Collapsed: the Attention block lists only rows whose next action is
  a human's, in the order the sweeper or the foreman stopped them. Empty means "nothing".
- *Is this flight alive or stranded?* Collapsed: the row states it (live dot from the marker, or
  "no run behind this label since 12:53 MT, sweeper acts at 13:00 MT"). The reader never infers it
  from a timestamp.
- *How much is left?* One figure, the remaining dollars, with flights-that-fit beside it. The
  ceiling, the window and the reserve are stated once in the caption, not repeated per row.
- *Is the page stale?* Default: auto-refresh every 60 s; the caption carries the read time. If a
  source failed, the block for that source says so in place; the rest stays.
- *Which repository?* Default: all registered repositories in one list, a repository tag on each
  row; no filter control in v1.
- *Too many done flights.* Default: the Flights block shows open issues only; closed issues live
  in the Spend rows (secondary) and on GitHub.

## 5. State design

| Element | Empty | Loading | Success | Partial | Error |
|---|---|---|---|---|---|
| Attention | "Nothing is waiting on you." with the last sweep time | skeleton of two rows for the first paint only | rows, newest stop first | — | "Could not read labels from GitHub (gh exited 1 at 15:31). The last good read was 15:30." block stays, rest of page renders |
| Flights | "No flight in progress. Label an issue `trekvaart:requested` to start one." with the link to the product issues list | same skeleton | rows | a row whose state comment is missing shows the label and "no state comment yet" | as above per source: GitHub failure blanks the labels, marker failure blanks the live dot with "markers unreadable" |
| Spend | "No run recorded yet in this window." bar at 0 | figure placeholder | bar, figure, flights-that-fit | a run with a `started` row and no final row is shown at the reserve, labelled "in flight, reserve" | "Ledger unreadable: line 41 is not JSON." block shows the file path |
| Sweeper and box | "No sweep yet since the worker started at …" | — | last tick per repository | one repository missing its tick shows "no tick in 30 min" in warning hue | "journal unreadable" with the command to read it as root |

What the reader understands in every error state: which source failed, when it last worked, and
that the other blocks are current. What they can do next: the caption names the command or the
place (GitHub, the box) where the truth is.

## 6. Flow integrity

The page has one flow: open it, read the first block, follow a link. Where a first-time reader
could get lost:

- *Opens the URL without the tunnel:* the browser fails to connect. The install guide's tunnel
  line gains the second port; nothing the page can do.
- *Sees a `needs-human` row and looks for a button:* the row's link text is "Read the stop comment
  on #6 →", and the stop comment on GitHub names the one human action. Guardrail: no button.
- *Sees an in-flight row for an hour and worries:* the row shows time in state and the timeout
  (240 min) beside it, so an hour reads as a third of the budget, not a hang.
- *Reads the dollars as a bill:* the spend caption says "list-price shadow of the subscription
  allowance" once.
- *Trusts a stale page:* the read time is under the title and the page refreshes itself; a failed
  refresh leaves the last good time visible with the failure beside it.

No diagram: the flow is linear and the state machine it reads is documented in
[`docs/labels.md`](../labels.md).

## Deferred to the mock-up (pixel forks, not structure)

- Whether the run list under a flight is a table or a stacked list.
- Whether the spend bar is one bar with a ceiling mark or a bar per flight.
- Chip vocabulary for the seven labels: colour per class (in flight / final good / final human).

## Build shape (for the plan after approval)

One Node process, no framework: an HTTP server on 127.0.0.1:7332 that serves one HTML page and
one JSON endpoint; the endpoint composes GitHub (`gh issue list --json` per label, `gh pr view`),
the ledger (`ledgerSpend` from `sluis/spend-ceiling.mjs`), the markers (`readMarkers` from
`sluis/stranded.mjs`), Machinist's SQLite (`sqlite3 -json`), and the journal for the sweeper's
last line. Reuses the sluis and sweeper modules rather than re-reading their files. A user
systemd unit keeps it up. Tests: the composer is a pure function over the five inputs, with
fixtures for every state in pass 5.
