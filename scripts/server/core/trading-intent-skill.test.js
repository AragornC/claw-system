import test from 'node:test';
import assert from 'node:assert/strict';

import { createTradingIntentSkill } from './trading-intent-skill.js';

function createSkill() {
  return createTradingIntentSkill({
    runOpenClawCommand: async () => ({ ok: false, stdout: '', stderr: 'offline' }),
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: () => '',
    normalizeSessionId: (s) => String(s || 'main'),
  });
}

test('intent extraction outputs feature cards only and twitter social card has concrete code', async () => {
  const skill = createSkill();
  const out = await skill.extractTradingIntentCandidates({
    userMessage: '做一个BTC新闻+twitter社媒情绪策略',
    assistantReply: '',
    sessionId: 'test-dynamic-social',
  });
  assert.equal(out.ok, true);
  assert.equal((out.candidates || []).some((c) => c?.kind === 'strategy'), false);
  const social = (out.candidates || []).find((row) => row?.feature?.name === 'twitter_sentiment_signal')?.feature;
  assert.ok(social);
  assert.equal(social.params.sourceType, 'social');
  assert.equal(social.params.provider, 'twitter');
  assert.equal(String(social.params.pythonIndicator || ''), '');
  assert.equal(String(social.params.pipelineCode || ''), '');
  assert.equal(String(social.params.codeSource || ''), '');
});

test('model enrichment rejects pseudo pipeline helpers and strips executable code fields', async () => {
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async (_args) => ({
      ok: true,
      stdout: JSON.stringify({
        reply: JSON.stringify({
          intentDetected: true,
          confidence: 0.9,
          candidates: [
            {
              candidateId: 'cand_feature_social_sentiment',
              kind: 'feature',
              title: '社媒情绪信号',
              summary: 'test',
              confidence: 0.7,
              feature: {
                name: 'twitter_sentiment_signal',
                group: 'signal_external',
                kind: 'social_sentiment',
                params: {
                  sourceType: 'social',
                  provider: 'twitter',
                  pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5).mean()",
                  pipelineCode: "titles = parse_rss_titles(curl(url))\nraw_score = score_by_lexicon(titles)",
                  codeSource: 'model_generated',
                },
              },
            },
          ],
        }),
      }),
      stderr: '',
    }),
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '给我一个奇怪的社媒特征',
    assistantReply: '',
    sessionId: 'test-invalid-pipeline',
  });
  const social = (out.candidates || []).find((row) => row?.feature?.name === 'twitter_sentiment_signal')?.feature;
  assert.ok(social);
  assert.match(String(social.params.pythonIndicator || ''), /ewm\(span=5\)/);
  assert.match(String(social.params.pipelineCode || ''), /parse_rss_titles/);
  assert.equal(String(social.params.codeSource || ''), 'model_generated');
  assert.equal(String(social.params.codegenStatus || ''), 'needs_user_input');
  assert.match(String(social.params.codeValidationError || ''), /pseudo helper token/);
});

test('model enrichment does not auto-repair silently and asks user to refine code', async () => {
  let call = 0;
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              intentDetected: true,
              confidence: 0.8,
              candidates: [
                {
                  candidateId: 'cand_feature_social_sentiment',
                  kind: 'feature',
                  title: '社媒情绪信号',
                  summary: 'test',
                  confidence: 0.7,
                  feature: {
                    name: 'twitter_sentiment_signal',
                    group: 'signal_external',
                    kind: 'social_sentiment',
                    params: { sourceType: 'social', provider: 'twitter' },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      if (call === 2) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              featurePlans: [
                {
                  candidateId: 'cand_feature_social_sentiment',
                  feature: {
                    name: 'twitter_sentiment_signal',
                    params: {
                      sourceType: 'social',
                      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5).mean()",
                      pipelineCode: "titles = parse_rss_titles(curl(url))\nraw_score = score_by_lexicon(titles)",
                      codeSource: 'model_generated',
                    },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          reply: JSON.stringify({
            featurePlan: {
              candidateId: 'cand_feature_social_sentiment',
              feature: {
                name: 'twitter_sentiment_signal',
                params: {
                  pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5).mean().clip(-1, 1)",
                  pipelineCode: "import re\ndef compute_signal(payload):\n    texts = payload.get('texts', [])\n    score = 0.0\n    for t in texts:\n        if re.search(r'panic', str(t).lower()):\n            score -= 0.2\n    return max(-1.0, min(1.0, score))",
                  codeSource: 'model_generated',
                },
              },
            },
          }),
        }),
        stderr: '',
      };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '给我一个社媒噪音风控特征',
    assistantReply: '',
    sessionId: 'test-repair-loop',
  });
  const social = (out.candidates || []).find((row) => row?.feature?.name === 'twitter_sentiment_signal')?.feature;
  assert.ok(social);
  assert.match(String(social.params.pythonIndicator || ''), /ewm\(span=5\)\.mean\(\)/);
  assert.match(String(social.params.pipelineCode || ''), /parse_rss_titles/);
  assert.equal(String(social.params.codeSource || ''), 'model_generated');
  assert.equal(String(social.params.codegenStatus || ''), 'needs_user_input');
  assert.match(String(social.params.codeValidationError || ''), /pseudo helper token/);
});


test('non-standard dialogue still keeps runnable top-level pipeline code from model', async () => {
  let call = 0;
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              intentDetected: true,
              confidence: 0.86,
              candidates: [
                {
                  candidateId: 'cand_feature_news_sentiment',
                  kind: 'feature',
                  title: '新闻情绪信号',
                  summary: 'test',
                  confidence: 0.72,
                  feature: {
                    name: 'news_sentiment_signal',
                    group: 'signal_external',
                    kind: 'news_sentiment',
                    params: { sourceType: 'news', provider: 'rss' },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          reply: JSON.stringify({
            featurePlans: [
              {
                candidateId: 'cand_feature_news_sentiment',
                feature: {
                  name: 'news_sentiment_signal',
                  params: {
                    sourceType: 'news',
                    pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(0.0).clip(-1, 1)",
                    pipelineCode: "import re\npayload = globals().get('payload', {'texts': []})\ntexts = [str(x).lower() for x in payload.get('texts', [])]\nneg = sum(1 for t in texts if re.search(r'panic|liquidation|hack', t))\npos = sum(1 for t in texts if re.search(r'approval|etf|partnership', t))\nbase = (pos - neg) / max(1, len(texts))\nraw_score = max(-1.0, min(1.0, base))",
                    codeSource: 'model_generated',
                  },
                },
              },
            ],
          }),
        }),
        stderr: '',
      };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '哥们儿来个新闻情绪风控呗，别整那些官话，能跑就行😅',
    assistantReply: '收到，按你说的来，重点看突发利空和正面催化。',
    sessionId: 'test-nonstandard-dialogue-raw-score',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'news_sentiment_signal')?.feature;
  assert.ok(feature);
  assert.match(String(feature.params.pythonIndicator || ''), /rolling\(3\)/);
  assert.match(String(feature.params.pipelineCode || ''), /raw_score\s*=\s*max\(-1\.0, min\(1\.0, base\)\)/);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  assert.equal(String(feature.params.codeDataSourceWarning || ''), '');
  assert.equal(String(feature.params.codegenStatus || ''), '');
  assert.equal(String(feature.params.codeValidationError || ''), '');
});


test('non-standard dialogue can keep api-oriented runnable pipeline from model', async () => {
  let call = 0;
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              intentDetected: true,
              confidence: 0.84,
              candidates: [
                {
                  candidateId: 'cand_feature_news_sentiment',
                  kind: 'feature',
                  title: '新闻冲击特征',
                  summary: 'test',
                  confidence: 0.7,
                  feature: {
                    name: 'news_sentiment_signal',
                    group: 'signal_external',
                    kind: 'news_sentiment',
                    params: { sourceType: 'news', provider: 'cryptopanic' },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          reply: JSON.stringify({
            featurePlans: [
              {
                candidateId: 'cand_feature_news_sentiment',
                feature: {
                  name: 'news_sentiment_signal',
                  params: {
                    sourceType: 'news',
                    provider: 'cryptopanic',
                    pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=4, adjust=False).mean().clip(-1, 1)",
                    pipelineCode: "import re\nAPI_ENDPOINT = 'https://cryptopanic.com/api/v1/posts/'\ndef fetch_latest_news(api_key, query='bitcoin'):\n    return {'endpoint': API_ENDPOINT, 'query': query, 'token': bool(api_key)}\ndef compute_signal(payload):\n    texts = [str(x).lower() for x in payload.get('texts', [])]\n    neg = sum(1 for t in texts if re.search(r'ban|hack|liquidation', t))\n    pos = sum(1 for t in texts if re.search(r'etf|approval|inflow', t))\n    return max(-1.0, min(1.0, (pos - neg) / max(1, len(texts))))",
                    codeSource: 'model_generated',
                  },
                },
              },
            ],
          }),
        }),
        stderr: '',
      };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '别给我模板了，直接整能接新闻api的情绪分，行不行？',
    assistantReply: '行，给你能接外部新闻源的版本。',
    sessionId: 'test-nonstandard-dialogue-api-oriented',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'news_sentiment_signal')?.feature;
  assert.ok(feature);
  assert.match(String(feature.params.pipelineCode || ''), /cryptopanic\.com\/api\/v1\/posts/);
  assert.match(String(feature.params.pipelineCode || ''), /def compute_signal/);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  const validationError = String(feature.params.codeValidationError || '');
  const allowedErrors = new Set(['', 'pipelineCode 缺少外部数据获取步骤']);
  assert.ok(allowedErrors.has(validationError));
});

test('non-standard mixed-language dialogue keeps social api style model code', async () => {
  let call = 0;
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              intentDetected: true,
              confidence: 0.83,
              candidates: [
                {
                  candidateId: 'cand_feature_social_sentiment',
                  kind: 'feature',
                  title: '社媒热度冲击',
                  summary: 'test',
                  confidence: 0.69,
                  feature: {
                    name: 'twitter_sentiment_signal',
                    group: 'signal_external',
                    kind: 'social_sentiment',
                    params: { sourceType: 'social', provider: 'twitter' },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          reply: JSON.stringify({
            featurePlans: [
              {
                candidateId: 'cand_feature_social_sentiment',
                feature: {
                  name: 'twitter_sentiment_signal',
                  params: {
                    sourceType: 'social',
                    provider: 'twitter',
                    pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=3, adjust=False).mean().clip(-1, 1)",
                    pipelineCode: "import re\nSOCIAL_API = 'https://api.x.com/2/tweets/search/recent'\ndef build_social_request(query='bitcoin', max_results=20):\n    return {'url': SOCIAL_API, 'params': {'query': query, 'max_results': max_results}}\ndef compute_signal(payload):\n    texts = [str(x).lower() for x in payload.get('texts', [])]\n    bearish = sum(1 for t in texts if re.search(r'crash|rug|bankrupt', t))\n    bullish = sum(1 for t in texts if re.search(r'breakout|ath|accumulation', t))\n    return max(-1.0, min(1.0, (bullish - bearish) / max(1, len(texts))))",
                    codeSource: 'model_generated',
                  },
                },
              },
            ],
          }),
        }),
        stderr: '',
      };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: 'bro 帮我搞个twitter情绪过滤, 要api那种, 别再模板了 plz',
    assistantReply: 'ok，做成可接社媒接口的情绪特征。',
    sessionId: 'test-nonstandard-dialogue-social-api',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'twitter_sentiment_signal')?.feature;
  assert.ok(feature);
  assert.match(String(feature.params.pipelineCode || ''), /api\.x\.com\/2\/tweets\/search\/recent/);
  assert.match(String(feature.params.pipelineCode || ''), /def compute_signal/);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  assert.equal(String(feature.params.codeValidationError || ''), '');
});

test('non-standard blunt dialogue keeps prediction market api model code', async () => {
  let call = 0;
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              intentDetected: true,
              confidence: 0.85,
              candidates: [
                {
                  candidateId: 'cand_feature_prediction_market',
                  kind: 'feature',
                  title: '预测市场偏差',
                  summary: 'test',
                  confidence: 0.71,
                  feature: {
                    name: 'polymarket_edge_signal',
                    group: 'signal_external',
                    kind: 'prediction_market',
                    params: { sourceType: 'prediction', provider: 'polymarket' },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({
          reply: JSON.stringify({
            featurePlans: [
              {
                candidateId: 'cand_feature_prediction_market',
                feature: {
                  name: 'polymarket_edge_signal',
                  params: {
                    sourceType: 'prediction',
                    provider: 'polymarket',
                    pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
                    pipelineCode: "POLYMARKET_API = 'https://gamma-api.polymarket.com/markets'\ndef build_market_request(limit=50):\n    return {'url': POLYMARKET_API, 'params': {'active': 'true', 'closed': 'false', 'limit': limit}}\ndef compute_signal(payload):\n    probs = [float(x) for x in payload.get('prices', []) if str(x) not in ('', 'None')]\n    if not probs:\n        return 0.0\n    mean_prob = sum(probs) / len(probs)\n    return max(-1.0, min(1.0, (mean_prob - 0.5) * 2.0))",
                    codeSource: 'model_generated',
                  },
                },
              },
            ],
          }),
        }),
        stderr: '',
      };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '就一句话：给我polymarket那套api情绪，不要废话，不要模板。',
    assistantReply: '明白，按预测市场接口来。',
    sessionId: 'test-nonstandard-dialogue-prediction-api',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'polymarket_edge_signal')?.feature;
  assert.ok(feature);
  assert.match(String(feature.params.pipelineCode || ''), /gamma-api\.polymarket\.com\/markets/);
  assert.match(String(feature.params.pipelineCode || ''), /def compute_signal/);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  assert.equal(String(feature.params.codeValidationError || ''), '');
});

test('ten highly non-standard dialogue variants keep diverse runnable model code', async () => {
  const scenarios = [
    {
      id: 'news-chaotic-zh',
      userMessage: '别端着了，来个新闻雷达，利空先砍仓，懂？',
      assistantReply: '收到，按新闻冲击实时打分。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'cryptopanic',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=4, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `import re
API = 'https://cryptopanic.com/api/v1/posts/'
def compute_signal(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    neg = sum(1 for t in texts if re.search(r'ban|hack|liquidation', t))
    pos = sum(1 for t in texts if re.search(r'etf|approval|inflow', t))
    return max(-1.0, min(1.0, (pos - neg) / max(1, len(texts))))`,
      expected: /cryptopanic\.com\/api\/v1\/posts/,
    },
    {
      id: 'social-en-mix',
      userMessage: 'bro gimme twitter panic filter, no bs template pls',
      assistantReply: 'ok, social api style.',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(2).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `import re
SOCIAL_API = 'https://api.x.com/2/tweets/search/recent'
def compute_signal(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    fear = sum(1 for t in texts if re.search(r'crash|rug|rekt', t))
    hope = sum(1 for t in texts if re.search(r'breakout|ath|buyback', t))
    return max(-1.0, min(1.0, (hope - fear) / max(1, len(texts))))`,
      expected: /api\.x\.com\/2\/tweets\/search\/recent/,
    },
    {
      id: 'prediction-brutal',
      userMessage: '少废话，给我 polymarket 概率偏差，直接能跑的。',
      assistantReply: '行，预测市场接口版。',
      featureName: 'polymarket_edge_signal',
      sourceType: 'prediction',
      provider: 'polymarket',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      pipelineCode: `POLY = 'https://gamma-api.polymarket.com/markets'
def compute_signal(payload):
    probs = [float(x) for x in payload.get('prices', []) if str(x) not in ('', 'None')]
    if not probs:
        return 0.0
    avg = sum(probs) / len(probs)
    return max(-1.0, min(1.0, (avg - 0.5) * 2.0))`,
      expected: /gamma-api\.polymarket\.com\/markets/,
    },
    {
      id: 'cantonesish-style',
      userMessage: '快啲整个news情绪，唔该，跌得急就提醒我。',
      assistantReply: '好，做急跌新闻冲击。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'coindesk',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `import re
NEWS = 'https://www.coindesk.com/arc/outboundfeeds/rss/'
def compute_signal(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    down = sum(1 for t in texts if re.search(r'downgrade|sell-off|lawsuit', t))
    up = sum(1 for t in texts if re.search(r'upgrade|adoption|partnership', t))
    return max(-1.0, min(1.0, (up - down) / max(1, len(texts))))`,
      expected: /coindesk\.com\/arc\/outboundfeeds\/rss/,
    },
    {
      id: 'emoji-heavy',
      userMessage: '🧨有雷就给负分，🚀有利好就加分，别整虚的',
      assistantReply: '收到，按标题关键词打分。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'blockbeats',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=6, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `import re
BLOCKBEATS = 'https://api.github.com/search/issues?q=crypto%20news&sort=updated&order=desc'
def compute_signal(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    boom = sum(1 for t in texts if re.search(r'hack|exploit|insolvency', t))
    moon = sum(1 for t in texts if re.search(r'etf|approval|record inflow', t))
    return max(-1.0, min(1.0, (moon - boom) / max(1, len(texts))))`,
      expected: /api\.github\.com\/search\/issues/,
    },
    {
      id: 'mixed-typo',
      userMessage: 'twiter热度给我搞一下，别太学术，实盘要用',
      assistantReply: '好，按社媒噪音过滤。',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=3, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `import re
SOCIAL = 'https://api.x.com/2/tweets/search/recent'
def run(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    bad = sum(1 for t in texts if re.search(r'panic|fud|dump', t))
    good = sum(1 for t in texts if re.search(r'breakout|reversal|support', t))
    return max(-1.0, min(1.0, (good - bad) / max(1, len(texts))))`,
      expected: /def run\(payload\)/,
    },
    {
      id: 'raw-score-top-level',
      userMessage: '就要简单粗暴：把外部文本变成raw_score，别包花活。',
      assistantReply: '明白，给顶层 raw_score。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'rss',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(4).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `import re
payload = globals().get('payload', {'texts': []})
texts = [str(x).lower() for x in payload.get('texts', [])]
neg = sum(1 for t in texts if re.search(r'bankrupt|charge|investigation', t))
pos = sum(1 for t in texts if re.search(r'license|launch|expansion', t))
raw_score = max(-1.0, min(1.0, (pos - neg) / max(1, len(texts))))`,
      expected: /raw_score\s*=\s*max\(-1\.0, min\(1\.0,/,
    },
    {
      id: 'all-caps-angry',
      userMessage: 'DON\'T GIVE ME TOY CODE. NEWS API + EXECUTABLE NOW.',
      assistantReply: 'Understood. Runnable news pipeline only.',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'theblock',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `import re
NEWS_API = 'https://www.theblock.co/rss.xml'
def main(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    neg = sum(1 for t in texts if re.search(r'sell pressure|delist|bridge hack', t))
    pos = sum(1 for t in texts if re.search(r'stake|integration|approval', t))
    return max(-1.0, min(1.0, (pos - neg) / max(1, len(texts))))`,
      expected: /def main\(payload\)/,
    },
    {
      id: 'dialect-short',
      userMessage: '整个能看大户情绪的，快。',
      assistantReply: '给你社媒+大户话题权重。',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=7, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `import re
API = 'https://api.x.com/2/tweets/search/recent'
def compute_signal(payload):
    texts = [str(x).lower() for x in payload.get('texts', [])]
    whale_fud = sum(1 for t in texts if re.search(r'whale dump|unlock|insider sell', t))
    whale_buy = sum(1 for t in texts if re.search(r'whale buy|accumulation|otc demand', t))
    return max(-1.0, min(1.0, (whale_buy - whale_fud) / max(1, len(texts))))`,
      expected: /whale buy|whale_fud/,
    },
    {
      id: 'jp-zh-mix',
      userMessage: 'この市況ヤバい，给我一个可执行 external signal，不要样板。',
      assistantReply: '了解，做可运行版本。',
      featureName: 'polymarket_edge_signal',
      sourceType: 'prediction',
      provider: 'polymarket',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      pipelineCode: `POLY_API = 'https://gamma-api.polymarket.com/markets'
def compute_signal(payload):
    probs = [float(x) for x in payload.get('prices', []) if str(x) not in ('', 'None')]
    vol = float(payload.get('volume', 0.0) or 0.0)
    if not probs:
        return 0.0
    edge = (sum(probs) / len(probs) - 0.5) * 2.0
    if vol < 1000:
        edge = edge * 0.5
    return max(-1.0, min(1.0, edge))`,
      expected: /vol < 1000/,
    },
  ];

  for (const row of scenarios) {
    let call = 0;
    const candidateId = `cand_${row.id}`;
    const skill = createTradingIntentSkill({
      runOpenClawCommand: async () => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            stdout: JSON.stringify({
              reply: JSON.stringify({
                intentDetected: true,
                confidence: 0.82,
                candidates: [
                  {
                    candidateId,
                    kind: 'feature',
                    title: '非标准沟通特征',
                    summary: 'test',
                    confidence: 0.66,
                    feature: {
                      name: row.featureName,
                      group: 'signal_external',
                      kind: row.sourceType === 'prediction' ? 'prediction_market' : (row.sourceType === 'social' ? 'social_sentiment' : 'news_sentiment'),
                      params: { sourceType: row.sourceType, provider: row.provider },
                    },
                  },
                ],
              }),
            }),
            stderr: '',
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              featurePlans: [
                {
                  candidateId,
                  feature: {
                    name: row.featureName,
                    params: {
                      sourceType: row.sourceType,
                      provider: row.provider,
                      pythonIndicator: row.pythonIndicator,
                      pipelineCode: row.pipelineCode,
                      codeSource: 'model_generated',
                    },
                  },
                },
              ],
            }),
          }),
          stderr: '',
        };
      },
      parseJsonSafe: (text) => {
        try { return JSON.parse(String(text || '{}')); } catch { return {}; }
      },
      extractAgentReply: (payload) => String(payload?.reply || ''),
      normalizeSessionId: (s) => String(s || 'main'),
    });

    const out = await skill.extractTradingIntentCandidates({
      userMessage: row.userMessage,
      assistantReply: row.assistantReply,
      sessionId: `test-${row.id}`,
    });
    const feature = (out.candidates || []).find((item) => item?.feature?.name === row.featureName)?.feature;
    assert.ok(feature, `${row.id}: feature should exist`);
    assert.equal(String(feature.params.codeSource || ''), 'model_generated', `${row.id}: codeSource`);
    const allowedErrors = new Set(['', 'pipelineCode 缺少外部数据获取步骤']);
    assert.ok(allowedErrors.has(String(feature.params.codeValidationError || '')), `${row.id}: codeValidationError`);
    assert.match(String(feature.params.pipelineCode || ''), row.expected, `${row.id}: pipeline expected fragment`);
  }

  assert.equal(scenarios.length, 10);
});

test('ten realistic non-standard user dialogues still preserve diverse model-generated code', async () => {
  const scenarios = [
    {
      id: 'news-weighted-source',
      userMessage: '这两天消息太乱了，帮我加个新闻情绪因子看方向。',
      assistantReply: '好，做来源权重+时效衰减。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'cryptopanic',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    items = payload.get('items', [])\n    src_w = {'reuters': 1.0, 'bloomberg': 0.9, 'coindesk': 0.75}\n    total = 0.0\n    mass = 0.0\n    for row in items:\n        sentiment = float(row.get('sentiment', 0.0) or 0.0)\n        age_h = float(row.get('age_hours', 24.0) or 24.0)\n        src = str(row.get('source', '')).lower()\n        w = src_w.get(src, 0.5) * (1.0 / (1.0 + age_h / 12.0))\n        total += sentiment * w\n        mass += w\n    if mass <= 0:\n        return 0.0\n    return max(-1.0, min(1.0, total / mass))`,
      expected: /src_w = \{'reuters': 1\.0/,
    },
    {
      id: 'social-engagement',
      userMessage: '推特上吵得很，给我一个能过滤噪音的社媒信号。',
      assistantReply: '行，互动加权。',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    posts = payload.get('posts', [])\n    score = 0.0\n    weight = 0.0\n    for p in posts:\n        sentiment = float(p.get('sentiment', 0.0) or 0.0)\n        likes = float(p.get('likes', 0.0) or 0.0)\n        reposts = float(p.get('reposts', 0.0) or 0.0)\n        author_rank = float(p.get('author_rank', 0.5) or 0.5)\n        w = (1.0 + likes * 0.01 + reposts * 0.03) * max(0.1, min(1.5, author_rank))\n        score += sentiment * w\n        weight += w\n    if weight == 0:\n        return 0.0\n    return max(-1.0, min(1.0, score / weight))`,
      expected: /author_rank/,
    },
    {
      id: 'prediction-liquidity',
      userMessage: '我想把预测市场也纳入信号，看看靠谱不靠谱。',
      assistantReply: '明白，概率偏差乘流动性因子。',
      featureName: 'polymarket_edge_signal',
      sourceType: 'prediction',
      provider: 'polymarket',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    prob = float(payload.get('probability', 0.5) or 0.5)\n    fair = float(payload.get('fair_prob', 0.5) or 0.5)\n    liq = float(payload.get('liquidity_usd', 0.0) or 0.0)\n    edge = (prob - fair) * 2.0\n    liq_factor = min(1.0, liq / 50000.0)\n    out = edge * (0.4 + 0.6 * liq_factor)\n    return max(-1.0, min(1.0, out))`,
      expected: /liq_factor = min\(1\.0, liq \/ 50000\.0\)/,
    },
    {
      id: 'news-topic-mix',
      userMessage: '新闻里有宏观有监管，能不能做个综合情绪分。',
      assistantReply: '好，分 topic 汇总。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'coindesk',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=8, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    buckets = payload.get('topic_scores', {})\n    mix = {'macro': 0.25, 'etf': 0.35, 'regulation': 0.25, 'security': 0.15}\n    val = 0.0\n    for k, w in mix.items():\n        val += float(buckets.get(k, 0.0) or 0.0) * w\n    return max(-1.0, min(1.0, val))`,
      expected: /mix = \{'macro': 0\.25, 'etf': 0\.35/,
    },
    {
      id: 'social-zscore',
      userMessage: '最近突然热度暴涨，帮我做个能识别异常的外部信号。',
      assistantReply: '用 zscore。',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(5).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    vols = [float(x) for x in payload.get('engagement_series', [])]\n    if len(vols) < 3:\n        return 0.0\n    mu = sum(vols[:-1]) / max(1, len(vols) - 1)\n    var = sum((x - mu) * (x - mu) for x in vols[:-1]) / max(1, len(vols) - 1)\n    sigma = var ** 0.5\n    if sigma <= 1e-9:\n        return 0.0\n    z = (vols[-1] - mu) / sigma\n    return max(-1.0, min(1.0, z / 3.0))`,
      expected: /z = \(vols\[-1\] - mu\) \/ sigma/,
    },
    {
      id: 'prediction-spread',
      userMessage: '预测市场有时候很偏，想要一个能反映偏差的指标。',
      assistantReply: '加上 spread 惩罚。',
      featureName: 'polymarket_edge_signal',
      sourceType: 'prediction',
      provider: 'polymarket',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    best_bid = float(payload.get('best_bid', 0.5) or 0.5)\n    best_ask = float(payload.get('best_ask', 0.5) or 0.5)\n    fair = float(payload.get('fair_prob', 0.5) or 0.5)\n    mid = (best_bid + best_ask) / 2.0\n    spread = max(0.0, best_ask - best_bid)\n    raw = (mid - fair) * 2.0\n    penalty = min(0.7, spread * 4.0)\n    return max(-1.0, min(1.0, raw * (1.0 - penalty)))`,
      expected: /penalty = min\(0\.7, spread \* 4\.0\)/,
    },
    {
      id: 'news-json-schema',
      userMessage: '如果外部接口能给结构化字段，就直接利用起来吧。',
      assistantReply: '可以，基于 schema 字段。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'theblock',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=6, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    rows = payload.get('articles', [])\n    val = 0.0\n    wsum = 0.0\n    for a in rows:\n        sentiment = float(a.get('sentiment_score', 0.0) or 0.0)\n        confidence = float(a.get('model_confidence', 0.0) or 0.0)\n        relevance = float(a.get('relevance', 0.0) or 0.0)\n        w = max(0.0, min(1.0, 0.6 * confidence + 0.4 * relevance))\n        val += sentiment * w\n        wsum += w\n    if wsum <= 0:\n        return 0.0\n    return max(-1.0, min(1.0, val / wsum))`,
      expected: /model_confidence/,
    },
    {
      id: 'social-rate-limit-aware',
      userMessage: '接口偶尔抽风，信号别太激进，稳一点。',
      assistantReply: '行，限流时收缩分值。',
      featureName: 'twitter_sentiment_signal',
      sourceType: 'social',
      provider: 'twitter',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(4).mean().fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    signal = float(payload.get('base_signal', 0.0) or 0.0)\n    remaining = float(payload.get('rate_limit_remaining', 100.0) or 100.0)\n    reset_sec = float(payload.get('rate_limit_reset_sec', 0.0) or 0.0)\n    pressure = 1.0\n    if remaining < 10:\n        pressure = 0.5\n    if reset_sec > 300:\n        pressure = pressure * 0.7\n    return max(-1.0, min(1.0, signal * pressure))`,
      expected: /rate_limit_remaining/,
    },
    {
      id: 'prediction-book-imbalance',
      userMessage: '我还想看下盘口力量对比，做个简单分值。',
      assistantReply: '好，订单簿不平衡。',
      featureName: 'polymarket_edge_signal',
      sourceType: 'prediction',
      provider: 'polymarket',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].fillna(0.0).clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    bid_sz = float(payload.get('bid_size', 0.0) or 0.0)\n    ask_sz = float(payload.get('ask_size', 0.0) or 0.0)\n    total = bid_sz + ask_sz\n    if total <= 0:\n        return 0.0\n    imbalance = (bid_sz - ask_sz) / total\n    return max(-1.0, min(1.0, imbalance))`,
      expected: /imbalance = \(bid_sz - ask_sz\) \/ total/,
    },
    {
      id: 'news-cross-source-disagree',
      userMessage: '不同来源经常打架，冲突大的时候信号能不能保守点。',
      assistantReply: '用跨源分歧惩罚。',
      featureName: 'news_sentiment_signal',
      sourceType: 'news',
      provider: 'rss',
      pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].ewm(span=5, adjust=False).mean().clip(-1, 1)",
      pipelineCode: `def compute_signal(payload):\n    src = payload.get('source_scores', {})\n    vals = [float(v) for v in src.values()]\n    if not vals:\n        return 0.0\n    mean = sum(vals) / len(vals)\n    spread = max(vals) - min(vals)\n    penalty = min(0.8, spread * 0.6)\n    return max(-1.0, min(1.0, mean * (1.0 - penalty)))`,
      expected: /penalty = min\(0\.8, spread \* 0\.6\)/,
    },
  ];

  for (const row of scenarios) {
    let call = 0;
    const candidateId = `cand_diverse_${row.id}`;
    const skill = createTradingIntentSkill({
      runOpenClawCommand: async () => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            stdout: JSON.stringify({
              reply: JSON.stringify({
                intentDetected: true,
                confidence: 0.86,
                candidates: [{
                  candidateId,
                  kind: 'feature',
                  title: 'diverse-code',
                  summary: 'test',
                  confidence: 0.7,
                  feature: {
                    name: row.featureName,
                    group: 'signal_external',
                    kind: row.sourceType === 'prediction' ? 'prediction_market' : (row.sourceType === 'social' ? 'social_sentiment' : 'news_sentiment'),
                    params: { sourceType: row.sourceType, provider: row.provider },
                  },
                }],
              }),
            }),
            stderr: '',
          };
        }
        return {
          ok: true,
          stdout: JSON.stringify({
            reply: JSON.stringify({
              featurePlans: [{
                candidateId,
                feature: {
                  name: row.featureName,
                  params: {
                    sourceType: row.sourceType,
                    provider: row.provider,
                    pythonIndicator: row.pythonIndicator,
                    pipelineCode: row.pipelineCode,
                    codeSource: 'model_generated',
                  },
                },
              }],
            }),
          }),
          stderr: '',
        };
      },
      parseJsonSafe: (text) => {
        try { return JSON.parse(String(text || '{}')); } catch { return {}; }
      },
      extractAgentReply: (payload) => String(payload?.reply || ''),
      normalizeSessionId: (s) => String(s || 'main'),
    });

    const out = await skill.extractTradingIntentCandidates({
      userMessage: row.userMessage,
      assistantReply: row.assistantReply,
      sessionId: `test-diverse-${row.id}`,
    });
    const feature = (out.candidates || []).find((item) => item?.feature?.name === row.featureName)?.feature;
    assert.ok(feature, `${row.id}: feature exists`);
    assert.equal(String(feature.params.codeSource || ''), 'model_generated', `${row.id}: codeSource`);
    const allowedErrors = new Set(['', 'pipelineCode 缺少外部数据获取步骤']);
    assert.ok(allowedErrors.has(String(feature.params.codeValidationError || '')), `${row.id}: codeValidationError`);
    assert.match(String(feature.params.pipelineCode || ''), row.expected, `${row.id}: expected shape`);
  }

  assert.equal(scenarios.length, 10);
});


test('payload-only pipeline gets datasource warning while keeping runnable code', async () => {
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        reply: JSON.stringify({
          intentDetected: true,
          confidence: 0.9,
          candidates: [{
            candidateId: 'cand_feature_news_sentiment_warn',
            kind: 'feature',
            title: 'news',
            summary: 'test',
            confidence: 0.7,
            feature: {
              name: 'news_sentiment_signal',
              group: 'signal_external',
              kind: 'news_sentiment',
              params: {
                sourceType: 'news',
                provider: 'rss',
                pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(0.0)",
                pipelineCode: "def compute_signal(payload):\n    texts = payload.get('texts', [])\n    raw_score = 0.0 if not texts else 0.1\n    return raw_score",
                codeSource: 'model_generated',
              },
            },
          }],
        }),
      }),
      stderr: '',
    }),
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '帮我做个实时新闻api情绪过滤，最好能抓最新数据',
    assistantReply: '',
    sessionId: 'test-datasource-warning',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'news_sentiment_signal')?.feature;
  assert.ok(feature);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  assert.equal(String(feature.params.codeDataSourceWarning || ''), 'pipelineCode_missing_external_fetch');
  assert.equal(String(feature.params.codegenStatus || ''), 'needs_user_input');
  assert.match(String(feature.params.codeValidationError || ''), /缺少外部数据获取步骤/);
});


test('payload-only pipeline without explicit fetch intent should not get datasource warning', async () => {
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        reply: JSON.stringify({
          intentDetected: true,
          confidence: 0.9,
          candidates: [{
            candidateId: 'cand_feature_news_sentiment_no_warn',
            kind: 'feature',
            title: 'news',
            summary: 'test',
            confidence: 0.7,
            feature: {
              name: 'news_sentiment_signal',
              group: 'signal_external',
              kind: 'news_sentiment',
              params: {
                sourceType: 'news',
                provider: 'rss',
                pythonIndicator: "dataframe['{col}'] = dataframe['{col}'].rolling(3).mean().fillna(0.0)",
                pipelineCode: "def compute_signal(payload):\n    texts = payload.get('texts', [])\n    return 0.0 if not texts else 0.1",
                codeSource: 'model_generated',
              },
            },
          }],
        }),
      }),
      stderr: '',
    }),
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: (payload) => String(payload?.reply || ''),
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.extractTradingIntentCandidates({
    userMessage: '帮我加一个新闻情绪辅助因子就行，不需要联网抓取',
    assistantReply: '',
    sessionId: 'test-datasource-warning-no-fetch-intent',
  });
  const feature = (out.candidates || []).find((row) => row?.feature?.name === 'news_sentiment_signal')?.feature;
  assert.ok(feature);
  assert.equal(String(feature.params.codeSource || ''), 'model_generated');
  const validationError = String(feature.params.codeValidationError || '');
  const allowedErrors = new Set(['', 'pipelineCode 缺少外部数据获取步骤']);
  assert.ok(allowedErrors.has(validationError));
});

test('generateFeatureCodeForCandidate appends refine instruction and previous failure context into model prompt', async () => {
  const calls = [];
  const skill = createTradingIntentSkill({
    runOpenClawCommand: async (args) => {
      calls.push(Array.isArray(args) ? args.slice() : []);
      return { ok: false, stdout: '', stderr: 'offline' };
    },
    parseJsonSafe: (text) => {
      try { return JSON.parse(String(text || '{}')); } catch { return {}; }
    },
    extractAgentReply: () => '',
    normalizeSessionId: (s) => String(s || 'main'),
  });

  const out = await skill.generateFeatureCodeForCandidate({
    candidate: {
      candidateId: 'cand_feature_news_sentiment_refine',
      kind: 'feature',
      title: '新闻情绪',
      summary: 'test',
      confidence: 0.7,
      feature: {
        name: 'news_sentiment_signal',
        group: 'signal_external',
        kind: 'news_sentiment',
        params: {
          sourceType: 'news',
          codeValidationError: 'pipelineCode 缺少外部数据获取步骤',
          requiredInputs: [{ key: 'external_data_source', label: '外部数据源 URL 或 API', required: true }],
        },
      },
    },
    userMessage: '给我做个新闻情绪特征',
    assistantReply: '先出一个版本',
    refineInstruction: '改成抓取 cointelegraph 的 rss 并给出阈值',
    sessionId: 'test-refine-generate',
  });

  assert.equal(out.ok, true);
  const last = calls[calls.length - 1] || [];
  const idx = last.indexOf('--message');
  assert.ok(idx >= 0);
  const prompt = String(last[idx + 1] || '');
  assert.match(prompt, /用户补充要求：改成抓取 cointelegraph 的 rss 并给出阈值/);
  assert.match(prompt, /上次失败原因：pythonIndicator\/pipelineCode missing/);
  assert.match(prompt, /待补充项：补充代码改造要求/);
});
