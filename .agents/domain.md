# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repo.

Read these before architecture, diagnosis, TDD, triage, PRD, or issue-generation work:

- `CONTEXT.md` at the repo root, if it exists.
- `.agents/adr/` at the repo root, if it exists.

If either path does not exist, proceed silently. The producer skill (`grill-with-docs`) creates domain docs lazily when terms or decisions actually get resolved.

## Expected Structure

```text
/
├── CONTEXT.md
├── .agents/adr/
│   ├── 0001-runtime-owned-rule-packs.md
│   └── 0002-plugin-surfaces.md
└── packages/
```

## Use the Glossary's Vocabulary

When output names a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the concept is missing from the glossary, either avoid inventing new language or note the gap for `grill-with-docs`.

## Flag ADR Conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (runtime-owned rule packs), but worth reopening because..._
