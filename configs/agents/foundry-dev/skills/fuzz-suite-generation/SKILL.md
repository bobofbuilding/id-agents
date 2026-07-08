---
name: fuzz-suite-generation
description: Use when adding or refreshing stateful fuzzing or invariant coverage for a Foundry Solidity codebase. Covers property selection, plain-English property docs, handler-based harnesses, deterministic reproduction tests, and Echidna/Medusa-compatible campaigns.
license: MIT
version: 0.1.0
tags: [foundry, solidity, fuzzing, invariants, echidna, medusa, testing]
---

# Fuzz Suite Generation

Adapted from [Pashov Audit Group Skills](https://github.com/pashov/skills) (MIT), especially the `fizz` skill.

You are building a fuzz suite for a Solidity codebase. The point is to encode real safety properties as executable checks, not to spray random calls and hope a bug appears.

This skill belongs to the builder/test-author lane. It writes and maintains fuzzing artifacts, but it does not replace a dedicated security review or final exploitability judgment.

If the project is unfamiliar, read `using-foundry` first. If you need concrete assertion, handler, or invariant-test patterns while implementing the suite, read `writing-foundry-tests`.

## Default Posture

- Prefer Foundry for compilation, fast iteration, and local debugging.
- Use Echidna and Medusa for long-running stateful campaigns once the harness is stable.
- Keep generated tests under `test/fuzz/` or the repo's existing fuzz location.
- Keep campaign metadata, seeds, and replay notes under `fuzz_data/` unless the project already uses a different convention.
- Keep human-readable property notes in `PROPERTIES.md` when the repo does not already document them elsewhere.
- Reuse existing tests, helpers, and factories before adding new abstractions.

## Workflow

1. Map the surface.
   - Read the target contracts, `foundry.toml`, existing invariant tests, and any prior fuzz helpers.
   - Identify global state, privileged entry points, user-controlled inputs, and money-moving paths.
2. Choose properties worth proving.
   - Prefer invariants that must hold across arbitrary call sequences.
   - Encode constraints in the harness when a property only applies to a subset of actors or phases.
   - Avoid implementation trivia unless it is the actual safety boundary.
3. Design the harness.
   - Use handler contracts when the fuzzer should only reach sensible actions.
   - Track ghost state when on-chain state alone does not explain the property.
   - Bound or filter inputs so runs hit meaningful states instead of revert spam.
4. Implement the smallest useful suite.
   - Add focused invariant tests, fuzz tests, or both.
   - Write the intended properties in plain English before or alongside the executable checks.
   - Prefix helpers with `_` and keep test names explicit.
   - Make failures debuggable with clear assertion messages or traces.
5. Turn failures into regressions.
   - Save every counterexample as a deterministic reproduction before expanding the campaign.
   - Keep reproducer tests adjacent to the property it broke.
6. Run the campaign.
   - Start with Foundry smoke tests.
   - Move to Echidna and/or Medusa once the suite compiles and the properties are stable.
   - If a required tool is missing, report exactly what was attempted and what is unavailable.
7. Tighten the suite.
   - Remove false positives, overbroad assumptions, and dead handlers.
   - Prefer a smaller suite with strong properties over a larger one that passes by accident.

## Rules

- Do not invent a fuzz harness if the repo already has one you can extend.
- Do not claim success unless the suite actually exercised the target surface.
- Do not let revert-only paths dominate the campaign; refine bounds or handler logic instead.
- Do not encode implementation details as invariants unless they represent a real safety boundary.
- Do not mix unrelated protocols or contracts into one harness unless they share the same property.
- Do not ship a suite without a deterministic reproducer for every counterexample you found.
- Do not present fuzzing output as a complete audit; hand confirmed security findings back to the security-review track.

## Suggested Artifacts

- `test/fuzz/<Target>Fuzz.t.sol` for property tests
- `test/invariant/<Target>Invariant.t.sol` for long-run invariants
- `test/fuzz/handlers/<Target>Handler.sol` for restricted action surfaces
- `PROPERTIES.md` for plain-English invariants, assumptions, and out-of-scope behaviors
- `fuzz_data/` for seeds, campaign notes, and replay metadata

## Output Standard

When you finish a fuzz-suite pass, report:

- target contracts covered
- invariants or properties encoded
- where the plain-English property notes live
- campaign tools used or intentionally skipped
- known gaps or follow-ups
- reproduction notes for any counterexamples

## Reference

Source repository: https://github.com/pashov/skills (MIT license)

This skill is adapted from the `fizz` skill in that repository, not copied verbatim.
