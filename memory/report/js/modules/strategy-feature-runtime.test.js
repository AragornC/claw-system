import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(__dirname, "strategy-feature-runtime.js");
const runtimeCode = fs.readFileSync(runtimePath, "utf8");

function loadHelpers() {
  const context = vm.createContext({
    window: {},
    console,
    setTimeout,
    clearTimeout,
  });
  new vm.Script(runtimeCode, { filename: "strategy-feature-runtime.js" }).runInContext(context);
  return {
    ...(context.window.__featureEvalTest__ || {}),
    renderFeatureEvalTimeSeriesRuntime: context.window.renderFeatureEvalTimeSeriesRuntime,
  };
}

function buildEvalSeries(count = 10) {
  return Array.from({ length: count }, (_, idx) => ({
    time: 1700000000 + idx * 3600,
    open: 65000 + idx,
    high: 65080 + idx,
    low: 64920 + idx,
    close: 65040 + idx,
    volume: 100 + idx,
    tc_feat_ema_gate: Number((0.1 + idx * 0.01).toFixed(4)),
  }));
}

test("feature eval chart model keeps real candles and gaps bad feature points", () => {
  const helpers = loadHelpers();
  assert.ok(helpers);
  const model = helpers.buildFeatureEvalChartModelRuntime(
    "ema_gate",
    [
      { time: 1700000000, open: 65000, high: 65100, low: 64950, close: 65080, volume: 100, tc_feat_ema_gate: 0.12 },
      { time: 1700003600, open: 65080, high: 65200, low: 65010, close: 65150, volume: 120, tc_feat_ema_gate: null },
      { time: 1700007200, open: 65150, high: 65300, low: 65100, close: 65240, volume: 130, tc_feat_ema_gate: 0.21 },
      { time: 1700010800, open: 65240, high: 65420, low: 65210, close: 65390, volume: 150, tc_feat_ema_gate: 0.31 },
      { time: 1700014400, open: 65390, high: 65510, low: 65350, close: 65420, volume: 140, tc_feat_ema_gate: 0.28 },
      { time: 1700018000, open: 65420, high: 65540, low: 65400, close: 65500, volume: 160, tc_feat_ema_gate: 0.33 },
      { time: 1700021600, open: 65500, high: 65610, low: 65480, close: 65540, volume: 170, tc_feat_ema_gate: 0.39 },
      { time: 1700025200, open: 65540, high: 65680, low: 65510, close: 65620, volume: 165, tc_feat_ema_gate: 0.44 },
      { time: 1700028800, open: null, high: 65710, low: 65590, close: 65680, volume: 175, tc_feat_ema_gate: 0.48 },
      { time: 1700032400, open: 65680, high: 65830, low: 65650, close: 65790, volume: 180, tc_feat_ema_gate: 0.52 },
    ],
    ["tc_feat_ema_gate"],
    { timeframe: "1h", chartWindow: 24 },
  );
  assert.equal(model.ok, true);
  assert.equal(model.featureLabel, "ema_gate");
  assert.equal(model.timeframe, "1h");
  assert.equal(model.skippedBars, 1);
  assert.equal(model.skippedFeaturePoints, 1);
  assert.equal(model.candleData.length, 9);
  assert.equal(model.lineData.length, 10);
});

test("feature point explanation uses layered wording", () => {
  const helpers = loadHelpers();
  const emaExplain = helpers.buildFeaturePointExplainRuntime(
    { kind: "ema", params: { period: 20 } },
    { featureValue: 0.1234 },
  );
  const customExplain = helpers.buildFeaturePointExplainRuntime(
    { kind: "custom", params: { sourceType: "external" } },
    { featureValue: 1.2345 },
  );
  assert.match(emaExplain, /EMA\(20\)/);
  assert.match(emaExplain, /当前值 0\.1234/);
  assert.match(customExplain, /compute_feature/);
  assert.equal(helpers.isStandardFeatureKindRuntime("ema"), true);
  assert.equal(helpers.isStandardFeatureKindRuntime("custom"), false);
});

test("feature eval chart model defaults to full returned window instead of 84 bars", () => {
  const helpers = loadHelpers();
  const series = buildEvalSeries(150);
  const model = helpers.buildFeatureEvalChartModelRuntime(
    "ema_gate",
    series,
    ["tc_feat_ema_gate"],
    { timeframe: "1h" },
  );
  assert.equal(model.ok, true);
  assert.equal(model.windowSize, 150);
  assert.equal(model.candleData.length, 150);
  assert.equal(model.lineData.length, 150);
});

test("feature eval chart model no longer truncates large windows to 120 bars", () => {
  const helpers = loadHelpers();
  const series = buildEvalSeries(160);
  const model = helpers.buildFeatureEvalChartModelRuntime(
    "ema_gate",
    series,
    ["tc_feat_ema_gate"],
    { timeframe: "1h", chartWindow: 160 },
  );
  assert.equal(model.ok, true);
  assert.equal(model.windowSize, 160);
  assert.equal(model.candleData.length, 160);
  assert.equal(model.lineData.length, 160);
});

test("feature eval selection normalization clamps reverse drag and ignores tiny drag", () => {
  const helpers = loadHelpers();
  const reverse = helpers.normalizeFeatureEvalSelectionRuntime(84, 20, 100, 12);
  assert.deepEqual({ left: reverse.left, right: reverse.right, width: reverse.width }, { left: 20, right: 84, width: 64 });
  const tiny = helpers.normalizeFeatureEvalSelectionRuntime(10, 16, 100, 12);
  assert.equal(tiny, null);
  const clamped = helpers.normalizeFeatureEvalSelectionRuntime(-20, 140, 100, 12);
  assert.deepEqual({ left: clamped.left, right: clamped.right, width: clamped.width }, { left: 0, right: 100, width: 100 });
});

test("feature eval only upgrades to selection after drag exceeds threshold", () => {
  const helpers = loadHelpers();
  assert.equal(helpers.shouldActivateFeatureEvalSelectionRuntime(10, 18, 12), false);
  assert.equal(helpers.shouldActivateFeatureEvalSelectionRuntime(10, 22, 12), true);
  assert.equal(helpers.shouldActivateFeatureEvalSelectionRuntime(30, 14, 12), true);
});

test("feature eval click allowance ignores pointerDown and only suppresses after zoom once", () => {
  const helpers = loadHelpers();
  const clickState = { active: false, pointerDown: true, suppressNextClick: false };
  assert.equal(helpers.shouldOpenFeatureEvalPointCardRuntime(clickState), true);

  const activeState = { active: true, suppressNextClick: false };
  assert.equal(helpers.shouldOpenFeatureEvalPointCardRuntime(activeState), false);

  const suppressedState = { active: false, suppressNextClick: true };
  assert.equal(helpers.shouldOpenFeatureEvalPointCardRuntime(suppressedState), false);
  assert.equal(suppressedState.suppressNextClick, false);
  assert.equal(helpers.shouldOpenFeatureEvalPointCardRuntime(suppressedState), true);
});

test("feature eval logical range maps drag selection to candle indexes", () => {
  const helpers = loadHelpers();
  const candles = buildEvalSeries(10).map((row) => ({ time: row.time }));
  const baseTime = candles[0].time;
  const range = helpers.buildFeatureEvalLogicalRangeRuntime(
    candles,
    20,
    70,
    100,
    (x) => baseTime + Math.round(x / 10) * 3600,
  );
  assert.deepEqual({ from: range.from, to: range.to }, { from: 2, to: 7 });
});

test("feature eval logical range normalizes reverse drag and clamps overflow", () => {
  const helpers = loadHelpers();
  const candles = buildEvalSeries(10).map((row) => ({ time: row.time }));
  const baseTime = candles[0].time;
  const reverse = helpers.buildFeatureEvalLogicalRangeRuntime(
    candles,
    88,
    24,
    100,
    (x) => baseTime + Math.round(x / 10) * 3600,
  );
  assert.deepEqual({ from: reverse.from, to: reverse.to }, { from: 2, to: 9 });
  const clamped = helpers.buildFeatureEvalLogicalRangeRuntime(
    candles,
    -10,
    140,
    100,
    () => null,
  );
  assert.deepEqual({ from: clamped.from, to: clamped.to }, { from: 0, to: 9 });
});

test("feature eval chart shell includes reset view button", () => {
  const helpers = loadHelpers();
  const series = buildEvalSeries(20);
  const rendered = helpers.renderFeatureEvalTimeSeriesRuntime(
    "ema_gate",
    series,
    ["tc_feat_ema_gate"],
    { timeframe: "1h", barCount: series.length },
  );
  assert.match(rendered.html, /data-action="reset-feature-chart"/);
  assert.match(rendered.html, /重置视图/);
});

test("feature point card does not render jump button and keeps missing volume empty", () => {
  const helpers = loadHelpers();
  const html = helpers.renderFeaturePointCardRuntime(
    "ema_gate",
    { kind: "custom", title: "自定义特征" },
    { time: 1700000000, open: 65000, high: 65100, low: 64950, close: 65080, volume: null, featureValue: 0.1234 },
    "自定义特征",
    "1h",
  );
  assert.doesNotMatch(html, /定位K线/);
  assert.match(html, />-<\/strong>/);
  assert.equal(helpers.formatFeatureEvalValueRuntime(null, 2), "-");
});

test("feature point card render still exposes click detail content", () => {
  const helpers = loadHelpers();
  const html = helpers.renderFeaturePointCardRuntime(
    "ema_gate",
    { kind: "ema", title: "EMA Gate", params: { period: 20 } },
    { time: 1700000000, open: 65000, high: 65100, low: 64950, close: 65080, volume: 120, featureValue: 0.1234 },
    "EMA Gate",
    "1h",
  );
  assert.match(html, /EMA Gate/);
  assert.match(html, /特征值/);
  assert.match(html, /Volume/);
});
