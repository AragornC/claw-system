# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

ThunderClaw is a Node.js (ES modules) AI crypto trading dashboard built on top of the `openclaw` npm package. It serves a vanilla HTML/JS frontend from a raw `node:http` server — no build step, no bundler, no framework.

### Running the application

```bash
npm run thunderclaw:start          # starts on default port 3456
# or explicitly:
node scripts/thunderclaw-cli.js start --port 3456
```

The server forks a child process that stays alive after the CLI exits. Verify with `curl http://127.0.0.1:3456/api/status`.

### Key caveats

- **No lint / test / build tooling**: The project has no ESLint config, no test framework, and no build step. There are no `npm test` or `npm run lint` commands.
- **AI features require API keys**: The gateway (`/api/gateway/start`) and chat (`/api/chat`) endpoints need at least one AI provider configured with an API key (e.g. DeepSeek). Without keys the server still starts and all non-AI endpoints work.
- **File-based persistence**: State is stored as JSON files in the `memory/` directory (e.g. `xbrain-state.json`, `chat-history.json`). These are gitignored.
- **Server spawns a child process**: `thunderclaw-cli.js start` spawns the server as a detached child. To stop it, use `kill <PID>` on the node process listening on port 3456 (`lsof -i :3456`).
- **Single dependency**: The only npm dependency is `openclaw`. Running `npm install` is the complete setup.
