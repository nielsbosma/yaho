#!/bin/sh
# Starts Yaho Server: checks the volume and the password, puts the home folder on the volume, then runs the core as
# the yaho user (uid 1000). Runs as root only for these checks and the ownership of /data.
set -eu

fail() { echo "yaho: $*" >&2; exit 1; }

# Everything that lasts must be on a volume: a container loses the rest at every restart and redeploy.
if [ "${YAHO_ALLOW_EPHEMERAL:-}" != "1" ] && ! awk '$5 == "/data" { found = 1 } END { exit !found }' /proc/self/mountinfo; then
  fail "No volume on /data: everything would be lost at the next restart. Add a volume with mount path /data and start again (YAHO_ALLOW_EPHEMERAL=1 to try it without one)."
fi
[ -n "${YAHO_PASSWORD:-}" ] || fail "Set YAHO_PASSWORD: without it anyone who finds this server could use it. Add it to the environment and start again."

# A new volume is often owned by root; hand it to yaho, once.
mkdir -p /data/home
if [ "$(stat -c %u /data)" != "1000" ]; then chown 1000:1000 /data; fi
chown 1000:1000 /data/home
touch /data/.write-test 2>/dev/null && rm -f /data/.write-test || fail "/data is not writable. Check the volume's settings (it must not be read-only)."

cd /data
exec setpriv --reuid=1000 --regid=1000 --init-groups --reset-env -- \
  env HOME=/data/home PATH="$PATH" \
  YAHO_SERVER="$YAHO_SERVER" YAHO_DATA_DIR="$YAHO_DATA_DIR" YAHO_WEB_ROOT="$YAHO_WEB_ROOT" YAHO_CLI_MAIN="$YAHO_CLI_MAIN" \
  YAHO_DOPBASE_BIN="$YAHO_DOPBASE_BIN" YAHO_TRUST_PROXY="${YAHO_TRUST_PROXY:-}" YAHO_PASSWORD="$YAHO_PASSWORD" \
  YAHO_PUBLIC_URL="${YAHO_PUBLIC_URL:-}" YAHO_DEBUG="${YAHO_DEBUG:-}" \
  CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" XDG_CACHE_HOME="$XDG_CACHE_HOME" NODE_ENV="$NODE_ENV" \
  node /opt/yaho/core/main.mjs serve --port "${PORT:-4700}"
