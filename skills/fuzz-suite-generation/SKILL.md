---
name: fuzz-suite-generation
description: Generate stateful fuzz suites for Solidity projects. Use when Codex needs to add, extend, or repair Echidna or Medusa fuzz harnesses, invariant or property tests, Foundry or Hardhat fuzzing setup, regression tests from counterexamples, or plain-English properties turned into executable campaigns.
metadata:
  source: local:codex
---

# Fuzz Suite Generation

## Overview

Generate a fuzz suite that is easy to review, easy to extend, and stable enough to rerun after protocol changes. Prefer explicit invariants, small handlers, and deterministic regressions over broad, opaque generation.

## Workflow

### 1. Identify the target shape

- Detect whether the repo is Foundry or Hardhat, then locate the contracts, test layout, and any existing invariant helpers.
- Scope the suite to the smallest realistic state space that still exercises the risk boundary.
- If the target framework, contract set, or property set is ambiguous, ask one focused question before generating code.

### 2. Extract properties

- Convert protocol claims into observable safety properties.
- Keep each property narrow: one balance relation, one access-control rule, one lifecycle constraint, or one conservation invariant.
- Preserve user-supplied invariants verbatim unless they are impossible to observe; add only adjacent properties that make the suite meaningful.

### 3. Build the harness

- Place the suite in the repository's fuzz-test location, usually `test/fuzz/`.
- Model actors, roles, initial state, and setup paths explicitly.
- Keep handlers small and deterministic, and avoid hidden coupling between them.
- Reuse existing setup helpers and invariant helpers instead of duplicating protocol bootstrapping.

### 4. Run and tighten

- Compile before running any campaign.
- Start with the narrowest target and the fewest moving parts.
- Treat setup bugs and unrealistic assumptions as harness bugs, not protocol findings.
- When a counterexample is real, shrink it into a deterministic regression test and keep the harness aligned with the fix.

### 5. Finish with a report

- Summarize the target scope, properties added, coverage reached, confirmed failures, and remaining gaps.
- Call out whether the suite is ready for broader campaigning with the repo's native fuzz runner, Echidna, or Medusa.

## Output conventions

- Use `test/fuzz/` for harnesses unless the repository already uses a stable alternative.
- Use `PROPERTIES.md` when a plain-English property list helps review or handoff.
- Use `report.md` for campaign summary and confirmed issues.

## Guardrails

- Do not assert properties the harness cannot observe.
- Do not encode external oracle assumptions as protocol truths.
- Do not hide missing setup behind broad `assume` filters.
- Do not claim success until the harness compiles and the campaign is reproducible.
