#!/bin/sh
# Starts Yaho Server: checks the volume and the password, sets who may read what on it, then runs the core as the
# yaho user (uid 1000). Agents run as yaho-agent (uid 1001): they share workspaces, projects and their home with the
# core through the group yaho-agents, and cannot read anything else in /data (the API token, the database, settings,
# Dopbase). Runs as root only for these checks and the ownership of /data.
set -eu

fail() { echo "yaho: $*" >&2; exit 1; }

# Everything that lasts must be on a volume: a container loses the rest at every restart and redeploy.
if [ "${YAHO_ALLOW_EPHEMERAL:-}" != "1" ] && ! awk '$5 == "/data" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  fail "No volume on /data: everything would be lost at the next restart. Add a volume with mount path /data and start again (YAHO_ALLOW_EPHEMERAL=1 to try it without one)."
fi
[ -n "${YAHO_PASSWORD:-}" ] || fail "Set YAHO_PASSWORD: without it anyone who finds this server could use it. Add it to the environment and start again."
touch /data/.write-test 2>/dev/null && rm -f /data/.write-test || fail "/data is not writable. Check the volume's settings (it must not be read-only)."

# A new volume is often owned by root; hand it to yaho. Others may pass through /data, not list or read it.
mkdir -p /data/home /data/.core /data/agents /data/projects /data/codex /data/bin /data/mcp
chown 1000:1000 /data /data/.core
chmod 0711 /data
chmod 0700 /data/.core
# What the core and the agents share: group yaho-agents, group-writable, and new files keep the group (setgid).
shared() {
  chown -R "$1":1001 "$2"
  chmod -R g+rwX,o-rwx "$2"
  find "$2" -type d -exec chmod g+s {} +
}
shared 1000 /data/agents
shared 1000 /data/projects
shared 1001 /data/codex
shared 1000 /data/bin
# Where stdio MCP servers run: the core starts them as yaho-agent.
shared 1000 /data/mcp
shared 1001 /data/home
# Everything else in /data is the core's alone.
find /data -mindepth 1 -maxdepth 1 ! -name home ! -name agents ! -name projects ! -name codex ! -name bin ! -name mcp -exec chmod -R o-rwx {} +

cd /data
# umask 007: nothing the core writes is readable by others. The core keeps three capabilities, to start agents as
# yaho-agent (setuid, setgid) and to stop them (kill); setpriv drops all of them again before an agent starts.
umask 007
exec setpriv --reuid=1000 --regid=1000 --init-groups --reset-env \
  --inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill -- \
  env HOME=/data/.core PATH="$PATH" \
  YAHO_SERVER="$YAHO_SERVER" YAHO_DATA_DIR="$YAHO_DATA_DIR" YAHO_WEB_ROOT="$YAHO_WEB_ROOT" YAHO_CLI_MAIN="$YAHO_CLI_MAIN" \
  YAHO_DOPBASE_BIN="$YAHO_DOPBASE_BIN" YAHO_TRUST_PROXY="${YAHO_TRUST_PROXY:-}" YAHO_PASSWORD="$YAHO_PASSWORD" \
  YAHO_TOTP="${YAHO_TOTP:-}" YAHO_TOTP_RESET="${YAHO_TOTP_RESET:-}" \
  YAHO_PUBLIC_URL="${YAHO_PUBLIC_URL:-}" YAHO_DEBUG="${YAHO_DEBUG:-}" \
  YAHO_AGENT_UID="$YAHO_AGENT_UID" YAHO_AGENT_GID="$YAHO_AGENT_GID" YAHO_AGENT_HOME="$YAHO_AGENT_HOME" \
  XDG_CACHE_HOME="$XDG_CACHE_HOME" NODE_ENV="$NODE_ENV" \
  node /opt/yaho/core/main.mjs serve --port "${PORT:-4700}"
