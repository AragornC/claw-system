---
name: market-context
version: 1
description: Detect whether a dialogue includes actionable trading-market context.
---

# Market Context Skill

Determine if user/assistant dialogue contains market-trading intent.

## Inputs
- `context.mergedText` (lowercased dialogue)

## Output contract
- `intentDetected`: boolean
- `confidence`: number
- `reasoning`: string
- `featureCandidates`: []
- `strategyHints`: {}

Load `references/rules.json` and trigger when any keyword appears.
