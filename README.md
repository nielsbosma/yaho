# YAHO — Yet Another Harness Orchestrator

A local desktop app that runs long-lived, self-improving agents on a schedule, lets them work on projects with
controlled access to real-world resources, and keeps a human in the loop through an inbox, without ever making an
agent wait.

Status: under construction.

## Layout

```
apps/desktop/      Electron main + React renderer
core/              TypeScript orchestrator service (Node.js): API, scheduler, jobs, harness, secrets, db
cli/               the yaho CLI agents use
briefings/base.md  base briefing every agent gets
examples/agents/   example agent definitions
```

## Develop

```
vp install
vp dev          # app, core and renderer with hot reload
pnpm ready      # format, lint, types, tests
```

Local data lives in `%APPDATA%\yaho` (override with `YAHO_DATA_DIR`).
