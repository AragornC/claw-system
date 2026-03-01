import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__, createFreqtradeBacktestAdapter } from './freqtrade-backtest-adapter.js';

process.env.THUNDERCLAW_EXTERNAL_SIGNAL_LIVE = '0';

function buildBars(count = 240) {
  const out = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const t = 1700000000 + i * 3600;
    const drift = Math.sin(i / 7) * 0.008 + Math.cos(i / 13) * 0.004;
    const next = price * (1 + drift);
    const high = Math.max(price, next) * 1.003;
    const low = Math.min(price, next) * 0.997;
    out.push({ time: t, open: price, high, low, close: next, volume: 1000 + i });
    price = next;
  }
  return out;
}

test('computeSimpleSummary uses feature refs and reports feature usage assertion metadata', () => {
  const bars = buildBars();
  const baseLayers = {
    featureRefs: ['ema_trend_gate', 'risk_drawdown_guard', 'execution_slippage_guard'],
    longThreshold: 0.12,
    shortThreshold: -0.12,
    slippageBps: 6,
  };
  const summary = __test__.computeSimpleSummary(bars, baseLayers, { pair: 'BTC/USDT', timeframe: '1h' });

  assert.ok(Number.isFinite(summary.latestReturnPct), 'should produce deterministic return metric');
  assert.deepEqual(summary.unusedFeatureRefs, []);
  assert.ok(summary.featureUsage.ema_trend_gate > 0);
  assert.ok(summary.featureUsage.risk_drawdown_guard > 0);
  assert.ok(summary.featureUsage.execution_slippage_guard > 0);
});

test('news external feature changes result relative to non-external setup', () => {
  const bars = buildBars();
  const withoutExternal = __test__.computeSimpleSummary(bars, {
    featureRefs: ['ema_trend_gate', 'adx_strength_filter'],
    longThreshold: 0.12,
    shortThreshold: -0.12,
  }, { pair: 'BTC/USDT', timeframe: '1h' });

  const withExternal = __test__.computeSimpleSummary(bars, {
    featureRefs: ['ema_trend_gate', 'news_sentiment_signal'],
    longThreshold: 0.12,
    shortThreshold: -0.12,
  }, { pair: 'BTC/USDT', timeframe: '1h' });

  assert.notEqual(
    withExternal.latestReturnPct,
    withoutExternal.latestReturnPct,
    'external signal must change simulated backtest result',
  );
});

test('context and feature params produce source-specific external config', () => {
  const featureRefs = ['news_sentiment_signal', 'polymarket_edge_signal'];
  const featureRows = [
    {
      name: 'news_sentiment_signal',
      params: {
        sourceType: 'news',
        provider: 'blockbeats',
        url: 'https://www.theblockbeats.info/rss.xml',
      },
    },
    {
      name: 'polymarket_edge_signal',
      params: {
        sourceType: 'prediction',
        provider: 'polymarket',
      },
    },
  ];
  const configs = __test__.buildFeatureConfigs(featureRefs, featureRows, '用户要求基于律动新闻和polymarket');
  assert.equal(configs.news_sentiment_signal.provider, 'blockbeats');
  assert.equal(configs.news_sentiment_signal.url, 'https://www.theblockbeats.info/rss.xml');
  assert.equal(configs.polymarket_edge_signal.provider, 'polymarket');
  assert.match(configs.polymarket_edge_signal.url, /polymarket/);
});

test('dynamicFeatureSpecs from signal params override generated source config', () => {
  const featureRefs = ['news_sentiment_signal'];
  const configs = __test__.buildFeatureConfigs(
    featureRefs,
    [],
    '用户要求律动新闻',
    {
      dynamicFeatureSpecs: [
        {
          ref: 'news_sentiment_signal',
          sourceType: 'news',
          provider: 'blockbeats',
          url: 'https://www.theblockbeats.info/rss.xml',
          pythonIndicator: "dataframe['{col}']=dataframe['{col}'].rolling(3).mean()",
        },
      ],
    },
  );
  assert.equal(configs.news_sentiment_signal.provider, 'blockbeats');
  assert.equal(configs.news_sentiment_signal.url, 'https://www.theblockbeats.info/rss.xml');
  assert.match(configs.news_sentiment_signal.pythonIndicator, /rolling\(3\)/);
});

test('buildFeatureConfigs does not fabricate external processing code when model code is missing', () => {
  const configs = __test__.buildFeatureConfigs(
    ['news_sentiment_signal', 'twitter_sentiment_signal', 'polymarket_edge_signal'],
    [],
    '做一个新闻+社媒+预测信号策略',
    {},
  );
  assert.equal(configs.news_sentiment_signal.type, 'news');
  assert.equal(configs.twitter_sentiment_signal.type, 'social');
  assert.equal(configs.polymarket_edge_signal.type, 'prediction');
  assert.equal(configs.news_sentiment_signal.pythonIndicator, '');
  assert.equal(configs.twitter_sentiment_signal.pythonIndicator, '');
  assert.equal(configs.polymarket_edge_signal.pythonIndicator, '');
  assert.equal(configs.news_sentiment_signal.requiresModelCode, true);
  assert.equal(configs.twitter_sentiment_signal.requiresModelCode, true);
  assert.equal(configs.polymarket_edge_signal.requiresModelCode, true);
});


test('computeSimpleSummary exposes signal diagnostics counters', () => {
  const bars = buildBars();
  const summary = __test__.computeSimpleSummary(bars, {
    featureRefs: ['ema_trend_gate'],
    longThreshold: 0.05,
    shortThreshold: -0.05,
  }, { pair: 'BTC/USDT', timeframe: '1h' });
  assert.equal(Number.isFinite(summary.entrySignalCount), true);
  assert.equal(Number.isFinite(summary.exitSignalCount), true);
});


test('resolveRuntimeLayers falls back to strategy.draftConfig when version layers are missing', () => {
  const layers = __test__.resolveRuntimeLayers({
    strategy: {
      draftConfig: {
        signalLayer: {
          signalLogic: 'news_signal > 0 and trend_ok',
          featureRefs: ['news_sentiment_signal', 'ema_trend_gate'],
          params: { longThreshold: 0.2, shortThreshold: -0.1 },
        },
      },
    },
    version: {},
  });
  assert.deepEqual(layers.featureRefs, ['news_sentiment_signal', 'ema_trend_gate']);
  assert.equal(layers.longThreshold, 0.2);
  assert.equal(layers.shortThreshold, 0.05);
});

test('runBacktest degraded path synthesizes bars when input bars are missing', () => {
  const adapter = createFreqtradeBacktestAdapter({ command: '/usr/bin/true' });
  const out = adapter.runBacktest({
    rangeDays: 7,
    version: {
      signalLayer: {
        featureRefs: ['ema_trend_gate'],
        params: { longThreshold: 0.05, shortThreshold: -0.05 },
      },
    },
    features: [],
  });
  assert.ok(Number(out.executionReport?.barsMeta?.count || 0) > 0);
  // When freqtrade is available, mode is 'backtest'; when unavailable, it degrades
  assert.ok(
    out.executionReport?.engine?.mode === 'backtest' || out.executionReport?.engine?.mode === 'backtest_degraded',
    `expected backtest or backtest_degraded, got: ${out.executionReport?.engine?.mode}`,
  );
});
