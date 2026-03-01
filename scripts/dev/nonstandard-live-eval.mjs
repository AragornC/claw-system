#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('Missing DEEPSEEK_API_KEY');
  process.exit(1);
}

const prompts = [
  '哥们最近消息太炸了，给我整一个能看市场是不是慌了的分数，别整专业词。',
  '我看不懂K线，你就告诉我现在网上是在喊冲还是喊跑，做个0到1再到-1的分。',
  '别讲术语，帮我抓点实时公开数据，算个“现在偏热还是偏冷”的值。',
  '最近总怕追高，做个外部信号看看今天大家是不是在FOMO。',
  '我就想知道现在舆论是偏乐观还是偏悲观，给个能直接算出来的分。',
  '市场像坐过山车，帮我做个外部温度计，越热越接近1，越冷越接近-1。',
  '不用复杂，拿公开网站数据算个“今天危险不危险”的值给我。',
  '我不懂交易，你抓点真实网络数据，告诉我现在该激进还是保守。',
  '给我搞个信号：大家越恐慌就越负，越兴奋就越正，实时数据来。',
  '一句话需求：用网上真实数据算市场情绪分，代码能直接跑。'
];

const endpointHints = [
  'https://api.alternative.me/fng/?limit=10',
  'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
  'https://api.coingecko.com/api/v3/search/trending',
  'https://api.github.com/search/issues?q=bitcoin%20crypto&sort=updated&order=desc&per_page=20',
  'https://hn.algolia.com/api/v1/search?query=bitcoin',
  'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
  'https://api.coincap.io/v2/assets/bitcoin',
  'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  'https://api.gdax.com/products/BTC-USD/stats',
  'https://api.blockchain.info/stats'
];

function runPython(code) {
  return new Promise((resolve) => {
    const child = spawn('python', ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, stdout, stderr: `${stderr}\nTimeout` });
    }, 20000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function generateCode(userText, hint, previousError = '') {
  const system = `You generate runnable Python 3.11 code for an external market signal.
Output ONLY Python code, no markdown.
Hard requirements:
1) Must fetch REAL online data via urllib.request from a public endpoint.
2) Prefer endpoint: ${hint}
3) Must define function run_signal() returning dict with keys:
   score (float in [-1,1]), source_url (str), sample_size (int), evidence (str)
4) Must print json.dumps(run_signal(), ensure_ascii=False) in __main__.
5) Use only Python stdlib.
6) Handle network errors with fallback to another real endpoint, still returning real evidence when possible.
7) No placeholder helper names like parse_rss_titles/json_load/score_by_lexicon.
`;
  const user = `User intent: ${userText}\n${previousError ? `Previous code failed with error:\n${previousError}\nPlease fix.` : ''}`;

  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      temperature: 0.8,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });
  if (!resp.ok) {
    throw new Error(`deepseek http ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  const code = data?.choices?.[0]?.message?.content?.trim() || '';
  return code.replace(/^```(?:python)?\n?/i, '').replace(/```$/,'').trim();
}

const results = [];
for (let i = 0; i < prompts.length; i += 1) {
  const input = prompts[i];
  const hint = endpointHints[i % endpointHints.length];
  let attempt = 0;
  let error = '';
  let success = null;
  let code = '';
  while (attempt < 6) {
    attempt += 1;
    code = await generateCode(input, hint, error.slice(0, 1200));
    const exec = await runPython(code);
    if (!exec.ok) {
      error = exec.stderr || exec.stdout || 'unknown python error';
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(exec.stdout.trim().split('\n').filter(Boolean).at(-1));
    } catch (e) {
      error = `json parse failed: ${e.message}; stdout=${exec.stdout.slice(0,500)}`;
      continue;
    }
    const scoreNum = Number(parsed?.score);
    if (!Number.isFinite(scoreNum) || typeof parsed?.source_url !== 'string' || !/^https?:\/\//.test(parsed.source_url) || Number(parsed?.sample_size) <= 0) {
      error = `invalid output ${JSON.stringify(parsed).slice(0,500)}`;
      continue;
    }
    success = { execOut: parsed, rawStdout: exec.stdout };
    break;
  }
  if (!success) {
    results.push({ input, ok: false, attempts: attempt, lastError: error, code });
    continue;
  }
  results.push({ input, ok: true, attempts: attempt, code, result: success.execOut });
}

const out = { generatedAt: new Date().toISOString(), total: results.length, success: results.filter(r=>r.ok).length, results };
await fs.mkdir('.artifacts', { recursive: true });
await fs.writeFile('.artifacts/nonstandard-live-eval.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ total: out.total, success: out.success, artifact: '.artifacts/nonstandard-live-eval.json' }, null, 2));
if (out.success !== out.total) process.exit(2);
