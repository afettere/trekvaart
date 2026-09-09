#!/usr/bin/env bash
# Trekvaart box bootstrap. Run once, as root, on a fresh Ubuntu or Debian VM.
#
# What it does, in order:
#   0. Adds GitHub's apt repository for `gh`: Ubuntu's own package (2.45 on 24.04) predates
#      the `gh api --slurp` flag Machinist's trigger uses, so the trigger cannot read an issue.
#   1. Installs Machinist at a pinned release with Machinist's own bootstrap (control plane and
#      worker as systemd services under the unprivileged `machinist` user).
#   2. Installs what Trekvaart needs beyond that: nodejs (the spend sluis and the sweeper), sqlite3 (to read
#      the ledgers) and ufw.
#   3. Clones this repository to /home/machinist/trekvaart at a pinned ref.
#   4. Seeds ~/.machinist/config.toml and worker.toml from the examples. Machinist's `init`
#      writes defaults first; an untouched default is backed up and replaced, an edited file
#      is left alone.
#   5. Applies the firewall in install/firewall.sh.
# It then prints the steps only a human can do: the gh, agent and deploy-key logins.
#
# Review both remote scripts before running them; this one pins the tag it fetches.
set -euo pipefail

MACHINIST_VERSION="${MACHINIST_VERSION:-v0.4.0}"
TREKVAART_REPO="${TREKVAART_REPO:-https://github.com/afettere/trekvaart}"
TREKVAART_REF="${TREKVAART_REF:-main}"
RUNTIME_USER=machinist

if [[ $(id -u) -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 1
fi

# Machinist's bootstrap runs the agent installers as the unprivileged user; they try to
# return to the directory this script was started from, which fails from /root.
cd /

export DEBIAN_FRONTEND=noninteractive

echo "== 0. GitHub's apt repository for gh"
mkdir -p -m 755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -qq

echo "== 1. Machinist ${MACHINIST_VERSION}"
curl -fsSL "https://raw.githubusercontent.com/owainlewis/machinist/${MACHINIST_VERSION}/scripts/setup-vm.sh" |
  MACHINIST_VERSION="${MACHINIST_VERSION}" bash

echo "== 2. nodejs, sqlite3, ufw, unzip (for the fnm installer), and gh from GitHub's repository"
apt-get install -y nodejs sqlite3 ufw gh unzip
node --version
gh --version | head -1

RUNTIME_HOME=$(getent passwd "${RUNTIME_USER}" | cut -d: -f6)
run_as_runtime() { runuser -u "${RUNTIME_USER}" -- env HOME="${RUNTIME_HOME}" "$@"; }

echo "== 3. Trekvaart at ${TREKVAART_REF}"
if [[ ! -d "${RUNTIME_HOME}/trekvaart/.git" ]]; then
  run_as_runtime git clone --branch "${TREKVAART_REF}" "${TREKVAART_REPO}" "${RUNTIME_HOME}/trekvaart"
else
  run_as_runtime git -C "${RUNTIME_HOME}/trekvaart" fetch --quiet origin "${TREKVAART_REF}"
  run_as_runtime git -C "${RUNTIME_HOME}/trekvaart" checkout --quiet "${TREKVAART_REF}"
  run_as_runtime git -C "${RUNTIME_HOME}/trekvaart" pull --ff-only --quiet
fi
run_as_runtime mkdir -p "${RUNTIME_HOME}/repos" "${RUNTIME_HOME}/.trekvaart"

echo "== 4. Machinist configuration"
for pair in "config.example.toml:config.toml" "worker.example.toml:worker.toml"; do
  src="${RUNTIME_HOME}/trekvaart/runners/machinist/${pair%%:*}"
  dst="${RUNTIME_HOME}/.machinist/${pair##*:}"
  if [[ ! -f "${dst}" ]]; then
    run_as_runtime install -m 0600 "${src}" "${dst}"
    echo "   seeded ${dst}"
  elif grep -q 'trekvaart' "${dst}"; then
    echo "   ${dst} already a Trekvaart file; kept"
  elif grep -q -E '^(\[commands\.|\[repositories\.|\[executors\.)' "${dst}" && ! grep -q -E '^\[(commands|repositories)\.[a-z-]+\]$' "${dst}" ; then
    echo "   ${dst} has been edited by hand; leaving it alone. Replace it yourself from ${src}."
  else
    run_as_runtime cp "${dst}" "${dst}.machinist-default"
    run_as_runtime install -m 0600 "${src}" "${dst}"
    echo "   replaced Machinist's default ${dst} (backup at ${dst}.machinist-default)"
  fi
done

echo "== 5. herdr, for the sessions a human runs on the box by hand"
# A persistent terminal runtime (Apache 2.0): a Claude Code session opened in a herdr pane
# survives an SSH drop or a laptop sleep. Not in the flight path; Machinist runs flights.
# Installed as the runtime user so its server runs under the same account as the agent login.
if ! run_as_runtime bash -lc 'command -v herdr' >/dev/null 2>&1; then
  run_as_runtime bash -lc 'curl -fsSL https://herdr.dev/install.sh | sh'
fi
run_as_runtime bash -lc 'herdr --version' || echo "   herdr did not install; the box works without it (see install/README.md, herdr)"

echo "== 5b. Node 24 for the runtime user, via fnm"
# The distro's nodejs (step 2) runs the sluis and the sweeper and is enough for them, but it is
# Node 18 with no npm, so a flight could not run the product's own check chain in its worktree
# (the first product flight, 2026-09-09, shipped "not runnable locally; CI is the proof").
# fnm installs Node 24 for the runtime user; the three binaries are linked into ~/.local/bin,
# which the executor wrapper puts first on PATH.
FNM="${RUNTIME_HOME}/.local/share/fnm/fnm"
if [[ ! -x "${FNM}" ]]; then
  run_as_runtime bash -lc 'curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell'
fi
run_as_runtime "${FNM}" install 24
run_as_runtime mkdir -p "${RUNTIME_HOME}/.local/bin"
for tool in node npm npx; do
  target="$(run_as_runtime "${FNM}" exec --using 24 -- sh -c "command -v ${tool}")"
  run_as_runtime ln -sfn "${target}" "${RUNTIME_HOME}/.local/bin/${tool}"
done
run_as_runtime bash -lc 'echo "   node $(node --version), npm $(npm --version) for the runtime user"'

echo "== 6. Firewall"
bash "${RUNTIME_HOME}/trekvaart/install/firewall.sh"

cat <<NEXT

Bootstrap complete. Now, as the runtime user (\`su - ${RUNTIME_USER}\`), the steps only you can do:

  1. gh auth login --hostname github.com --git-protocol https --web
     Use an account with write access to the repositories the trigger will admit issues from.
  2. claude
     Sign in once, interactively (/login), then leave with /exit. Never suspend it with Ctrl+Z.
  3. git config --global user.name "Your Name" && git config --global user.email "you@example.com"
     The build reach commits as this identity.
  4. Create the deploy key and register it on the product repository (install/README.md, "Deploy key").
  5. git clone git@github.com:OWNER/PRODUCT-REPO ~/repos/PRODUCT-REPO
  6. Edit ~/.machinist/config.toml and ~/.machinist/worker.toml: replace OWNER/PRODUCT-REPO and the
     repository path. Set the spend ceiling's model in ~/trekvaart/sluis/ceiling.json if it is not opus.
  7. machinist worker validate
  8. Back as root: systemctl restart machinist-control-plane.service && systemctl enable --now machinist-worker.service
     (the control plane reads config.toml at start, so restart it after any edit)

Then run the smoke test in install/README.md before labelling a real issue.
NEXT
