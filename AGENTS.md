# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

ThunderClaw is a lightweight Node.js web-based onboarding shell for OpenClaw (AI agent/gateway platform). Pure ESM, no build step, no framework. See `README.md` for full details.

### Prerequisites

- Node.js >= 22.12.0 (enforced by `openclaw` package)
- npm (lockfile: `package-lock.json`)

### Running the app

```bash
npm run thunderclaw:start
```

Server starts at `http://127.0.0.1:3456`. Port configurable via `--port` flag or `THUNDERCLAW_PORT` env var.

### Key caveats

- **No lint/test tooling**: The repo has no ESLint, Prettier, test framework, or test files. There is no `npm test` or `npm run lint` script.
- **No build step**: All code runs directly as ESM JavaScript. No bundler, no transpiler.
- **Frontend JS bug**: The main UI at `/` has a pre-existing `ReferenceError: normalizeStrategyDslSpec is not defined` during initialization, causing the frontend to get stuck on the loading screen. Backend API endpoints work correctly.
- **OpenClaw onboarding requires an LLM API key**: Full functionality (chat, model management) requires completing onboarding with at least one AI provider API key (e.g. DeepSeek). The `/api/setup/quick` endpoint can do one-click setup with a DeepSeek API key.
- **Gateway is a child process**: The OpenClaw Gateway (WebSocket on port 18789) is managed as a subprocess by ThunderClaw, started via `POST /api/gateway/start`. It requires completed onboarding first.
- **State stored as JSON files**: Runtime state lives in `/workspace/memory/*.json` (gitignored). No database needed.
