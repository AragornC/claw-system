import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExternalSignalSnapshot } from './signal-external-features.js';

test('feature-level source config affects external synthetic score', () => {
  process.env.THUNDERCLAW_EXTERNAL_SIGNAL_LIVE = '0';
  const base = buildExternalSignalSnapshot({
    featureRefs: ['news_sentiment_signal'],
    timeSec: 1700000000,
    contextText: 'BTC',
    featureConfigs: {
      news_sentiment_signal: {
        type: 'news',
        url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
      },
    },
  });
  const alt = buildExternalSignalSnapshot({
    featureRefs: ['news_sentiment_signal'],
    timeSec: 1700000000,
    contextText: 'BTC',
    featureConfigs: {
      news_sentiment_signal: {
        type: 'news',
        url: 'https://www.theblockbeats.info/rss.xml',
      },
    },
  });

  assert.equal(base.externalSignals.length, 1);
  assert.equal(alt.externalSignals.length, 1);
  assert.equal(Array.isArray(base.externalSignals[0].sampleHeadlines), true);
  assert.notEqual(base.externalSignals[0].score, alt.externalSignals[0].score);
});

test('live mode fetches real external datasource with github fallback', () => {
  process.env.THUNDERCLAW_EXTERNAL_SIGNAL_LIVE = '1';
  process.env.THUNDERCLAW_EXTERNAL_SIGNAL_STRICT = '0';
  const out = buildExternalSignalSnapshot({
    featureRefs: ['news_sentiment_signal', 'twitter_sentiment_signal', 'polymarket_edge_signal'],
    timeSec: Math.floor(Date.now() / 1000),
    contextText: 'BTC real live fetch check',
    featureConfigs: {
      news_sentiment_signal: { type: 'news', provider: 'coindesk' },
      twitter_sentiment_signal: { type: 'social', provider: 'twitter' },
      polymarket_edge_signal: { type: 'prediction', provider: 'polymarket' },
    },
  });

  assert.equal(Array.isArray(out.externalSignals), true);
  assert.equal(out.externalSignals.length, 3);
  for (const row of out.externalSignals) {
    assert.equal(row.dataLive, true);
    assert.equal(typeof row.sourceUrl, 'string');
    assert.match(row.sourceUrl, /^https?:\/\//);
    assert.equal(Number.isFinite(Number(row.score)), true);
    assert.equal(Number(row.sampleSize) > 0, true);
  }
});
