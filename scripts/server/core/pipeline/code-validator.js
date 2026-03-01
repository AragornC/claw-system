/**
 * Pipeline Stage 3: Code Validation
 *
 * Validates generated Python code for:
 * 1. Syntax correctness (Python AST parse)
 * 2. Runtime execution in a sandbox DataFrame context
 * 3. Entry/exit condition compilation
 */

import { spawnSync } from "node:child_process";
import { toText } from "../../lib/utils.js";

function resolvePython() {
  const envPy = toText(process.env.THUNDERCLAW_FREQTRADE_PYTHON || "").trim();
  if (envPy) return envPy;
  // Try the freqtrade venv python first
  const candidates = [
    process.env.THUNDERCLAW_FREQTRADE_CMD
      ? process.env.THUNDERCLAW_FREQTRADE_CMD.replace(/freqtrade$/, "python")
      : "",
    "python3",
    "python",
  ];
  for (const cmd of candidates) {
    if (!cmd) continue;
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: "pipe" });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return "python3";
}

/**
 * Validate that the indicator code is syntactically valid Python.
 */
function validateSyntax(code) {
  const errors = [];
  const indicatorCode = toText(code.indicatorCode);
  const entryCode = toText(code.entryConditionCode);
  const exitCode = toText(code.exitConditionCode);

  if (!indicatorCode) {
    errors.push("indicatorCode is empty");
    return { valid: false, errors };
  }

  // Build a Python script that parses all code fragments
  const pyScript = [
    "import ast, sys",
    "errors = []",
    "",
    "# Validate indicator code (statements in method body)",
    "indicator_code = '''",
    "def _test_indicator(dataframe):",
    ...indicatorCode.split("\n").map(line => {
      // Ensure proper indentation for the test function
      const trimmed = line.replace(/^        /, "    ");
      return trimmed;
    }),
    "    return dataframe",
    "'''",
    "try:",
    "    ast.parse(indicator_code)",
    "except SyntaxError as e:",
    "    errors.append(f'indicatorCode syntax error: {e}')",
    "",
    "# Validate entry condition (expression)",
    `entry_code = '''${escPy(entryCode || "True")}'''`,
    "try:",
    "    ast.parse(entry_code, mode='eval')",
    "except SyntaxError as e:",
    "    errors.append(f'entryConditionCode syntax error: {e}')",
    "",
    "# Validate exit condition (expression)",
    `exit_code = '''${escPy(exitCode || "True")}'''`,
    "try:",
    "    ast.parse(exit_code, mode='eval')",
    "except SyntaxError as e:",
    "    errors.append(f'exitConditionCode syntax error: {e}')",
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

function escPy(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'");
}

/**
 * Validate that the code runs correctly against a mock DataFrame.
 * Creates a minimal OHLCV DataFrame, executes the indicator code,
 * and checks that the expected columns are produced with valid values.
 */
function validateRuntime(code) {
  const errors = [];
  const warnings = [];
  const indicatorCode = toText(code.indicatorCode);
  const featureName = toText(code.featureName, "test");
  const expectedCol = `tc_feat_${featureName}`;

  if (!indicatorCode) {
    errors.push("indicatorCode is empty");
    return { valid: false, errors, warnings };
  }

  // Ensure we indent properly - the code may or may not have 8-space indent
  const codeLines = indicatorCode.split("\n").map(line => {
    const stripped = line.replace(/^        /, "");
    return `        ${stripped}`;
  });

  const pyScript = [
    "import sys, json",
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
    "# Run indicator code inside a mock method",
    "class MockStrategy:",
    "    def populate_indicators(self, dataframe, metadata):",
    ...codeLines,
    "        return dataframe",
    "",
    "try:",
    "    strategy = MockStrategy()",
    "    result = strategy.populate_indicators(df.copy(), {'pair': 'BTC/USDT'})",
    "except Exception as e:",
    "    print(json.dumps({'ok': False, 'error': f'Runtime error: {e}'}))",
    "    sys.exit(0)",
    "",
    "# Check results",
    "columns_added = [c for c in result.columns if c not in df.columns]",
    `expected_col = '${expectedCol}'`,
    "has_expected = expected_col in result.columns",
    "nan_counts = {}",
    "for col in columns_added:",
    "    nan_count = int(result[col].isna().sum())",
    "    nan_counts[col] = nan_count",
    "",
    "print(json.dumps({",
    "    'ok': True,",
    "    'columns_added': columns_added,",
    "    'has_expected_column': has_expected,",
    "    'row_count': len(result),",
    "    'nan_counts': nan_counts,",
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
      return { valid: false, errors, warnings };
    }
    if (!output.has_expected_column) {
      warnings.push(`Expected column '${expectedCol}' not found. Columns added: ${(output.columns_added || []).join(", ")}`);
    }
    // Check for excessive NaN counts
    const nanCounts = output.nan_counts || {};
    for (const [col, count] of Object.entries(nanCounts)) {
      const total = output.row_count || 100;
      if (count > total * 0.5) {
        warnings.push(`Column '${col}' has ${count}/${total} NaN values`);
      }
    }
  } catch {
    errors.push("Failed to parse runtime validation output");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Create the code validator.
 */
export function createCodeValidator() {
  /**
   * Validate generated code.
   * @param {Object} code - Generated code from code-generator
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  function validate(code) {
    const allErrors = [];
    const allWarnings = [];

    // Step 1: Syntax check
    const syntax = validateSyntax(code);
    if (!syntax.valid) {
      allErrors.push(...syntax.errors);
      return { valid: false, errors: allErrors, warnings: allWarnings };
    }

    // Step 2: Runtime check
    const runtime = validateRuntime(code);
    allErrors.push(...runtime.errors);
    allWarnings.push(...(runtime.warnings || []));

    return {
      valid: allErrors.length === 0,
      errors: allErrors,
      warnings: allWarnings,
    };
  }

  return { validate };
}
