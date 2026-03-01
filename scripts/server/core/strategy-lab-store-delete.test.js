import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStrategyLabStore } from './strategy-lab-store.js';

function createTestStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-delete-'));
  const statePath = path.join(root, 'state.json');
  const store = createStrategyLabStore({
    statePath,
    backtestEngine: {
      runBacktest() {
        return {
          summary: {
            tradeCount: 0,
            winRate: 0,
            latestReturnPct: 0,
            maxDrawdownPct: 0,
          },
          executionReport: {
            bars: [],
            events: [],
            equityCurve: [],
            drawdownCurve: [],
          },
        };
      },
    },
  });
  return { store, statePath, root };
}

test('deleteFeature removes feature and updates strategy references', () => {
  const { store } = createTestStore();
  const featureA = store.applyIntentCandidate({
    kind: 'feature',
    feature: {
      name: 'news_sentiment_signal',
      group: 'signal_external',
      kind: 'news_sentiment',
      params: {
        sourceType: 'news',
        pythonIndicator: "dataframe['{col}']=dataframe['{col}'].rolling(3).mean()",
        codeSource: 'model_generated',
      },
    },
  }).feature;
  store.applyIntentCandidate({
    kind: 'feature',
    feature: { name: 'ema_trend_gate', group: 'signal' },
  });

  const draft = store.saveStrategyDraft({
    name: 'Delete Feature Draft',
    signalLayer: {
      featureRefs: ['news_sentiment_signal', 'ema_trend_gate'],
      signalLogic: 'test',
    },
  });
  store.publishStrategyVersion({ strategyId: draft.strategy.strategyId, note: 'test publish' });

  const result = store.deleteFeature({ featureId: featureA.featureId });
  assert.equal(result.featureId, featureA.featureId);
  assert.ok(result.affectedStrategyCount >= 1);

  const featureNames = store.listFeatures({ page: 1, pageSize: 40 }).features.map((item) => item.name);
  assert.equal(featureNames.includes('news_sentiment_signal'), false);

  const detail = store.getStrategyDetail({ strategyId: draft.strategy.strategyId });
  const refs = detail.details.layers.signalLayer.featureRefs;
  assert.deepEqual(refs, ['ema_trend_gate']);
});

test('deleteStrategy removes strategy, versions, audits and artifacts', () => {
  const { store } = createTestStore();
  const draft = store.saveStrategyDraft({
    name: 'Delete Strategy Draft',
    signalLayer: {
      featureRefs: ['ema_trend_gate'],
      signalLogic: 'test',
    },
  });
  const published = store.publishStrategyVersion({ strategyId: draft.strategy.strategyId, note: 'test publish' });
  store.reportArtifact({
    source: 'strategy_replay',
    query: 'test',
    label: 'artifact',
    config: {
      strategyId: draft.strategy.strategyId,
      strategyVersionId: published.version.strategyVersionId,
      bars: 10,
    },
    result: {
      strategyId: draft.strategy.strategyId,
      strategyVersionId: published.version.strategyVersionId,
    },
  });

  const deleted = store.deleteStrategy({ strategyId: draft.strategy.strategyId });
  assert.equal(deleted.strategyId, draft.strategy.strategyId);
  assert.ok(deleted.removedStrategyVersionCount >= 1);
  assert.ok(deleted.removedArtifactCount >= 1);

  const listed = store.listStrategies({ page: 1, pageSize: 40 });
  assert.equal(listed.strategies.some((item) => item.strategyId === draft.strategy.strategyId), false);
});


test('strategy detail includes generatedFeatureCode preview from dynamic specs', () => {
  const { store } = createTestStore();
  const draft = store.saveStrategyDraft({
    name: 'Detail Feature Code Draft',
    signalLayer: {
      featureRefs: ['news_sentiment_signal'],
      params: {
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
      signalLogic: 'test',
    },
  });

  const detail = store.getStrategyDetail({ strategyId: draft.strategy.strategyId });
  assert.equal(Array.isArray(detail.details.generatedFeatureCode), true);
  assert.equal(detail.details.generatedFeatureCode.length > 0, true);
  assert.match(String(detail.details.generatedFeatureCode[0].expression || ''), /rolling\(3\)/);
});

test('strategy detail infers external feature processing code from signal refs when dynamic specs are missing', () => {
  const { store } = createTestStore();
  const draft = store.saveStrategyDraft({
    name: 'Detail Inferred External Code Draft',
    signalLayer: {
      featureRefs: ['news_sentiment_signal', 'twitter_sentiment_signal'],
      signalLogic: 'test',
    },
  });

  const detail = store.getStrategyDetail({ strategyId: draft.strategy.strategyId });
  const news = detail.details.generatedFeatureCode.find((row) => row.featureRef === 'news_sentiment_signal');
  const social = detail.details.generatedFeatureCode.find((row) => row.featureRef === 'twitter_sentiment_signal');
  assert.equal(news.sourceType, 'news');
  assert.equal(news.provider, 'coindesk');
  assert.match(String(news.expression || ''), /rolling\(3\)/);
  assert.equal(social.sourceType, 'social');
  assert.equal(social.provider, 'twitter');
  assert.match(String(social.expression || ''), /ewm\(span=5/);
});




test('applyIntentCandidate preserves camelCase params for execution code in persisted feature', () => {
  const { store } = createTestStore();
  store.applyIntentCandidate({
    kind: 'feature',
    feature: {
      name: 'news_sentiment_signal',
      group: 'signal_external',
      kind: 'news_sentiment',
      params: {
        sourceType: 'news',
        pythonIndicator: "dataframe['{col}']=dataframe['{col}'].rolling(3).mean()",
        codeSource: 'model_generated',
      },
    },
  });
  const listed = store.listFeatures({ page: 1, pageSize: 20 }).features;
  const target = listed.find((row) => String(row.name || '').includes('news') && String(row.group || '') === 'signal_external');
  assert.ok(target);
  assert.match(String(target.params.pythonIndicator || ''), /rolling\(3\)/);
  assert.equal(target.params.codeSource, 'model_generated');
});
test('applyIntentCandidate rejects external feature confirmation without generated execution code', () => {
  const { store } = createTestStore();
  assert.throws(() => {
    store.applyIntentCandidate({
      kind: 'feature',
      feature: {
        name: 'twitter_sentiment_signal',
        group: 'signal_external',
        kind: 'social_sentiment',
        params: { sourceType: 'social' },
      },
    });
  }, /pythonIndicator/);
});
