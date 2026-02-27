---
name: external-signal
version: 1
description: Extract external signal features (news/social/prediction) from natural dialogue.
---

# External Signal Skill

Detect external signal feature candidates from colloquial dialogue.

## Inputs
- `context.mergedText` (lowercased dialogue)

## Output contract
- `intentDetected`: boolean
- `confidence`: number
- `reasoning`: string
- `featureCandidates`: feature-candidate[]
- `strategyHints`: object

Rules are defined in `references/rules.json`.
