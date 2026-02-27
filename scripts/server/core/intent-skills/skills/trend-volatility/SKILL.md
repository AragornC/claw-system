---
name: trend-volatility
version: 1
description: Extract trend/volatility intent features (EMA/ATR) from dialogue.
---

# Trend Volatility Skill

Extract common trend and volatility feature candidates using rule mapping.

## Inputs
- `context.mergedText` (lowercased dialogue)

## Output contract
- `intentDetected`: boolean
- `confidence`: number
- `reasoning`: string
- `featureCandidates`: feature-candidate[]
- `strategyHints`: object

Rules are defined in `references/rules.json`.
