# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ThunderClaw (claw-system) is a desktop application for AI-assisted quantitative trading. It pairs role-based AI agents with crypto exchange integrations in a multi-panel UI. Built with **Tauri v2** (Rust backend + React frontend).

## Development Commands

All commands run from `claw-desktop/`:

```bash
npm run dev        # Start Vite dev server (localhost:5173) — Tauri hooks into this
npm run build      # TypeScript compile + Vite production build
npm run lint       # ESLint
npm run preview    # Preview production build
```

Tauri development (requires Rust toolchain):
```bash
cargo tauri dev    # Launch full desktop app with hot-reload frontend
cargo tauri build  # Production app bundle
```

## Architecture

### Frontend (`claw-desktop/src/`)

- **Framework**: React 19 + TypeScript 5.9 + Vite 8
- **State**: Zustand stores with persist middleware — no Redux, no router
- **Layout**: Single-page with togglable panels (Sidebar, Workspace, AgentPanel, TradingBar)

**Stores** (`src/store/`):
| Store | Purpose |
|---|---|
| `agentStore` | Agent definitions, Skills, ToolFunctions — persisted to disk via Tauri |
| `chatStore` | Chat sessions and message history |
| `modelStore` | LLM provider auth and model selection |
| `exchangeStore` | Exchange API credentials and account balances |

**Service layer** (`src/lib/`):
- `llm.ts` — LLM streaming via Tauri Channel IPC (`chatStream()`)
- `exchange.ts` — Exchange balance fetching
- `agent.ts` — Agent config persistence
- `skillMd.ts` — Parses/validates Skill definitions in a markdown-like format (`## Tools`, `## Instructions`, `## Constraints`, `## Evaluator`)

### Backend (`claw-desktop/src-tauri/src/`)

- **Language**: Rust (2021 edition)
- **IPC pattern**: Frontend calls `invoke("command_name", {params})` → Rust handler → JSON response
- **Streaming**: `chat_stream` command uses Tauri `Channel` for SSE-like token delivery

**Key modules**:
- `llm/` — Multi-provider HTTP client (Anthropic, OpenAI, DeepSeek, Google, xAI). OAuth flow for OpenAI, API key auth for others.
- `exchange/` — Crypto exchange APIs (Binance, OKX, Bitget) for spot + futures balances
- `agent/` — Agent config persistence to disk
- `commands.rs` — LLM-related Tauri commands
- `agent_commands.rs` — Agent CRUD Tauri commands
- `exchange_commands.rs` — Exchange auth/balance Tauri commands

### Agent System

Five built-in agents with Chinese-language system prompts: Analyst, Quant, Risk, Sentinel (inactive by default), Coordinator. Each agent has:
- A system prompt defining its role and constraints
- Assigned **Skills** (capability groups combining multiple tools)
- Available **ToolFunctions** with permission levels (`auto` / `ask` / `deny`)

Agent, Skill, and ToolFunction definitions live in `agentStore.ts` defaults and are persisted via `saveAgentConfig()` Tauri command.

## Key Conventions

- **Tauri IPC** is the only bridge between frontend and backend — no direct HTTP from the renderer
- **No CSS framework** — all styling is hand-written CSS with Mac-native aesthetics (transparent title bar, custom traffic lights)
- **TypeScript strict mode** is on with `noUnusedLocals` and `noUnusedParameters`
- Agent system prompts and skill definitions are in Chinese
