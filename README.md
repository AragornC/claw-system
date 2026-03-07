# ThunderClaw — AI Native 交易引擎

ThunderClaw 是一个 AI 驱动的量化交易特征工程平台，通过自然语言对话帮助用户创建、验证和管理交易特征。

## 核心功能

- **虾策（特征工程）**：通过对话生成 Freqtrade 兼容的交易特征代码
- **虾脑（模型管理）**：多 LLM 提供商管理（DeepSeek、OpenAI、Anthropic、Gemini 等）
- **交易对话**：AI 助手理解交易架构，引导用户创建和优化特征
- **特征回测**：在历史 OHLCV 数据上验证特征有效性

## 架构

```
scripts/server/
  app.js              — 服务器组合根（无外部 CLI 依赖）
  config.js           — 配置常量
  core/
    llm-client.js     — 通用 LLM 客户端（支持多提供商）
    pipeline/         — 特征生成流水线（意图检测 → 代码生成 → 代码验证）
    intent-gating.js  — 4 层意图过滤（规则 → 分类 → LLM → 校准）
    strategy-lab-store.js — 特征/策略存储
    conversation-context.js — 对话上下文管理
    memory-layer.js   — L1-L3 记忆系统
    xbrain-store.js   — 模型配置存储
  handlers/
    chat.js           — 对话 API
    session.js        — 会话管理
    xbrain.js         — 模型配置 API
    strategy-lab.js   — 策略实验室 API
  domain/             — 领域模型（分类法、模型提供商）
  http/               — HTTP 路由
  lib/                — 工具函数
```

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 安装 Freqtrade + TA-Lib
bash scripts/setup-install-freqtrade.sh

# 3. 启动服务
DEEPSEEK_API_KEY=sk-xxx node scripts/thunderclaw-server.js

# 4. 打开浏览器
# http://127.0.0.1:3456
```

## 测试

```bash
# 单元测试
THUNDERCLAW_FREQTRADE_CMD=.thunderclaw/freqtrade-venv/bin/freqtrade \
  node --test scripts/server/core/*.test.js

# E2E 测试（需要 API Key）
DEEPSEEK_API_KEY=sk-xxx node scripts/e2e/realistic-flow.test.js
```

## 模型配置

通过虾脑 UI 或 API 配置 LLM 提供商：

```bash
# API 方式
curl -X POST http://localhost:3456/api/xbrain/update \
  -H 'Content-Type: application/json' \
  -d '{"provider":"deepseek","apiKey":"sk-xxx"}'
```

支持的提供商：DeepSeek、OpenAI、Anthropic、OpenRouter、Gemini、ZAI
