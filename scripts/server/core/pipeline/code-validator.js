/**
 * Pipeline Stage 3: Code Validation
 *
 * Validates generated Python code for:
 * 1. Syntax correctness
 * 2. Runtime execution against a mock OHLCV DataFrame
 * 3. Contract correctness: compute_feature returns a Series aligned with df
 */

import { spawnSync } from "node:child_process";
import { toText } from "../../lib/utils.js";

function sanitizeFeatureName(valueLike, fallback = "custom_feature") {
  const value = toText(valueLike, fallback).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return value || fallback;
}

function buildFeatureColumnName(featureNameLike) {
  return `tc_feat_${sanitizeFeatureName(featureNameLike, "custom_feature")}`;
}

function safeFiniteValues(valuesLike) {
  return (Array.isArray(valuesLike) ? valuesLike : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function toOptionalFiniteNumber(valueLike) {
  if (valueLike === null || valueLike === undefined || valueLike === "") return null;
  const value = Number(valueLike);
  return Number.isFinite(value) ? value : null;
}

function summarizeNumericSeries(valuesLike = []) {
  const values = safeFiniteValues(valuesLike);
  if (!values.length) {
    return {
      mean: null,
      std: 0,
      min: null,
      max: null,
      nonNull: 0,
      uniqueFinite: 0,
      zeroRatio: 0,
      signChanges: 0,
    };
  }
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const variance = values.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / Math.max(1, values.length);
  let signChanges = 0;
  for (let i = 1; i < values.length; i += 1) {
    const prev = Math.sign(values[i - 1]);
    const current = Math.sign(values[i]);
    if (prev !== 0 && current !== 0 && prev !== current) signChanges += 1;
  }
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    min: Math.min(...values),
    max: Math.max(...values),
    nonNull: values.length,
    uniqueFinite: new Set(values.map((value) => value.toFixed(6))).size,
    zeroRatio: values.filter((value) => Math.abs(value) < 1e-10).length / Math.max(1, values.length),
    signChanges,
  };
}

function pearsonCorrelation(xsLike = [], ysLike = []) {
  const pairs = [];
  const xs = Array.isArray(xsLike) ? xsLike : [];
  const ys = Array.isArray(ysLike) ? ysLike : [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  if (pairs.length < 5) return null;
  const meanX = pairs.reduce((acc, [x]) => acc + x, 0) / pairs.length;
  const meanY = pairs.reduce((acc, [, y]) => acc + y, 0) / pairs.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  pairs.forEach(([x, y]) => {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  });
  if (denomX <= 0 || denomY <= 0) return null;
  return numerator / Math.sqrt(denomX * denomY);
}

function extractReferencedColumns(featureCodeLike) {
  const featureCode = toText(featureCodeLike, "");
  const refs = new Set();
  const ignoredMembers = new Set([
    "copy",
    "columns",
    "index",
    "loc",
    "iloc",
    "shape",
    "values",
    "dtype",
    "dtypes",
    "sort_values",
    "fillna",
    "replace",
    "dropna",
    "rolling",
    "mean",
    "std",
    "min",
    "max",
    "clip",
    "reindex",
    "astype",
    "shift",
    "pct_change",
  ]);
  const patterns = [
    /df\[['"]([a-zA-Z0-9_]+)['"]\]/g,
    /df\.([a-zA-Z0-9_]+)/g,
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(featureCode))) {
      const column = toText(match[1], "");
      if (column && !ignoredMembers.has(column)) refs.add(column);
    }
  });
  return Array.from(refs);
}

function classifyFailureTypeFromErrors(errorsLike = [], stage = "engineering") {
  const textBlob = (Array.isArray(errorsLike) ? errorsLike : []).join(" ").toLowerCase();
  if (stage === "semantic") return "semantics_mismatch";
  if (stage === "numeric") {
    if (textBlob.includes("nan")) return "all_nan";
    if (textBlob.includes("全零") || textBlob.includes("zero")) return "all_zero";
    if (textBlob.includes("波动") || textBlob.includes("variance")) return "low_variance";
  }
  if (textBlob.includes("syntax")) return "syntax_error";
  if (textBlob.includes("length") || textBlob.includes("shape")) return "shape_mismatch";
  if (textBlob.includes("timeout") || textBlob.includes("network") || textBlob.includes("api") || textBlob.includes("unavailable")) {
    return "external_data_unavailable";
  }
  return "runtime_contract_error";
}

function resolvePython() {
  const envPy = toText(process.env.THUNDERCLAW_FREQTRADE_PYTHON || "").trim();
  if (envPy) return envPy;

  // Try the freqtrade venv python first (has pandas, talib, numpy)
  const ftCmd = toText(process.env.THUNDERCLAW_FREQTRADE_CMD || "").trim();
  const candidates = [];
  if (ftCmd && ftCmd.includes("/")) {
    // Derive python from freqtrade binary path
    const binDir = ftCmd.replace(/\/freqtrade$/, "");
    candidates.push(`${binDir}/python`, `${binDir}/python3`);
  }
  // Also try the standard project-local venv path
  const cwd = process.cwd();
  candidates.push(
    `${cwd}/.thunderclaw/freqtrade-venv/bin/python`,
    `${cwd}/.thunderclaw/freqtrade-venv/bin/python3`,
  );
  candidates.push("python3", "python");

  for (const cmd of candidates) {
    if (!cmd) continue;
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: "pipe" });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return "python3";
}

/**
 * Validate that the feature module code is syntactically valid Python.
 */
function validateSyntax(code) {
  const errors = [];
  const featureCode = toText(code.featureCode);

  if (!featureCode) {
    errors.push("featureCode is empty");
    return { valid: false, errors };
  }

  const pyScript = [
    "import ast, sys",
    "errors = []",
    "",
    `feature_code = ${JSON.stringify(featureCode)}`,
    "try:",
    "    ast.parse(feature_code)",
    "except SyntaxError as e:",
    "    errors.append(f'featureCode syntax error: {e}')",
    "",
    "if errors:",
    "    print('ERRORS:' + '|||'.join(errors))",
    "    sys.exit(1)",
    "else:",
    "    print('SYNTAX_OK')",
  ].join("\n");

  const py = resolvePython();
  const run = spawnSync(py, ["-c", pyScript], { encoding: "utf8", timeout: 15_000, stdio: "pipe" });
  if (run.status !== 0) {
    const output = toText(run.stdout || run.stderr || "");
    if (output.startsWith("ERRORS:")) {
      errors.push(...output.slice(7).split("|||").map(e => e.trim()).filter(Boolean));
    } else {
      errors.push(`Python syntax check failed: ${output || "unknown error"}`);
    }
  }

  return { valid: errors.length === 0, errors };
}


/**
 * Validate that the code runs correctly against a mock DataFrame.
 * Creates a minimal OHLCV DataFrame, executes the module, invokes
 * compute_feature(df), and checks the returned object contract.
 */
function validateRuntime(code) {
  const errors = [];
  const warnings = [];
  const featureCode = toText(code.featureCode);

  if (!featureCode) {
    errors.push("featureCode is empty");
    return { valid: false, errors, warnings };
  }

  const pyScript = [
    "import sys, json, os",
    "try:",
    "    import pandas as pd",
    "    import numpy as np",
    "    import talib.abstract as ta",
    "except ImportError as e:",
    "    print(json.dumps({'ok': False, 'error': f'Missing dependency: {e}'}))",
    "    sys.exit(0)",
    "",
    "# Create mock OHLCV DataFrame with 100 bars",
    "np.random.seed(42)",
    "n = 100",
    "close_prices = 50000 + np.cumsum(np.random.randn(n) * 100)",
    "df = pd.DataFrame({",
    "    'date': pd.date_range('2025-01-01', periods=n, freq='1h'),",
    "    'open': close_prices + np.random.randn(n) * 50,",
    "    'high': close_prices + abs(np.random.randn(n) * 80),",
    "    'low': close_prices - abs(np.random.randn(n) * 80),",
    "    'close': close_prices,",
    "    'volume': np.random.randint(100, 10000, n).astype(float),",
    "})",
    "",
    "# Ensure high >= max(open, close) and low <= min(open, close)",
    "df['high'] = df[['open', 'close', 'high']].max(axis=1)",
    "df['low'] = df[['open', 'close', 'low']].min(axis=1)",
    "",
    "namespace = {}",
    `feature_code = ${JSON.stringify(featureCode)}`,
    "",
    "try:",
    "    exec(feature_code, namespace)",
    "except Exception as e:",
    "    print(json.dumps({'ok': False, 'error': f'Feature module exec error: {e}'}))",
    "    sys.exit(0)",
    "",
    "compute_feature = namespace.get('compute_feature')",
    "if not callable(compute_feature):",
    "    print(json.dumps({'ok': False, 'error': 'compute_feature is missing or not callable'}))",
    "    sys.exit(0)",
    "",
    "df_local = df.copy()",
    "baseline_cols = list(df_local.columns)",
    "try:",
    "    result = compute_feature(df_local)",
    "except Exception as e:",
    "    print(json.dumps({'ok': False, 'error': f'compute_feature runtime error: {e}'}))",
    "    sys.exit(0)",
    "",
    "if not isinstance(result, pd.Series):",
    "    print(json.dumps({'ok': False, 'error': f'compute_feature must return pandas.Series, got {type(result).__name__}'}))",
    "    sys.exit(0)",
    "",
    "if len(result) != len(df):",
    "    print(json.dumps({'ok': False, 'error': f'compute_feature returned length {len(result)} for df length {len(df)}'}))",
    "    sys.exit(0)",
    "",
    "mutated_cols = [c for c in df_local.columns if c not in baseline_cols]",
    "non_null = result.dropna()",
    "finite = non_null[np.isfinite(non_null)] if len(non_null) else non_null",
    "",
    "print(json.dumps({",
    "    'ok': True,",
    "    'row_count': len(result),",
    "    'non_null_count': int(len(non_null)),",
    "    'finite_count': int(len(finite)),",
    "    'null_count': int(result.isna().sum()),",
    "    'mutated_columns': mutated_cols,",
    "    'used_columns': baseline_cols,",
    "    'sample_values': [float(v) if pd.notna(v) and np.isfinite(v) else None for v in result.head(24).tolist()],",
    "    'stats': {",
    "        'mean': float(finite.mean()) if len(finite) else None,",
    "        'std': float(finite.std()) if len(finite) else 0.0,",
    "        'min': float(finite.min()) if len(finite) else None,",
    "        'max': float(finite.max()) if len(finite) else None,",
    "        'uniqueFinite': int(len(set([round(float(v), 8) for v in finite.tolist()]))) if len(finite) else 0,",
    "    },",
    "}))",
  ].join("\n");

  const py = resolvePython();
  const run = spawnSync(py, ["-c", pyScript], {
    encoding: "utf8",
    timeout: 30_000,
    stdio: "pipe",
  });

  if (run.error || run.status !== 0) {
    const stderr = toText(run.stderr || "");
    errors.push(`Runtime validation failed: ${toText(run.stdout || stderr || "unknown error")}`);
    return { valid: false, errors, warnings };
  }

  try {
    const output = JSON.parse(toText(run.stdout));
    if (!output.ok) {
      errors.push(toText(output.error, "Runtime error"));
      return { valid: false, errors, warnings, runtimeArtifacts: null };
    }
    const total = output.row_count || 100;
    const nullCount = Number(output.null_count || 0);
    if (nullCount > total * 0.8) {
      warnings.push(`Returned series has ${nullCount}/${total} null values`);
    }
    if (Array.isArray(output.mutated_columns) && output.mutated_columns.length) {
      errors.push(`compute_feature mutated df columns: ${output.mutated_columns.join(", ")}`);
    }
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      runtimeArtifacts: {
        rowCount: total,
        nullCount,
        finiteCount: Number(output.finite_count || 0),
        nonNullCount: Number(output.non_null_count || 0),
        sampleValues: Array.isArray(output.sample_values) ? output.sample_values : [],
        stats: output.stats && typeof output.stats === "object" ? output.stats : {},
        referencedColumns: extractReferencedColumns(featureCode),
        mutatedColumns: Array.isArray(output.mutated_columns) ? output.mutated_columns : [],
      },
    };
  } catch {
    errors.push("Failed to parse runtime validation output");
  }

  return { valid: errors.length === 0, errors, warnings, runtimeArtifacts: null };
}

function resolveSeriesContext(options = {}, code = {}) {
  const featureName = toText(options.featureName || code.featureName || "", "custom_feature");
  const evaluationResult = options.evaluationResult && typeof options.evaluationResult === "object"
    ? options.evaluationResult
    : null;
  if (!evaluationResult || !Array.isArray(evaluationResult.featureTimeSeries)) {
    return { values: [], volume: [], featureColumn: buildFeatureColumnName(featureName), stats: null };
  }
  const featureColumn = Array.isArray(evaluationResult.featureColumns) && evaluationResult.featureColumns.length
    ? toText(evaluationResult.featureColumns[0], buildFeatureColumnName(featureName))
    : buildFeatureColumnName(featureName);
  const values = evaluationResult.featureTimeSeries.map((row) => row?.[featureColumn]);
  const volume = evaluationResult.featureTimeSeries.map((row) => row?.volume);
  const stats = evaluationResult.featureStats && typeof evaluationResult.featureStats === "object"
    ? (evaluationResult.featureStats[featureColumn] || null)
    : null;
  return { values, volume, featureColumn, stats };
}

function validateNumericQuality(code, runtimeArtifacts, options = {}) {
  const errors = [];
  const warnings = [];
  const seriesContext = resolveSeriesContext(options, code);
  const stats = seriesContext.stats || summarizeNumericSeries(
    Array.isArray(seriesContext.values) && seriesContext.values.length
      ? seriesContext.values
      : runtimeArtifacts?.sampleValues || [],
  );
  const nonNull = Number(stats.nonNull ?? runtimeArtifacts?.nonNullCount ?? 0);
  if (!nonNull) {
    errors.push("特征输出全为空或全 NaN");
  }
  if (Number(stats.zeroRatio || 0) >= 0.999) {
    errors.push("特征输出几乎全零");
  }
  if (Number.isFinite(Number(stats.std)) && Number(stats.std) < 1e-8 && nonNull > 10) {
    errors.push("特征输出几乎没有波动");
  }
  if (Number.isFinite(Number(stats.std)) && Number(stats.std) > 0 && Number.isFinite(Number(stats.mean)) && Math.abs(Number(stats.mean)) > Math.abs(Number(stats.std)) * 50) {
    warnings.push("特征均值相对波动过大，可能存在异常尺度");
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
    featureColumn: seriesContext.featureColumn,
  };
}

function validateSemanticQuality(code, runtimeArtifacts, options = {}) {
  const errors = [];
  const warnings = [];
  const specArtifact = options.specArtifact && typeof options.specArtifact === "object" ? options.specArtifact : null;
  const routeFamily = toText(specArtifact?.family, "");
  const outputType = toText(specArtifact?.outputType, "");
  const outputRange = specArtifact?.outputRange && typeof specArtifact.outputRange === "object" ? specArtifact.outputRange : {};
  const seriesContext = resolveSeriesContext(options, code);
  const values = safeFiniteValues(
    Array.isArray(seriesContext.values) && seriesContext.values.length
      ? seriesContext.values
      : runtimeArtifacts?.sampleValues || [],
  );
  const stats = summarizeNumericSeries(values);
  const uniqueFinite = Number(stats.uniqueFinite || 0);
  const referencedColumns = Array.isArray(runtimeArtifacts?.referencedColumns) ? runtimeArtifacts.referencedColumns : [];
  const allowedColumns = Array.isArray(specArtifact?.inputColumns) ? specArtifact.inputColumns : [];

  if (allowedColumns.length) {
    const disallowed = referencedColumns.filter((column) => !allowedColumns.includes(column) && column !== "index");
    if (disallowed.length) {
      errors.push(`代码使用了未在 spec 中声明的输入列：${disallowed.join(", ")}`);
    }
  }
  const rangeMin = toOptionalFiniteNumber(outputRange.min);
  const rangeMax = toOptionalFiniteNumber(outputRange.max);
  if (rangeMin != null && Number.isFinite(Number(stats.min)) && Number(stats.min) < rangeMin - 1e-6) {
    errors.push(`输出低于 spec 约束下界 ${rangeMin}`);
  }
  if (rangeMax != null && Number.isFinite(Number(stats.max)) && Number(stats.max) > rangeMax + 1e-6) {
    errors.push(`输出高于 spec 约束上界 ${rangeMax}`);
  }
  if (outputType === "categorical" || routeFamily === "trend") {
    if (uniqueFinite > 5) {
      errors.push("趋势/离散类特征输出值过于连续，不像过滤信号");
    }
    if (stats.signChanges < 1 && values.length > 20) {
      warnings.push("趋势过滤类特征几乎没有状态切换");
    }
  }
  if (outputType === "bounded_oscillator") {
    if (Number(stats.min) < -1e-6 || Number(stats.max) > 100.000001) {
      errors.push("振荡器类特征未保持在合理区间 0-100 内");
    }
  }
  if (outputType === "continuous_non_negative" || routeFamily === "volatility") {
    if (Number(stats.min) < -1e-8) {
      errors.push("波动率类特征出现负值，违反非负约束");
    }
  }
  if (routeFamily === "volume") {
    const corr = pearsonCorrelation(seriesContext.volume, seriesContext.values);
    if (corr != null && Math.abs(corr) < 0.05) {
      warnings.push("成交量类特征与 volume 的相关性较弱，可能不符合原始语义");
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}

/**
 * Create the code validator.
 */
export function createCodeValidator() {
  function validateEngineering(code) {
    const syntax = validateSyntax(code);
    if (!syntax.valid) {
      return {
        valid: false,
        errors: syntax.errors,
        warnings: [],
        runtimeArtifacts: null,
      };
    }
    return validateRuntime(code);
  }

  function validateNumeric(code, runtimeArtifacts, options = {}) {
    return validateNumericQuality(code, runtimeArtifacts, options);
  }

  function validateSemantic(code, runtimeArtifacts, options = {}) {
    return validateSemanticQuality(code, runtimeArtifacts, options);
  }

  /**
   * Validate generated code.
   * @param {Object} code - Generated code from code-generator
   * @param {Object} [options]
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  function validate(code, options = {}) {
    const allErrors = [];
    const allWarnings = [];
    const engineering = validateEngineering(code);
    allErrors.push(...engineering.errors);
    allWarnings.push(...(engineering.warnings || []));
    const numeric = engineering.valid
      ? validateNumeric(code, engineering.runtimeArtifacts, options)
      : { valid: true, errors: [], warnings: [], stats: null };
    const semantic = engineering.valid
      ? validateSemantic(code, engineering.runtimeArtifacts, options)
      : { valid: true, errors: [], warnings: [], stats: null };
    allErrors.push(...numeric.errors, ...semantic.errors);
    allWarnings.push(...(numeric.warnings || []), ...(semantic.warnings || []));
    const failureType = allErrors.length
      ? (
        engineering.errors.length
          ? classifyFailureTypeFromErrors(engineering.errors, "engineering")
          : (numeric.errors.length
            ? classifyFailureTypeFromErrors(numeric.errors, "numeric")
            : classifyFailureTypeFromErrors(semantic.errors, "semantic"))
      )
      : "";

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
      engineering,
      numeric,
      semantic,
      failureType,
      runtimeArtifacts: engineering.runtimeArtifacts || null,
    };
  }

  return {
    validate,
    validateEngineering,
    validateNumeric,
    validateSemantic,
  };
}
