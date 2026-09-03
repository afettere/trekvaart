# The box

One small VM runs the whole pilot: Machinist's control plane and worker as systemd services under an unprivileged user, the agent CLI logged in as that user, a clone of the product repository, and a clone of this repository for the prompts and the spend sluis. The Machinist UI binds to localhost and is reached over an SSH tunnel. Nothing on the box holds a database credential or a production secret.

Sized for a pilot: a 4 vCPU / 8 GB class VM (a Hetzner CX32 or equivalent) running Ubuntu 24.04 is enough for one flight at a time.

## Four logins, created on the box

| Credential | Used by | Scope |
| :-- | :-- | :-- |
| Your SSH key | you, to reach the VM | root for bootstrap; `machinist` for everything after |
| `gh auth login` on the box | Machinist's trigger (poll, relabel, permission check) and the sluiswachter (issues, PRs, comments, checks) | an account with write access to the registered repositories |
| A deploy key created on the box | `git clone`, `fetch`, `push` from the worker | one product repository, write access; the default branch's own protection (pull request plus checks) is what keeps it off `main`, since GitHub cannot scope a deploy key narrower than the repository |
| The agent CLI's own login | the executor | the subscription or key you choose for the pilot |

Never copy a private key or a credential file onto the box. Create each one there.

## Bootstrap (as root)

```sh
curl -fsSL https://raw.githubusercontent.com/afettere/trekvaart/main/install/bootstrap.sh -o bootstrap.sh
less bootstrap.sh          # read it; it fetches Machinist's pinned bootstrap and runs it
bash bootstrap.sh
```

`MACHINIST_VERSION` (default `v0.4.0`) and `TREKVAART_REF` (default `main`) pin what is installed. The script is idempotent; re-run it to pick up a new Trekvaart ref.

## Logins and repository (as `machinist`)

```sh
su - machinist
gh auth login --hostname github.com --git-protocol ssh --web
claude                      # sign in once, then exit
```

### Deploy key

```sh
ssh-keygen -t ed25519 -N '' -C "trekvaart@$(hostname)" -f ~/.ssh/id_ed25519_trekvaart
cat ~/.ssh/id_ed25519_trekvaart.pub
```

Add the `.pub` line as a **deploy key with write access** on the product repository (`Settings → Deploy keys`). A deploy key cannot be scoped narrower than the repository, so check before you add it that the default branch is protected (a pull request and passing checks required, no direct pushes); that protection, not the key, is what keeps a flight off `main`. The sluiswachter itself never merges. Tell SSH to use it for GitHub:

```sh
cat >> ~/.ssh/config <<'CFG'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_trekvaart
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
ssh -T git@github.com       # compare the fingerprint with GitHub's published ones before accepting
git clone git@github.com:OWNER/PRODUCT-REPO ~/repos/PRODUCT-REPO
```

### Configuration

Edit `~/.machinist/config.toml` and `~/.machinist/worker.toml` (seeded from [`runners/machinist/`](../runners/machinist/README.md)): replace `OWNER/PRODUCT-REPO` and the repository path. Check the ceiling in [`sluis/ceiling.json`](../sluis/README.md) names the model the executor will run. Then:

```sh
machinist worker validate
exit
systemctl enable --now machinist-worker.service
systemctl status machinist-control-plane.service machinist-worker.service
```

## Smoke test, before any real issue

Two steps, both against a **throwaway repository** the `gh` account can write to, never the product.

1. **Machinist's own lifecycle eval.** It proves the box, the logins and the trigger with Machinist's shipped `foreman` prompt and `machinist:*` labels. Follow [Machinist's evals README](https://github.com/owainlewis/machinist/blob/main/evals/README.md): clone the throwaway repository, point a copy of Machinist's `examples/config.toml` at it, and run `python3 -m evals.github_labels --repository=... --repo-path=... --machinist=$(command -v machinist)`. It exits non-zero when the label lifecycle is wrong.
2. **One Trekvaart flight.** Register the throwaway repository in both Machinist files, open an issue there with a one-line acceptance criterion, label it `trekvaart:requested`, and watch `journalctl -u machinist-worker.service -f`. The flight should end on `trekvaart:ready-for-review` with one pull request, and `sluis/ledger.jsonl` should hold one row with four token counts and a dollar figure.

Only after both pass do you register the product repository.

## Reaching the UI

```sh
ssh -N -L 7331:127.0.0.1:7331 machinist@VM_HOST
```

Then open <http://127.0.0.1:7331>. Do not expose 7331.

## Firewall

[`firewall.sh`](firewall.sh) allows SSH in (rate-limited) and DNS, NTP, SSH and HTTPS out; everything else is refused. It is a port allowlist, not a host allowlist; the comment at the top of the script says what a host allowlist would take.
