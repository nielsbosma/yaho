# AGENTS.md — Yaho

> Project memory for work on **Yaho** in `D:\Repos\_Personal\yaho` (public: github.com/nielsbosma/yaho). Keep it
> current: when a decision is made or a fact turns out to be wrong, update this file in the same session. Record what
> was done in **`.plan/changelog.md`** (newest entry first). This file holds the current state; history goes in the
> changelog.

## 1. What this is

Yaho runs long-lived AI agents on a schedule. Each agent has a briefing, a workspace it keeps between runs, and a
budget. Agents talk to the human through an inbox (and Slack), and never wait for an answer. The README explains it.

| Part | Where |
|---|---|
| Core (API, scheduler, job runner, harness adapters, providers, Slack bridge) | `core/src` |
| Desktop app (Electron main + React renderer, also served as the web UI) | `apps/desktop/src` |
| `yaho` CLI (what agents call back with) | `cli/src` |
| Server image (Docker) | `docker/Dockerfile`, `docker/entrypoint.sh` |
| Packaging, signing, end-to-end test | `tools/` |
| Plans (HTML, gitignored) | `.plan/` |

## 2. Working conventions

- **Labels use AP title case**: every field label, switch, button, tab, menu item and section title ("Max Parallel
  Jobs", "Attach Files"). Hints and body text stay in sentence case.
- **Plans go in `.plan/`** as standalone HTML with inline SVG diagrams (no ASCII art). `.plan/` is gitignored.
- **Commit or push only when asked.** Stage named paths, never `git add -A`. No attribution lines in commit messages.
- **Never commit secrets.** Test keys live in `.plan/secrets.env` (gitignored).
- **Line endings are LF.** Scripts that rewrite files on Windows must write LF (Python: `open(..., newline='')`).
- **Releases only when asked.** `gh release create vX --prerelease` triggers `release.yml`, which publishes npm
  `@next` and `ghcr.io/nielsbosma/yaho:next`. The version is in the root `package.json`.

## 3. Build and test

- Type check: `node node_modules/typescript/bin/tsc -p .`
- Tests: `node_modules/.bin/vp test run` (68 tests). Timing tests can flake when the machine is busy; rerun the
  file on its own before chasing them.
- `vp check` reports formatting issues in about 60 files that predate this file; leave them unless asked.
- **Dev app**: `vp dev` at the repo root (unset `YAHO_DATA_DIR` and `ELECTRON_RUN_AS_NODE` first). It runs Vite on
  4710, the core on 4701 and Electron, with data in `%APPDATA%\yaho-dev`: **Niels's own agents live there**. Starting
  Electron directly (`electron .`) uses `%APPDATA%\yaho` instead, which is empty.
- **Local server test** (Git Bash needs `MSYS_NO_PATHCONV=1`), with its own volume, never Niels's data:
  ```
  docker build -q -f docker/Dockerfile -t yaho:local .
  docker run -d --name yaho-local -p 4799:4700 -v yaho-local-data:/data -e YAHO_PASSWORD=local-test-password-1234 yaho:local
  node tools/e2e.mjs --url http://localhost:4799 --password local-test-password-1234
  ```
  An open browser tab keeps the old bundle after a rebuild: reload it.
- **Test keys**: `.plan/secrets.env` (LiteLLM URL/API key/master key, Anthropic, OpenAI, OpenRouter + management key,
  Opper, Berget, Composio). Read them, never print them. Known state (2026-10-13): the Anthropic key and the
  OpenRouter account have no credit; `LITELLM_MASTER_KEY` is a team key without rights to `/key/generate`, so
  per-job LiteLLM keys fail until it gets them.

## 4. How the server version is locked down

- The core runs as `yaho` (uid 1000); agents run as `yaho-agent` (uid 1001) through `core/src/harness/asAgent.ts`
  (`setpriv`, all capabilities dropped, `no-new-privs`). The desktop app runs agents as the person.
- What both share (`/data/agents`, `projects`, `home`, `codex`, `bin`) belongs to group `yaho-agents` with setgid
  directories; everything else in `/data` is the core's alone. See `docker/entrypoint.sh`.
- 🔴 **Never `copyFileSync` or `fs.cp` into a shared folder**: a copy keeps the core's group and the agent cannot read
  it. Write the file fresh (`writeFileSync(dst, readFileSync(src))`) or reset the group (`shareWithAgents` in
  `core/src/assistant/files.ts`).

- Each job gets its own temp folder (`TMPDIR`/`TEMP`/`TMP` = `<workspace>/.yaho/tmp/<job>`, removed when the job ends):
  the system temp is shared by every agent, and one agent once sent another's leftover `/tmp/m.yaml`. A literal `/tmp`
  path in Python on Windows (`C:\tmp`) or on the server is still shared.

- Yaho's own MCP server is `/mcp` (`core/src/api/mcpServer.ts`), with the chat's tools. Desktop: open to loopback
  connections with a loopback Host and no foreign Origin. Server: OAuth 2.1 (`core/src/api/oauth.ts`), stateless: clients,
  codes and tokens are signed with the session key, so Sign Out Everywhere ends them.

## 5. Hosting

- **Demo**: Sliplane service `service_vnt7pvfo72vx` (yaho-demo.sliplane.app), pulls `ghcr.io/nielsbosma/yaho:next`.
  Its password is in `.plan/demo.env`. It is only a test: redeploying or resetting it is fine.
- `sliplane` CLI: pass `-a bosma` on each subcommand. Project id:
  `(sliplane services list -a bosma --json | ConvertFrom-Json | Where-Object { $_.id -eq 'service_vnt7pvfo72vx' }).projectId`.
- Agents must not type keys or passwords into hosted pages (the demo included); test that on `localhost`.

## 6. Open items

- The demo still runs rc.2: two deploys (2026-10-12) hung at "Deploy started". Redeploy from the Sliplane dashboard.
- LiteLLM per-job keys: the master key needs proxy-admin rights or the `/key/generate` and `/key/delete` routes.
- Settings has no way to remove a saved key (the API clears one with `null`); the chat cannot either.
- A bad LiteLLM master key fails every job instead of falling back to the API key.
- The LiteLLM URL field in setup starts filled with `http://localhost:4000` as a value, not a placeholder.
- OpenRouter's Test Connection lists models without the key, so a wrong key passes.
- Codex through LiteLLM to a Bedrock Claude fails: `client_metadata: Extra inputs are not permitted`.
- Questions for Niels: how the Slack owner is claimed; whether Sign Out Everywhere should also rotate the API token.
