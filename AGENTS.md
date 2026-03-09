# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ThunderClaw is a Node.js web control panel for OpenClaw (AI agent framework). See `README.md` for architecture and API reference.

### Running the application

```bash
npm run thunderclaw:start
```

Server listens on `http://127.0.0.1:3456`. The OpenClaw Gateway can be started via `POST /api/gateway/start` (WebSocket on port 18789).

### Key caveats

- **No test framework or linter configured** — the project has no `devDependencies`, no ESLint, no test scripts. There is nothing to run for `npm test` or `npm run lint`.
- **No build step** — frontend is vanilla HTML/JS served as static files from `memory/report/`. Backend is plain ES module JS.
- **Single npm dependency** — `openclaw` provides the CLI binary and all AI agent capabilities.
- **Frontend loading issue** — the browser UI (`index.html`) may fail to fully initialize due to a pre-existing JavaScript error during the boot sequence. The backend API layer works correctly regardless.
- **AI provider API key required for full functionality** — chat, model usage, and agent features require configuring an LLM provider key via `POST /api/setup` or the XBrain UI. The recommended quick-start provider is DeepSeek (`POST /api/setup/quick`).
- **File-based persistence** — all state is stored as JSON in `memory/` and `~/.openclaw/`. No external database needed.
- **Gateway lifecycle** — ThunderClaw manages the OpenClaw Gateway process. Use `POST /api/gateway/start` and `POST /api/gateway/stop` to control it. Gateway health is reported via `GET /api/status`.
