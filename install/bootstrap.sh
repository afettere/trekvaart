#!/usr/bin/env bash
# Trekvaart box bootstrap. Run once, as root, on a fresh Ubuntu or Debian VM.
#
# What it does, in order:
#   1. Installs Machinist at a pinned release with Machinist's own bootstrap (control plane and
#      worker as systemd services under the unprivileged `machinist` user).
#   2. Installs the two extra packages Trekvaart needs: sqlite3 (to read the ledgers) and ufw.
#   3. Clones this repository to /home/machinist/trekvaart at a pinned ref.
#   4. Seeds ~/.machinist/config.toml and worker.toml from the examples if none exist.
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

echo "== 1. Machinist ${MACHINIST_VERSION}"
curl -fsSL "https://raw.githubusercontent.com/owainlewis/machinist/${MACHINIST_VERSION}/scripts/setup-vm.sh" |
  MACHINIST_VERSION="${MACHINIST_VERSION}" bash

echo "== 2. sqlite3 and ufw"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y sqlite3 ufw

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
  if [[ -f "${dst}" ]] && ! grep -q 'trekvaart' "${dst}"; then
    echo "   ${dst} exists and is not a Trekvaart file; leaving it alone (Machinist's bootstrap wrote a default). Replace it by hand from ${src}."
  elif [[ ! -f "${dst}" ]]; then
    run_as_runtime install -m 0600 "${src}" "${dst}"
    echo "   seeded ${dst}"
  else
    echo "   ${dst} already a Trekvaart file; kept"
  fi
done

echo "== 5. Firewall"
bash "${RUNTIME_HOME}/trekvaart/install/firewall.sh"

cat <<NEXT

Bootstrap complete. Now, as the runtime user (\`su - ${RUNTIME_USER}\`), the steps only you can do:

  1. gh auth login --hostname github.com --git-protocol ssh --web
     Use an account with write access to the repositories the trigger will admit issues from.
  2. claude
     Sign in once, interactively. Then exit.
  3. Create the deploy key and register it on the product repository (install/README.md, "Deploy key").
  4. git clone git@github.com:OWNER/PRODUCT-REPO ~/repos/PRODUCT-REPO
  5. Edit ~/.machinist/config.toml and ~/.machinist/worker.toml: replace OWNER/PRODUCT-REPO and the
     repository path. Set the spend ceiling's model in ~/trekvaart/sluis/ceiling.json if it is not opus.
  6. machinist worker validate
  7. Back as root: systemctl enable --now machinist-worker.service

Then run the smoke test in install/README.md before labelling a real issue.
NEXT
