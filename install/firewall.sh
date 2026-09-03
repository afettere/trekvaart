#!/usr/bin/env bash
# Port-level firewall for a Trekvaart box. Run as root; idempotent.
#
# Inbound: SSH only, rate-limited. Outbound: DNS, NTP, SSH (git over ssh to GitHub) and HTTPS
# (GitHub API, the agent's API, package registries). Everything else is refused in both
# directions. The Machinist UI on 7331 stays bound to localhost and is reached over an SSH tunnel.
#
# This is a PORT allowlist, not a HOST allowlist. Restricting HTTPS to named hosts needs an
# egress proxy the agent CLI and gh are pointed at; that is the next step if the pilot shows the
# agent reaching anywhere it should not. Until then, the audit trail for egress is the agent's
# own transcript in Machinist's run record.
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "run this script as root" >&2
  exit 1
fi

ufw --force reset >/dev/null
ufw default deny incoming
ufw default deny outgoing
ufw default deny routed

ufw limit in 22/tcp comment 'ssh, rate limited'

ufw allow out 53 comment 'dns'
ufw allow out 123/udp comment 'ntp'
ufw allow out 22/tcp comment 'git over ssh'
ufw allow out 443/tcp comment 'https: github, agent api, registries'

ufw logging low
ufw --force enable
ufw status verbose
