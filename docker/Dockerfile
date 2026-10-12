# Yaho Server: the core, the web UI, the yaho CLI, Dopbase, Claude Code and Codex in one image.
#   docker build -f docker/Dockerfile -t yaho .
#   docker run -d -p 4700:4700 -v yaho-data:/data -e YAHO_PASSWORD='a long password' yaho
# Everything Yaho keeps is in the /data volume, the agents' home included (Claude Code's sessions, gh and git sign-ins:
# docker exec -it -u yaho-agent <container> gh auth login).

# ---- Dopbase, from its pinned tag (it publishes no binary for every platform we build) ----
FROM rust:1-bookworm AS dopbase
ARG DOPBASE_VERSION=0.1.9
RUN git clone --depth 1 --branch "${DOPBASE_VERSION}" https://github.com/dopbase/dopbase.git /src \
 && mkdir -p /src/dist \
 && printf '<!doctype html><title>Dopbase</title><p>Dopbase bundled with Yaho (API only).</p>\n' > /src/dist/index.html
WORKDIR /src/app
RUN cargo build --release --locked

# ---- Yaho's bundles: core, CLI and web UI (no Electron) ----
FROM node:22-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
RUN npm install -g pnpm@10.7.1
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && node tools/package.mjs --stage

# ---- The image ----
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.296
ARG CODEX_VERSION=0.162.1
# Tools agents use: git, gh, Python, curl, jq, ripgrep. tini passes signals and reaps child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep python3 python3-pip python3-venv tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 # The node image's user 1000 becomes yaho, which runs the core. Agents run as yaho-agent (1001), which cannot read
 # the core's files; what both use (workspaces, projects, the agents' home) belongs to the group yaho-agents.
 && usermod -l yaho -d /data/.core node && groupmod -n yaho node \
 && groupadd -g 1001 yaho-agents && useradd -u 1001 -g 1001 -d /data/home -s /bin/sh -M yaho-agent \
 && usermod -aG yaho-agents yaho

COPY --from=build /src/apps/desktop/build/app /opt/yaho
COPY --from=dopbase /src/app/target/release/dopbase /opt/yaho/dopbase/dopbase
COPY docker/entrypoint.sh /opt/yaho/entrypoint.sh
RUN chmod +x /opt/yaho/entrypoint.sh \
 && printf '#!/bin/sh\nexec node /opt/yaho/cli/main.mjs "$@"\n' > /usr/local/bin/yaho && chmod +x /usr/local/bin/yaho

ENV YAHO_SERVER=1 \
    YAHO_DATA_DIR=/data \
    YAHO_WEB_ROOT=/opt/yaho/renderer \
    YAHO_CLI_MAIN=/opt/yaho/cli/main.mjs \
    YAHO_DOPBASE_BIN=/opt/yaho/dopbase/dopbase \
    YAHO_TRUST_PROXY=1 \
    YAHO_AGENT_UID=1001 \
    YAHO_AGENT_GID=1001 \
    YAHO_AGENT_HOME=/data/home \
    HOME=/data/home \
    CLAUDE_CONFIG_DIR=/data/home/.claude \
    XDG_CACHE_HOME=/tmp/cache \
    NODE_ENV=production

EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD curl -fsS http://127.0.0.1:4700/api/health || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/yaho/entrypoint.sh"]
