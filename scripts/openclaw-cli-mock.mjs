#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const STATE_PATH = process.env.OPENCLAW_MOCK_STATE_FILE || '/tmp/openclaw-cli-mock-state.json';

function safeObj(v) {
  return v && typeof v === 'object' ? v : {};
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {
    config: {
      agents: {
        defaults: {
          model: {
            primary: 'deepseek-chat',
          },
        },
      },
    },
    sessions: {},
  };
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

function deepGet(obj, dottedPath) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function deepSet(obj, dottedPath, value) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function extractArg(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return '';
  return String(argv[i + 1] || '');
}

function extractUserMessage(promptLike = '') {
  const prompt = String(promptLike || '');
  const markers = ['[用户消息]', '[用户输入]', '[用户问题]'];
  for (const marker of markers) {
    const idx = prompt.lastIndexOf(marker);
    if (idx >= 0) {
      return prompt.slice(idx + marker.length).trim();
    }
  }
  return prompt.trim();
}

function isToolRouterPrompt(promptLike = '') {
  const prompt = String(promptLike || '');
  return prompt.includes('[规划轮次]') && prompt.includes('[已执行工具结果]');
}

function buildToolRouterReply(userMessageLike = '') {
  const userMessage = String(userMessageLike || '').toLowerCase();
  if (/新闻|news|headline|宏观快讯/.test(userMessage)) {
    return {
      reply: '先抓取实时新闻并评估风险，再给交易建议。',
      toolCalls: [
        {
          tool: 'get_market_news_impact',
          arguments: {
            asset: /eth/.test(userMessage) ? 'ETH' : 'BTC',
            q: userMessage.slice(0, 80),
            limit: 6,
          },
        },
      ],
    };
  }
  if (/交易|策略|回测|回验|赚钱|收益|风险|亏损|杠杆|仓位|小白/.test(userMessage)) {
    return {
      reply: '先生成策略候选并读取当前策略指标。',
      toolCalls: [
        {
          tool: 'generate_strategy_versions',
          arguments: {
            message: userMessageLike,
          },
        },
        {
          tool: 'get_strategy_metrics',
          arguments: {},
        },
      ],
    };
  }
  return { reply: '无需调用交易工具。', toolCalls: [] };
}

function buildGeneralReply(userMessageLike = '', state, sessionId) {
  const userMessage = String(userMessageLike || '').trim();
  const lower = userMessage.toLowerCase();
  const sessions = safeObj(state.sessions);
  const session = safeObj(sessions[sessionId || 'default']);

  const riskMatch = userMessage.match(/(?:最多亏|最大亏损|风险)(?:[^0-9]{0,12})([0-9]+(?:\.[0-9]+)?)\s*%/i);
  if (riskMatch?.[1]) {
    session.maxLossPct = String(riskMatch[1]) + '%';
    sessions[sessionId || 'default'] = session;
    state.sessions = sessions;
    writeState(state);
  }

  if (/记得|还记得|刚才说的风险|最大亏损/.test(userMessage)) {
    const pct = String(session.maxLossPct || '').trim() || '2%';
    return `你刚才设定的最大亏损比例是 ${pct}。我会按这个风控约束继续规划。`;
  }
  if (/天气|weather/.test(lower)) {
    return [
      '天气任务已受理：',
      '1) 可用 Open-Meteo/和风天气 API 查询实时温度、降雨和风力。',
      '2) 你若告诉我城市名，我会给出今天逐小时建议。',
      '3) 可执行命令示例：curl \"https://wttr.in/Shanghai?format=3\"',
    ].join('\n');
  }
  if (/新闻|news|btc|eth|宏观/.test(lower)) {
    return [
      '新闻任务已受理：',
      '- 我会先抓取 Google News/CoinDesk/CoinTelegraph 的最新标题。',
      '- 再给出情绪分和风险结论（low/medium/high）。',
      '- 当前建议：先以风险中性仓位观察，再依据事件强度调整杠杆。',
    ].join('\n');
  }
  if (/cannot find module|找不到模块|ws/.test(lower)) {
    return [
      '这个报错通常按下面顺序排查：',
      '1) npm ls ws（确认依赖树里是否存在）',
      '2) rm -rf node_modules package-lock.json && npm install',
      '3) 检查 ESM/CJS 引入方式是否一致',
      '4) 若是 monorepo，确认当前 cwd 与 package.json 对齐',
    ].join('\n');
  }
  if (/交易|策略|回测|回验|赚钱|风险|小白|杠杆|仓位/.test(lower)) {
    return JSON.stringify({
      reply:
        '收到，我会按“小白可执行”方式推进：先做稳健策略对比，再给你仓位与风控参数，并告诉你下一步在虾线/虾策/虾海/虾脑如何操作。',
      actions: [
        {
          type: 'run_backtest_compare',
          strategies: ['v5_retest', 'v5_hybrid', 'v4_breakout'],
          tf: '1h',
          bars: 900,
          stopAtr: 1.2,
          tpAtr: 2.6,
          maxHold: 96,
        },
      ],
    });
  }
  return '任务已接收。我会先澄清目标、再拆分执行步骤，并在每一步给出可执行操作。';
}

function outputAgentJson(reply, sessionId = '') {
  const payload = {
    ok: true,
    result: {
      payloads: [{ text: String(reply || '') }],
      summary: String(reply || ''),
      meta: {
        agentMeta: {
          provider: 'mock',
          model: 'mock-openclaw',
          sessionId: String(sessionId || ''),
        },
      },
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

function main() {
  const cmd = String(argv[0] || '').trim();
  const sub = String(argv[1] || '').trim();
  const state = readState();

  if (cmd === 'config' && sub === 'get') {
    const key = String(argv[2] || '').trim();
    const val = deepGet(state.config || {}, key);
    process.stdout.write(val == null ? '' : String(val));
    return;
  }
  if (cmd === 'config' && sub === 'set') {
    if (String(argv[2] || '').trim() === '--json') {
      const key = String(argv[3] || '').trim();
      const raw = String(argv[4] || '').trim();
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      deepSet(state.config, key, parsed);
      writeState(state);
      process.stdout.write('ok');
      return;
    }
    const key = String(argv[2] || '').trim();
    const val = String(argv[3] || '').trim();
    deepSet(state.config, key, val);
    writeState(state);
    process.stdout.write('ok');
    return;
  }
  if (cmd === 'models' && sub === 'set') {
    const modelId = String(argv[2] || '').trim() || 'deepseek-chat';
    deepSet(state.config, 'agents.defaults.model.primary', modelId);
    writeState(state);
    process.stdout.write('ok');
    return;
  }
  if (cmd === 'models' && sub === 'status') {
    const modelId = String(deepGet(state.config, 'agents.defaults.model.primary') || 'deepseek-chat');
    process.stdout.write(`provider=mock model=${modelId}`);
    return;
  }
  if (cmd === 'agent') {
    const prompt = extractArg('--message');
    const sessionId = extractArg('--session-id') || 'mock-session';
    const isJson = argv.includes('--json');
    const userMessage = extractUserMessage(prompt);
    const reply = isToolRouterPrompt(prompt)
      ? JSON.stringify(buildToolRouterReply(userMessage))
      : buildGeneralReply(userMessage, state, sessionId);
    if (isJson) {
      outputAgentJson(reply, sessionId);
    } else {
      process.stdout.write(String(reply || ''));
    }
    return;
  }

  process.stdout.write('');
}

main();
