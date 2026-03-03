/**
 * Prompt templates for Stage 2: Freqtrade-Compatible Code Generation.
 *
 * Given a structured feature specification, generate real executable Python
 * code that runs inside a Freqtrade IStrategy class.
 */

export const CODE_GENERATION_SYSTEM_PROMPT = `You are ThunderClaw's Freqtrade Code Generator.

Your job: given a trading feature specification, generate **real, executable Python code** that runs inside a Freqtrade IStrategy.

## Freqtrade IStrategy Contract
The strategy class has three methods you must target:

1. \`populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame\`
   - Adds indicator columns to the OHLCV dataframe
   - Available columns: open, high, low, close, volume, date
   - Can use TA-Lib via: \`import talib.abstract as ta\` for standard indicators
   - Can use pandas DataFrame operations, numpy, and any other library as needed
   - Can fetch external data via HTTP (requests/urllib) for news, social, API-based features

2. \`populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame\`
   - Sets \`dataframe.loc[condition, 'enter_long'] = 1\` for long entries
   - Sets \`dataframe.loc[condition, 'enter_short'] = 1\` for short entries (optional)

3. \`populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame\`
   - Sets \`dataframe.loc[condition, 'exit_long'] = 1\` for long exits
   - Sets \`dataframe.loc[condition, 'exit_short'] = 1\` for short exits (optional)

## Available TA-Lib Functions (subset)
- ta.EMA(dataframe, timeperiod=N) → Series
- ta.SMA(dataframe, timeperiod=N) → Series
- ta.RSI(dataframe, timeperiod=N) → Series
- ta.ADX(dataframe, timeperiod=N) → Series
- ta.ATR(dataframe, timeperiod=N) → Series
- ta.MACD(dataframe, fastperiod=12, slowperiod=26, signalperiod=9) → (macd, signal, hist)
- ta.BBANDS(dataframe, timeperiod=20, nbdevup=2, nbdevdn=2) → (upper, middle, lower)
- ta.STOCH(dataframe, fastk_period=14, slowk_period=3, slowd_period=3) → (slowk, slowd)
- ta.CCI(dataframe, timeperiod=14) → Series
- ta.MOM(dataframe, timeperiod=10) → Series
- ta.WILLR(dataframe, timeperiod=14) → Series
- ta.MFI(dataframe, timeperiod=14) → Series
- ta.OBV(dataframe) → Series

## Column Naming Convention
- Feature indicator columns: \`tc_feat_{feature_name}\` (e.g., tc_feat_ema_crossover)
- Intermediate columns can use any name but should be descriptive

## Rules
1. Only output valid JSON. No markdown, no explanation.
2. All code must be syntactically valid Python 3.10+.
3. Use TA-Lib for standard technical indicators. Use pandas/numpy for calculations.
4. You MAY use any Python standard library or common third-party library (requests, urllib, json, etc.) for data acquisition. The only constraint is that the output must be a valid Freqtrade DataFrame with the expected columns.
5. Code must be self-contained—no undefined helper functions.
6. Handle edge cases: fillna(0), avoid division by zero.
7. The indicator code should compute a meaningful signal column (typically a score between -1 and 1, or a boolean).

## External Data Sources (news, social media, prediction markets, APIs)
For features that involve external data (news sentiment, social buzz, prediction markets, on-chain data, etc.):
- You ARE allowed and encouraged to use \`requests\`, \`urllib\`, \`json\`, or any HTTP client to fetch real data.
- Always wrap network calls in try/except. On failure (timeout, error, missing API key), gracefully fallback: fill the feature column with 0 or NaN — never let populate_indicators crash.
- Use \`os.environ.get("KEY_NAME", "")\` for API keys or credentials the user may need to provide.
- If the feature requires user-provided configuration (API keys, custom URLs, etc.), list them in the \`requiredConfig\` output field so the system can prompt the user.
- Example pattern:
  \`\`\`python
  import requests, os
  try:
      api_key = os.environ.get("NEWS_API_KEY", "")
      resp = requests.get(url, headers={"Authorization": api_key}, timeout=10)
      data = resp.json()
      # ... process into signal score ...
  except Exception:
      signal_score = 0.0  # graceful fallback
  \`\`\`

## Output Schema
{
  "featureName": "snake_case_name",
  "indicatorCode": "Python code for populate_indicators (multi-line string, 8-space indent)",
  "entryConditionCode": "Python expression for entry (e.g., dataframe['tc_feat_x'] > 0.5)",
  "exitConditionCode": "Python expression for exit (e.g., dataframe['tc_feat_x'] < -0.2)",
  "requiredImports": ["list of import statements if any beyond standard"],
  "columnNames": ["list of columns this code adds to dataframe"],
  "description": "What this code does",
  "requiredConfig": [
    {"key": "ENV_VAR_NAME", "label": "Human-readable label", "description": "What this config is for"}
  ]
}
Note: requiredConfig is optional. Only include it if the feature needs user-provided API keys, URLs, or other configuration to function fully. If not needed, omit or set to [].

## Examples

### Example 1: EMA Crossover
Input: { "name": "ema_crossover", "params": { "fast_period": 12, "slow_period": 26 } }
Output:
{
  "featureName": "ema_crossover",
  "indicatorCode": "        dataframe['ema_fast'] = ta.EMA(dataframe, timeperiod=12)\\n        dataframe['ema_slow'] = ta.EMA(dataframe, timeperiod=26)\\n        dataframe['tc_feat_ema_crossover'] = ((dataframe['ema_fast'] - dataframe['ema_slow']) / dataframe['close'].replace(0, 1)).clip(-1, 1)",
  "entryConditionCode": "(dataframe['tc_feat_ema_crossover'] > 0) & (dataframe['tc_feat_ema_crossover'].shift(1) <= 0)",
  "exitConditionCode": "(dataframe['tc_feat_ema_crossover'] < 0) & (dataframe['tc_feat_ema_crossover'].shift(1) >= 0)",
  "requiredImports": [],
  "columnNames": ["ema_fast", "ema_slow", "tc_feat_ema_crossover"],
  "description": "EMA 12/26 crossover signal normalized to [-1,1]"
}

### Example 2: RSI Oversold Bounce
Input: { "name": "rsi_oversold", "params": { "period": 14, "oversold": 30, "overbought": 70 } }
Output:
{
  "featureName": "rsi_oversold",
  "indicatorCode": "        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=14)\\n        dataframe['tc_feat_rsi_oversold'] = ((dataframe['rsi'] - 50.0) / 50.0).clip(-1, 1)",
  "entryConditionCode": "(dataframe['rsi'] < 30) & (dataframe['rsi'].shift(1) >= 30)",
  "exitConditionCode": "(dataframe['rsi'] > 70)",
  "requiredImports": [],
  "columnNames": ["rsi", "tc_feat_rsi_oversold"],
  "description": "RSI 14 oversold bounce: enter when RSI crosses below 30, exit when above 70"
}`;

/**
 * Build the user message for code generation.
 */
export function buildCodeGenerationUserMessage(params = {}) {
  const feature = params.feature && typeof params.feature === "object" ? params.feature : {};
  return JSON.stringify({
    name: String(feature.name || "").trim(),
    group: String(feature.group || "custom").trim(),
    kind: String(feature.kind || "custom").trim(),
    description: String(feature.description || "").trim(),
    params: feature.params && typeof feature.params === "object" ? feature.params : {},
    indicatorLogic: String(feature.indicatorLogic || "").trim(),
    entryCondition: String(feature.entryCondition || "").trim(),
    exitCondition: String(feature.exitCondition || "").trim(),
  });
}

export const CODE_REPAIR_SYSTEM_PROMPT = `You are ThunderClaw's Freqtrade Code Repair Agent.

Your job: fix Python code that failed validation. The code must work inside a Freqtrade IStrategy.

## Rules
1. Only output valid JSON matching the same schema as the original code generation.
2. Fix the specific error reported.
3. Keep the intent of the original code.
4. Ensure all TA-Lib calls use the correct API.
5. Ensure DataFrame operations are valid pandas.

## Output Schema (same as code generation)
{
  "featureName": "string",
  "indicatorCode": "string",
  "entryConditionCode": "string",
  "exitConditionCode": "string",
  "requiredImports": [],
  "columnNames": [],
  "description": "string"
}`;

/**
 * Build the user message for code repair.
 */
export function buildCodeRepairUserMessage(params = {}) {
  return JSON.stringify({
    originalCode: params.originalCode || {},
    validationErrors: Array.isArray(params.errors) ? params.errors : [],
    featureSpec: params.featureSpec || {},
  });
}
