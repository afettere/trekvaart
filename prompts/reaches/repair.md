# Reach: repair

**In:** the refined issue, the verified branch and worktree, the current head, the exact failing evidence (check output, review findings, pull-request threads), and the repository's own instructions for agents. Nothing about how the change was originally reasoned.
**Out:** one repair commit on the branch addressing exactly the findings given, with the affected checks green locally. Then a `## Repair handoff`: the attempt number, prior and new heads, the repair commit, the disposition of every finding, changed files, and the checks run.
**Tools:** read and write the worktree, run the repository's test and lint commands, commit. No push, no change on GitHub.
**Stop:** when every given finding is addressed or explicitly declined in the handoff, or when a finding cannot be addressed without changing the specification, in which case say so and do not guess.

Fix only what you were handed. Do not refactor around it, do not address advisory findings unless asked, and do not argue with a finding in a commit message; if you believe it is wrong, say so in the handoff and leave it. Conventional Commits, no co-author trailer.
