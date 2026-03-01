import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSignalLayer } from './strategy-lifecycle-helpers.js';
import { inferFeatureRelationType } from './strategy-lab-store-helpers.js';

test('normalizeSignalLayer should normalize and dedupe signalLayer.featureRefs', () => {
  const layer = normalizeSignalLayer({
    featureRefs: [
      'EMA Trend Gate',
      'ema_trend_gate',
      { featureName: 'risk_drawdown_guard' },
      { name: 'position_sizing_rule' },
      'execution_slippage_guard',
      '',
      null,
    ],
    signalLogic: 'trend_confirmed',
  });

  assert.deepEqual(layer.featureRefs, [
    'ema_trend_gate',
    'risk_drawdown_guard',
    'position_sizing_rule',
    'execution_slippage_guard',
  ]);
});

test('inferFeatureRelationType should classify featureRelations into four layer buckets', () => {
  assert.equal(
    inferFeatureRelationType('execution_slippage_guard', { group: 'execution' }),
    'execution_rule',
  );
  assert.equal(
    inferFeatureRelationType('risk_drawdown_guard', { group: 'risk', kind: 'risk_rule' }),
    'risk_guard',
  );
  assert.equal(
    inferFeatureRelationType('position_exposure_cap', { group: 'position' }),
    'position_sizing',
  );
  assert.equal(
    inferFeatureRelationType('ema_trend_gate', { group: 'trend', kind: 'ema' }),
    'signal_input',
  );
});

test('normalizeSignalLayer should preserve dynamicFeatureSpecs for runtime code generation', () => {
  const layer = normalizeSignalLayer({
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
  });
  assert.equal(Array.isArray(layer.params.dynamicFeatureSpecs), true);
  assert.equal(layer.params.dynamicFeatureSpecs[0].provider, 'blockbeats');
  assert.match(layer.params.dynamicFeatureSpecs[0].pythonIndicator, /rolling\(3\)/);
});
