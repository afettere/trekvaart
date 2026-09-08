# The box

One small VM runs the whole build system: Machinist's control plane and worker as systemd services under an unprivileged user, the agent CLI logged in as that user, herdr for the sessions a human runs there by hand, a clone of the product repository, and a clone of this repository for the prompts, the spend sluis and the sweeper. The Machinist UI binds to localhost and is reached over an SSH tunnel. Nothing on the box holds a database credential or a production secret.

Sized for a pilot: a 4 vCPU / 8 GB class VM (a Hetzner CX32 or equivalent) running Ubuntu 24.04 is enough for one flight at a time.

## Four logins, created on the box

| Credential | Used by | Scope |
| :-- | :-- | :-- |
| Your SSH key | you, to reach the VM | root for bootstrap; `machinist` for everything after |
| `gh auth login` on the box | Machinist's trigger (poll, relabel, permission check), the foreman (issues, PRs, comments, checks), the wrapper and the sweeper (a label swap and a stop comment) | an account with write access to the registered repositories |
| A deploy key created on the box | `git clone`, `fetch`, `push` from the worker | one product repository, write access; the default branch's own protection (pull request plus checks) is what keeps it off `main`, since GitHub cannot scope a deploy key narrower than the repository |
| The agent CLI's own login | the executor | the subscription; the box holds no API key, and the ledger's dollars are list-price shadows of that allowance |

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
gh auth login --hostname github.com --git-protocol https --web
claude                      # /login, finish in the browser, then /exit (never Ctrl+Z)
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

The build reach commits as that git identity; without one it invents a repo-local identity from the `gh` account, which a reviewer then has to check. HTTPS for `gh` lets the throwaway repository below clone with the `gh` login alone; the product repository uses the deploy key.

### Deploy key

```sh
ssh-keygen -t ed25519 -N '' -C "trekvaart@$(hostname)" -f ~/.ssh/id_ed25519_trekvaart
cat ~/.ssh/id_ed25519_trekvaart.pub
```

Add the `.pub` line as a **deploy key with write access** on the product repository (`Settings → Deploy keys`). A deploy key cannot be scoped narrower than the repository, so check before you add it that the default branch is protected (a pull request and passing checks required, no direct pushes); that protection, not the key, is what keeps a flight off `main`. The foreman itself never merges. Tell SSH to use it for GitHub:

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

Edit `~/.machinist/config.toml` and `~/.machinist/worker.toml` (seeded from [`runners/machinist/`](../runners/machinist/README.md)): replace `OWNER/PRODUCT-REPO` and the repository path. Check the ceiling in [`sluis/ceiling.json`](../sluis/README.md) names the model the executor will run; it is $250 per rolling 30 days, changed only by commit. Then:

```sh
machinist worker validate
exit
systemctl restart machinist-control-plane.service
systemctl enable --now machinist-worker.service
systemctl status machinist-control-plane.service machinist-worker.service
```

The control plane reads `config.toml` once at start, so restart it after every edit; `validate` checks the worker file only.

## herdr, for hands on the box

The bootstrap installs [herdr](https://herdr.dev/) for the `machinist` user. Use it for every session you run on the box by hand (a fix, a resumed flight, a journal read): open the session inside herdr and it survives an SSH drop or a laptop sleep.

```sh
su - machinist
herdr                        # starts the background server if it is not running, opens the client
# inside herdr: open a pane, run `claude` (or anything else) in it, detach with the client's detach key
```

herdr's README documents no systemd unit for its server; the server starts with the first client and stays up. If that changes, add a user unit here. herdr is not in the flight path: Machinist runs flights, and nothing in `~/.machinist` refers to it.

## Smoke test, before any real issue

Two steps, both against a **throwaway repository** the `gh` account can write to, never the product.

1. **Create the throwaway repository and its labels** (as `machinist`, so the `gh` login is the one the trigger uses):

   ```sh
   mkdir -p ~/repos && cd ~/repos
   gh repo create trekvaart-evals --private --add-readme --clone
   cd trekvaart-evals
   for l in requested planning building verifying ready-for-review needs-human blocked; do gh label create "trekvaart:$l" --color 1F5F6B --force; done
   gh label create "machinist:queued" --color A87B22 --force
   ```

   Point both Machinist files at it (`OWNER/trekvaart-evals` and `/home/machinist/repos/trekvaart-evals`), validate, and restart both services.

2. **One Trekvaart flight.** Open an issue there with a one-line acceptance criterion, label it `trekvaart:requested`, and watch `journalctl -u machinist-control-plane.service -u machinist-worker.service -f`. The trigger polls every `every`; the flight should end on `trekvaart:ready-for-review` with one pull request, a stop comment on the issue, and one row in `~/.trekvaart/ledger.jsonl` priced `list`. On 2026-09-03 the first such flight (a one-paragraph CONTRIBUTING.md) took 5 minutes, three fresh subagents, zero repairs, and $1.29 at list.

Machinist's own label-lifecycle eval (`python3 -m evals.github_labels`, in its repository) proves the same trigger with Machinist's own `foreman` prompt and `machinist:*` labels; a Trekvaart flight covers it, so it is optional.

Only after the flight passes do you register the product repository.

## Reaching the UI

```sh
ssh -N -L 7331:127.0.0.1:7331 machinist@VM_HOST
```

Then open <http://127.0.0.1:7331>. Do not expose 7331.

## Firewall

[`firewall.sh`](firewall.sh) allows SSH in (rate-limited) and DNS, NTP, SSH and HTTPS out; everything else is refused. It is a port allowlist, not a host allowlist; the comment at the top of the script says what a host allowlist would take.
