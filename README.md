# Yaho — Yet Another Harness Orchestrator

A local desktop app that runs long-lived, self-improving agents on a schedule, lets them work on projects with
controlled access to real-world resources, and keeps a human in the loop through an inbox, without ever making an
agent wait.

- **Agents never block.** An agent that needs you sends a message and carries on; your answer lands in its inbox
  and starts a new job.
- **Agents get better over time.** Each has a workspace with saved scripts, its own SQLite database and memory files,
  and may rewrite its own briefing (every version is kept and revertible).
- **Secrets stay secret.** Key values live in [Dopbase](https://dopbase.com) and are injected into the job's
  environment; agents see key names, never secret values.
- **Harness- and model-agnostic.** Claude Code is the default harness; every model call goes through a
  [LiteLLM](https://github.com/BerriAI/litellm) proxy.
- **Human checkpoints take seconds.** Questions get choice buttons, instructions get Open and Copy buttons and a
  one-click Done.

This is a personal tool, built by Niels Bosma to have full control over how it works. It is open source under the
MIT licence.

## How it works

```
Electron app (UI, tray, notifications)
        │  HTTP + server-sent events, token auth
        ▼
TypeScript core (runs headless with `yaho serve`) ── SQLite (agents, jobs, messages, …)
   ├─ scheduler: cron, inbox and delay triggers        ── Dopbase (key values, fetched at job start)
   ├─ job runner: sessions, budgets, resume
   └─ harness adapter ─► Claude Code ─► LiteLLM proxy ─► models
                             │
                             └─ the agent calls back with the `yaho` CLI (YAML in, YAML out)
```

- **Every run of an agent is a job.** Something triggers it (cron, a new inbox message, Run now, or a delay the
  agent asked for). The prompt is layered: the [base briefing](briefings/base.md), the agent's briefing, then
  context (projects, resources by key name, unread inbox, the last session's summary).
- **Jobs end** with `yaho finish`, `yaho sleep <duration>` (the same Claude Code session resumes later), a failure,
  or budget exhaustion. A stopped or budget-exhausted job can be continued in place after raising the budget.
- **Loop guardrails** (rate limit, cooldown, hop limit) stop agents from waking each other forever.
- **The UI is a plain web app.** It talks to the core only over its API, so the same UI works in a browser at
  `http://127.0.0.1:4700/?token=<api-token>`.

## Setup

You need Node.js 22.17 or newer, pnpm, and [Vite+](https://viteplus.dev) (`vp`). Claude Code must be installed and
on PATH (`claude`). The bundled Dopbase is built from source once (Dopbase publishes no Windows binary), which needs
Rust (`cargo`):

```bash
vp install
node tools/build-dopbase.mjs
vp dev
```

`vp dev` starts the renderer with hot reload, the core (restarted on every core change; running jobs resume their
session afterwards) and the Electron window. Dev data lives in `%APPDATA%\yaho-dev` on port 4701 (Dopbase on 4703), so it can run next
to an installed Yaho, including one whose agent is working on this repository.

Then open **Settings**:

| Setting                       | What to enter                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LiteLLM proxy URL and API key | Every model an agent may use must exist in the proxy. With a master key instead, Yaho mints one budget-capped key per job and shows cost live.                                                                                                                                                                                          |
| Dopbase                       | **Bundled** (default): Yaho runs its own Dopbase on 127.0.0.1:4702, data in `<data dir>\dopbase`, set up automatically on first start. **External**: an existing Dopbase server and a token that can create projects and set secrets. Either way each resource becomes the Dopbase project `yaho-<resource>`, environment `production`. |
| Composio (optional)           | An API key from composio.dev. Then **Resources → From Composio** lists your connections and every app you can connect; any connection becomes a resource agents use with `yaho tools` / `yaho tool`. Yaho makes those calls, so the key never reaches an agent.                                                                         |
| Global spend cap              | When total spend reaches it, no job starts and running jobs stop.                                                                                                                                                                                                                                                                       |

Create an agent from **Agents → New agent**: fill in the form, paste a YAML definition, or install one of the
[examples](examples/agents) (an ads optimiser, a social scout and a day trader; they install disabled, with the
projects and resources they need).

```yaml
name: adwords-optimizer
enabled: true
briefing: |
  Run and optimise Google Ads campaigns for the product in project "widget-pro".
  Daily ad spend must not exceed $50.
harness: claude-code
models: [claude-sonnet-5-5, claude-haiku-5-5] # names as defined in LiteLLM
budget_usd: 30 # what the agent may spend on itself
max_parallel: 1
triggers:
  - cron: '0 7 * * *'
  - inbox: true
projects: [widget-pro]
resources: [google-ads, stripe-sales]
```

## The agent's side: `yaho`

Each job gets `yaho` on its PATH and a short-lived job token that scopes what it may see and change.

| Command                                               | What it does                                   |
| ----------------------------------------------------- | ---------------------------------------------- |
| `yaho inbox list` / `read <id>` / `mark-read <id>`    | Read and manage its own inbox                  |
| `yaho send --to human\|agent:<name> < msg.yaml`       | Send a question, instruction or info message   |
| `yaho query agents\|projects\|resources\|jobs`        | Look around, read-only                         |
| `yaho project files <project> [<file>]`               | List and fetch a project's files               |
| `yaho artifact add <project> <file> --kind <kind>`    | Register something it made                     |
| `yaho briefing show` / `update < briefing.md`         | Read or rewrite its own briefing               |
| `yaho resource keys <resource>`                       | Key names, and values only for non-secret keys |
| `yaho budget`                                         | Budget, spend and this job's cost              |
| `yaho sleep <duration>` / `yaho finish [--summary …]` | End the job                                    |

## Fonts

Yaho uses Claude Desktop's typefaces, Anthropic Sans and Anthropic Serif. They belong to Anthropic and are not in
this repository: when the Claude desktop app is installed, the core reads them from its `app.asar` at run time and
serves them to the UI. Without it, Yaho falls back to system fonts.

## Repository

```
apps/desktop/      Electron main, preload, React renderer (Tailwind, shadcn-style components), Storybook
core/              the orchestrator: api/, scheduler/, jobs/, harness/, secrets/, db/
cli/               the yaho CLI agents use
briefings/base.md  the base briefing every agent gets
examples/          example agents, projects and resources
tools/             package.mjs builds the Windows installer; build-dopbase.mjs builds Dopbase
```

| Command                                 | What it does                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vp dev`                                | App, core and renderer with hot reload                                                   |
| `vp test run`                           | Tests (a scripted fake Claude Code covers jobs, the CLI, triggers, budgets and restarts) |
| `pnpm ready`                            | Format, lint, types and tests                                                            |
| `pnpm --filter @yaho/desktop storybook` | Storybook on port 6006                                                                   |
| `node tools/build-dopbase.mjs`          | Build the bundled Dopbase into `vendor/dopbase/`                                         |
| `pnpm package`                          | Windows installer in `apps/desktop/release/`, with Dopbase                               |
| `node core/src/main.ts serve`           | The core alone (Node 22.17 needs `--experimental-strip-types`)                           |

Local data (Windows: `%APPDATA%\yaho`, or `YAHO_DATA_DIR`): `yaho.db`, `settings.yaml`, `api-token`,
`agents/<name>/` (scripts, `agent.db`, memory, raw transcripts in `.yaho/`), `projects/<name>/files` and
`artifacts/`.

## Licence

MIT. See [LICENSE](LICENSE).
