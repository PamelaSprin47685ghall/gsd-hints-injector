# GSD Hints Injector

`gsd-hints-injector` does exactly three orthogonal things:

1. **Inject HINTS into the stable system prompt.**
2. **Move known dynamic system prompt lines into a hidden user message.**
3. **Stabilize Responses payload identifiers that would otherwise change per conversation.**

Those concerns are deliberately separate. HINTS injection should not depend on provider payload shape. Dynamic context movement should not depend on Responses-specific IDs. Responses identifier stabilization should not decide what belongs in the prompt.

## Installation

```bash
gsd install git:github.com/PamelaSprin47685ghall/gsd-hints-injector
```

## HINTS Sources

1. Global hints: `~/.gsd/HINTS.md`, or `${GSD_HOME}/HINTS.md` when `GSD_HOME` is set.
2. Project hints: `.gsd/HINTS.md`, falling back to `HINTS.md` in the project root.
