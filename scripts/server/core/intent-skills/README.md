# Intent Skill Registry (Server Runtime)

This folder now follows a declarative skill-package layout:

```text
intent-skills/
  index.js                     # loader + orchestrator
  skills/
    <skill-name>/
      SKILL.md                 # skill metadata & contract
      references/rules.json    # rule definitions
```

## Runtime contract

- `index.js` loads `skills/*/SKILL.md` metadata and `references/rules.json` at startup.
- Each declarative skill returns:
  - `intentDetected`
  - `confidence`
  - `reasoning`
  - `featureCandidates`
  - `strategyHints`

## Rules

- Add or edit extraction logic in `skills/<name>/references/rules.json`.
- Avoid embedding heuristic branches directly in `trading-intent-skill.js`.
- Keep skill metadata in `SKILL.md` and rules in `references/` for maintainability.
