/**
 * Pipeline Stage 2: Code Generation
 *
 * Given a structured feature specification, generates real executable Python
 * code compatible with Freqtrade's IStrategy interface.
 * Uses LLM API with structured prompts; falls back to template-based
 * code generation for standard indicators.
 */

import { toText } from "../../lib/utils.js";
import {
  CODE_GENERATION_SYSTEM_PROMPT,
  buildCodeGenerationUserMessage,
  CODE_REPAIR_SYSTEM_PROMPT,
  buildCodeRepairUserMessage,
} from "./prompts/code-generation.js";

/**
 * Template-based code generation for well-known indicator types.
 * Returns null if the kind is not a known template.
 */
function generateFromTemplate(feature) {
  const name = toText(feature.name).toLowerCase();
  const params = feature.params && typeof feature.params === "object" ? feature.params : {};
  const kind = toText(feature.kind).toLowerCase();
  const col = `tc_feat_${name}`;

  if (kind === "ema" || name.includes("ema")) {
    const fast = Number(params.fast_period || params.fast || 12) || 12;
    const slow = Number(params.slow_period || params.slow || 26) || 26;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['ema_fast_${fast}'] = ta.EMA(dataframe, timeperiod=${fast})`,
        `        dataframe['ema_slow_${slow}'] = ta.EMA(dataframe, timeperiod=${slow})`,
        `        dataframe['${col}'] = ((dataframe['ema_fast_${fast}'] - dataframe['ema_slow_${slow}']) / dataframe['close'].replace(0, 1)).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] > 0) & (dataframe['${col}'].shift(1) <= 0)`,
      exitConditionCode: `(dataframe['${col}'] < 0) & (dataframe['${col}'].shift(1) >= 0)`,
      requiredImports: [],
      columnNames: [`ema_fast_${fast}`, `ema_slow_${slow}`, col],
      description: `EMA ${fast}/${slow} crossover signal`,
    };
  }

  if (kind === "rsi" || name.includes("rsi")) {
    const period = Number(params.period || params.timeperiod || 14) || 14;
    const oversold = Number(params.oversold || params.lower || 30) || 30;
    const overbought = Number(params.overbought || params.upper || 70) || 70;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['rsi_${period}'] = ta.RSI(dataframe, timeperiod=${period})`,
        `        dataframe['${col}'] = ((dataframe['rsi_${period}'] - 50.0) / 50.0).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['rsi_${period}'] < ${oversold}) & (dataframe['rsi_${period}'].shift(1) >= ${oversold})`,
      exitConditionCode: `(dataframe['rsi_${period}'] > ${overbought})`,
      requiredImports: [],
      columnNames: [`rsi_${period}`, col],
      description: `RSI(${period}) oversold=${oversold}/overbought=${overbought}`,
    };
  }

  if (kind === "adx" || name.includes("adx")) {
    const period = Number(params.period || params.timeperiod || 14) || 14;
    const threshold = Number(params.threshold || 25) || 25;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['adx_${period}'] = ta.ADX(dataframe, timeperiod=${period})`,
        `        dataframe['${col}'] = ((dataframe['adx_${period}'] - ${threshold}) / ${threshold}).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['adx_${period}'] > ${threshold})`,
      exitConditionCode: `(dataframe['adx_${period}'] < ${Math.max(10, threshold - 10)})`,
      requiredImports: [],
      columnNames: [`adx_${period}`, col],
      description: `ADX(${period}) strength filter threshold=${threshold}`,
    };
  }

  if (kind === "atr" || name.includes("atr")) {
    const period = Number(params.period || params.timeperiod || 14) || 14;
    const multiplier = Number(params.multiplier || params.mult || 1.5) || 1.5;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['atr_${period}'] = ta.ATR(dataframe, timeperiod=${period})`,
        `        dataframe['atr_pct_${period}'] = (dataframe['atr_${period}'] / dataframe['close'].replace(0, 1)).fillna(0)`,
        `        dataframe['${col}'] = (0.7 - dataframe['atr_pct_${period}'] * ${(25 * multiplier).toFixed(1)}).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] > 0)`,
      exitConditionCode: `(dataframe['${col}'] < -0.5)`,
      requiredImports: [],
      columnNames: [`atr_${period}`, `atr_pct_${period}`, col],
      description: `ATR(${period}) volatility filter multiplier=${multiplier}`,
    };
  }

  if (kind === "macd" || name.includes("macd")) {
    const fast = Number(params.fast_period || params.fast || 12) || 12;
    const slow = Number(params.slow_period || params.slow || 26) || 26;
    const signal = Number(params.signal_period || params.signal || 9) || 9;
    return {
      featureName: name,
      indicatorCode: [
        `        macd_result = ta.MACD(dataframe, fastperiod=${fast}, slowperiod=${slow}, signalperiod=${signal})`,
        `        dataframe['macd_line'] = macd_result['macd']`,
        `        dataframe['macd_signal'] = macd_result['macdsignal']`,
        `        dataframe['macd_hist'] = macd_result['macdhist']`,
        `        dataframe['${col}'] = (dataframe['macd_hist'] / dataframe['close'].replace(0, 1) * 100).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['macd_hist'] > 0) & (dataframe['macd_hist'].shift(1) <= 0)`,
      exitConditionCode: `(dataframe['macd_hist'] < 0) & (dataframe['macd_hist'].shift(1) >= 0)`,
      requiredImports: [],
      columnNames: ["macd_line", "macd_signal", "macd_hist", col],
      description: `MACD(${fast},${slow},${signal}) histogram crossover`,
    };
  }

  if (kind === "bollinger" || name.includes("boll")) {
    const period = Number(params.period || params.timeperiod || 20) || 20;
    const nbdev = Number(params.nbdev || params.std || 2) || 2;
    return {
      featureName: name,
      indicatorCode: [
        `        bb_result = ta.BBANDS(dataframe, timeperiod=${period}, nbdevup=${nbdev}.0, nbdevdn=${nbdev}.0)`,
        `        dataframe['bb_upper'] = bb_result['upperband']`,
        `        dataframe['bb_middle'] = bb_result['middleband']`,
        `        dataframe['bb_lower'] = bb_result['lowerband']`,
        `        bb_width = (dataframe['bb_upper'] - dataframe['bb_lower']).replace(0, 1)`,
        `        dataframe['${col}'] = ((dataframe['close'] - dataframe['bb_middle']) / (bb_width / 2)).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['close'] < dataframe['bb_lower'])`,
      exitConditionCode: `(dataframe['close'] > dataframe['bb_upper'])`,
      requiredImports: [],
      columnNames: ["bb_upper", "bb_middle", "bb_lower", col],
      description: `Bollinger Bands(${period}, ${nbdev}σ) mean reversion`,
    };
  }

  if (kind === "volume" || name.includes("volume")) {
    const period = Number(params.period || params.timeperiod || 20) || 20;
    const threshold = Number(params.threshold || params.ratio || 2.0) || 2.0;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['vol_sma_${period}'] = dataframe['volume'].rolling(${period}).mean()`,
        `        dataframe['vol_ratio'] = (dataframe['volume'] / dataframe['vol_sma_${period}'].replace(0, 1)).fillna(1)`,
        `        dataframe['${col}'] = ((dataframe['vol_ratio'] - 1.0) / ${threshold.toFixed(1)}).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['vol_ratio'] > ${threshold.toFixed(1)})`,
      exitConditionCode: `(dataframe['vol_ratio'] < 0.5)`,
      requiredImports: [],
      columnNames: [`vol_sma_${period}`, "vol_ratio", col],
      description: `Volume spike detector (${period}MA, threshold=${threshold}x)`,
    };
  }

  if (kind === "sma" || name.includes("sma")) {
    const fast = Number(params.fast_period || params.fast || 10) || 10;
    const slow = Number(params.slow_period || params.slow || 30) || 30;
    return {
      featureName: name,
      indicatorCode: [
        `        dataframe['sma_fast_${fast}'] = ta.SMA(dataframe, timeperiod=${fast})`,
        `        dataframe['sma_slow_${slow}'] = ta.SMA(dataframe, timeperiod=${slow})`,
        `        dataframe['${col}'] = ((dataframe['sma_fast_${fast}'] - dataframe['sma_slow_${slow}']) / dataframe['close'].replace(0, 1)).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] > 0) & (dataframe['${col}'].shift(1) <= 0)`,
      exitConditionCode: `(dataframe['${col}'] < 0) & (dataframe['${col}'].shift(1) >= 0)`,
      requiredImports: [],
      columnNames: [`sma_fast_${fast}`, `sma_slow_${slow}`, col],
      description: `SMA ${fast}/${slow} crossover signal`,
    };
  }

  // External feature proxy templates — use OHLCV data to simulate sentiment/external signals
  if (kind === "news_sentiment" || name.includes("news") || name.includes("sentiment")) {
    const volPeriod = Number(params.vol_period || params.period || 20) || 20;
    const retPeriod = Number(params.ret_period || 5) || 5;
    return {
      featureName: name,
      indicatorCode: [
        `        # proxy mode: 新闻情绪信号 (基于价格动量+成交量异常度模拟)`,
        `        # 如需真实新闻数据源，可配置 THUNDERCLAW_NEWS_RSS_URL 环境变量`,
        `        dataframe['_vol_ma_${volPeriod}'] = dataframe['volume'].rolling(${volPeriod}).mean()`,
        `        dataframe['_vol_ratio'] = (dataframe['volume'] / dataframe['_vol_ma_${volPeriod}'].replace(0, 1)).fillna(1)`,
        `        dataframe['_ret_${retPeriod}'] = dataframe['close'].pct_change(${retPeriod}).fillna(0)`,
        `        dataframe['_vol_surprise'] = (dataframe['_vol_ratio'] - 1.0).clip(-2, 2)`,
        `        dataframe['${col}'] = (dataframe['_ret_${retPeriod}'] * 6.0 + dataframe['_vol_surprise'] * 0.25).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] > 0.3) & (dataframe['${col}'].shift(1) <= 0.3)`,
      exitConditionCode: `(dataframe['${col}'] < -0.2)`,
      requiredImports: [],
      columnNames: [`_vol_ma_${volPeriod}`, `_vol_ratio`, `_ret_${retPeriod}`, `_vol_surprise`, col],
      description: `News sentiment proxy signal (vol anomaly + ${retPeriod}-bar momentum). Proxy mode: real data source can be configured.`,
    };
  }

  if (kind === "social_sentiment" || name.includes("social") || name.includes("twitter") || name.includes("tweet")) {
    const period = Number(params.period || 14) || 14;
    return {
      featureName: name,
      indicatorCode: [
        `        # proxy mode: 社媒情绪信号 (基于成交量突增+价格离散度模拟)`,
        `        # 如需真实社交数据，可配置 THUNDERCLAW_SOCIAL_RSS_URL 环境变量`,
        `        dataframe['_vol_sma_${period}'] = dataframe['volume'].rolling(${period}).mean()`,
        `        dataframe['_vol_z'] = ((dataframe['volume'] - dataframe['_vol_sma_${period}']) / dataframe['_vol_sma_${period}'].replace(0, 1)).fillna(0)`,
        `        dataframe['_hl_range'] = ((dataframe['high'] - dataframe['low']) / dataframe['close'].replace(0, 1)).fillna(0)`,
        `        dataframe['_hl_avg'] = dataframe['_hl_range'].rolling(${period}).mean().fillna(0)`,
        `        dataframe['_buzz'] = (dataframe['_vol_z'] * 0.6 + (dataframe['_hl_range'] - dataframe['_hl_avg']) * 15).fillna(0)`,
        `        dataframe['${col}'] = dataframe['_buzz'].clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] > 0.4)`,
      exitConditionCode: `(dataframe['${col}'] < -0.15)`,
      requiredImports: [],
      columnNames: [`_vol_sma_${period}`, `_vol_z`, `_hl_range`, `_hl_avg`, `_buzz`, col],
      description: `Social sentiment proxy signal (volume z-score + range anomaly). Proxy mode: real data source can be configured.`,
    };
  }

  if (kind === "prediction_market" || name.includes("prediction") || name.includes("polymarket")) {
    const period = Number(params.period || 10) || 10;
    return {
      featureName: name,
      indicatorCode: [
        `        # proxy mode: 预测市场信号 (基于价格均值回归强度模拟)`,
        `        # 如需真实预测市场数据，可配置 THUNDERCLAW_PREDICTION_API_URL 环境变量`,
        `        dataframe['_sma_${period}'] = ta.SMA(dataframe, timeperiod=${period})`,
        `        dataframe['_deviation'] = ((dataframe['close'] - dataframe['_sma_${period}']) / dataframe['_sma_${period}'].replace(0, 1)).fillna(0)`,
        `        dataframe['_vol_shift'] = (dataframe['volume'].pct_change(3).fillna(0)).clip(-2, 2)`,
        `        dataframe['${col}'] = (dataframe['_deviation'] * 8.0 + dataframe['_vol_shift'] * 0.15).clip(-1, 1)`,
      ].join("\n"),
      entryConditionCode: `(dataframe['${col}'] < -0.3) & (dataframe['${col}'].shift(1) >= -0.3)`,
      exitConditionCode: `(dataframe['${col}'] > 0.4)`,
      requiredImports: [],
      columnNames: [`_sma_${period}`, `_deviation`, `_vol_shift`, col],
      description: `Prediction market proxy signal (mean-reversion + volume shift). Proxy mode: real data source can be configured.`,
    };
  }

  // No template available for this kind
  return null;
}

/**
 * Normalize code generation output from model.
 */
function normalizeCodeOutput(rawLike, featureName) {
  const raw = rawLike && typeof rawLike === "object" ? rawLike : {};
  const name = toText(raw.featureName || featureName).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return {
    featureName: name,
    indicatorCode: toText(raw.indicatorCode, ""),
    entryConditionCode: toText(raw.entryConditionCode, ""),
    exitConditionCode: toText(raw.exitConditionCode, ""),
    requiredImports: Array.isArray(raw.requiredImports) ? raw.requiredImports.map(String) : [],
    columnNames: Array.isArray(raw.columnNames) ? raw.columnNames.map(String) : [],
    description: toText(raw.description, ""),
  };
}

/**
 * Create the code generator with an LLM client dependency.
 * @param {{ llmClient: Object }} deps
 */
export function createCodeGenerator(deps = {}) {
  const llmClient = deps.llmClient;

  /**
   * Generate Freqtrade-compatible Python code for a feature.
   * @param {Object} feature - Feature specification from intent detection
   * @returns {Promise<Object>} Generated code object
   */
  async function generateCode(feature) {
    const featureName = toText(feature?.name, "custom_feature");

    // Try template first for known indicator types
    const templateResult = generateFromTemplate(feature);
    if (templateResult) {
      return { ok: true, code: templateResult, source: "template" };
    }

    // Use LLM API for custom/complex features
    if (llmClient) {
      try {
        const result = await llmClient.chatCompletionJson({
          messages: [
            { role: "system", content: CODE_GENERATION_SYSTEM_PROMPT },
            { role: "user", content: buildCodeGenerationUserMessage({ feature }) },
          ],
          temperature: 0.2,
          maxTokens: 3072,
          timeoutMs: 90_000,
        });
        if (result.ok && result.data) {
          const code = normalizeCodeOutput(result.data, featureName);
          if (code.indicatorCode) {
            return { ok: true, code, source: "llm" };
          }
        }
      } catch {
        // Fall through to default
      }
    }

    // Final fallback: generic momentum indicator
    const col = `tc_feat_${featureName}`;
    return {
      ok: true,
      code: {
        featureName,
        indicatorCode: [
          `        dataframe['ret_1'] = dataframe['close'].pct_change().fillna(0)`,
          `        dataframe['${col}'] = (dataframe['ret_1'] * 12.0).clip(-1, 1)`,
        ].join("\n"),
        entryConditionCode: `(dataframe['${col}'] > 0.15)`,
        exitConditionCode: `(dataframe['${col}'] < -0.1)`,
        requiredImports: [],
        columnNames: ["ret_1", col],
        description: "Fallback momentum signal based on 1-bar return",
      },
      source: "fallback",
    };
  }

  /**
   * Attempt to repair code that failed validation.
   * @param {Object} params
   * @param {Object} params.originalCode - The failed code
   * @param {string[]} params.errors - Validation error messages
   * @param {Object} params.featureSpec - Original feature spec
   * @returns {Promise<Object>} Repaired code
   */
  async function repairCode(params = {}) {
    if (!llmClient) {
      return { ok: false, code: params.originalCode || {}, error: "No LLM client for repair" };
    }
    try {
      const result = await llmClient.chatCompletionJson({
        messages: [
          { role: "system", content: CODE_REPAIR_SYSTEM_PROMPT },
          { role: "user", content: buildCodeRepairUserMessage(params) },
        ],
        temperature: 0.1,
        maxTokens: 3072,
        timeoutMs: 90_000,
      });
      if (result.ok && result.data) {
        const code = normalizeCodeOutput(result.data, params.featureSpec?.name || "custom");
        if (code.indicatorCode) {
          return { ok: true, code, source: "llm_repair" };
        }
      }
      return { ok: false, code: params.originalCode || {}, error: "Repair failed to produce code" };
    } catch (err) {
      return { ok: false, code: params.originalCode || {}, error: String(err?.message || err) };
    }
  }

  return { generateCode, repairCode };
}
