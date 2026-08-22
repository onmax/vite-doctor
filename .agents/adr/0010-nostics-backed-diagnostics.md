# Nostics-Backed Diagnostics

Doctor uses `nostics` as the internal diagnostic primitive. Rules emit real `nostics` diagnostics and Doctor attaches analysis metadata such as rule ID, severity, category, file range, evidence, confidence, fingerprints, suppression state, and structured fixes.

Doctor exposes a diagnostics host shaped like the Vite DevTools diagnostics host: package authors define diagnostics, register them into a shared code registry, and can look up handles by code. Doctor keeps the Doctor report boundary separate because file ranges, runtime evidence, confidence, suppressions, and rule IDs are Doctor metadata rather than `nostics` fields.

Built-in Doctor rules emit diagnostics through typed package handles and pass Doctor metadata at the report boundary: `ctx.report(diagnostics.NUXT0001(params), metadata)`. The legacy single-object `ctx.report({ message, suggestion, ... })` shape is removed rather than kept as a compatibility layer.

The diagnostics host exposes callable `nostics` handles. Doctor rules call a handle to create project findings, and Doctor authoring failures, invalid extension registration, and internal invariants use `throw diagnostics.CODE(params)` when continuing would make the run unreliable.

`nostics.sources` is reserved for concrete source locations that caused the diagnostic, such as `file:line:column` entries from user code or generated evidence that points back to user code. It must not be used as a general reference-link bucket. Upstream documentation, rule documentation, framework references, and explanatory material remain in `docs`, the Diagnostic Reference, or Doctor evidence/reference metadata so agents can distinguish "where the problem is" from "where to learn more."

Doctor does not add a separate messages API. Free-form run information such as summaries, missing evidence notes, and timing data remains Doctor Run metadata. Project findings must be coded diagnostics.

The diagnostics model must not make the Nuxt 4 integration path permanent. Nuxt 4-specific inventory and runtime evidence belong behind the Nuxt 4 Bridge, a transitional plugin-surface boundary that can be removed when Nuxt support can run only through the Vite Plugin Surface. Nuxt rule packs and diagnostic codes are separate from that bridge and can continue if the rules remain relevant.

Vite Doctor is the single public package identity. Framework names such as Vue, Nitro, and Nuxt describe built-in rule packs, diagnostic prefixes, host commands, or transitional bridge boundaries, not separate public install requirements. Vite Doctor should auto-activate built-in rule packs from the target project rather than asking users to install or select separate framework packages. Legacy framework-specific public CLI binaries such as `vue-doctor` and `nuxt-doctor` are removed as part of the breaking migration. The Nuxt 4 Bridge may still register `nuxt doctor` as a Nuxt host command; that command delegates to Vite Doctor and is not a separate package identity.

Nuxt projects install the `vite-doctor` package and configure the Nuxt module subpath explicitly as `vite-doctor/nuxt`. Nuxt's `module add` command writes package names into `modules`, so Doctor docs should not recommend `nuxt module add vite-doctor` unless Nuxt gains a supported way to add subpath modules. The package root remains the Vite Doctor API; the Nuxt module remains available through the `vite-doctor/nuxt` export. The Nuxt 4 Bridge can then collect Nuxt-specific evidence and expose `nuxt doctor`. The standalone `vite-doctor` CLI remains available for generic projects, CI, monorepos, and fallback use.

Framework-specific workspace packages may remain temporarily as private internal organization boundaries. They are not public install targets, do not expose framework-specific binaries, and can be folded into the Vite Doctor package later if the extra workspace boundaries stop paying for themselves.

This is a breaking migration with no legacy compatibility layer. Doctor keeps rule IDs for rule-pack organization and CLI selection, but emitted conditions receive stable short diagnostic codes. Codes use package-owned uppercase prefixes followed by four digits: `DOC`, `VUE`, `VITE`, `TS`, `NITRO`, and `NUXT`. Codes are assigned sequentially per package and are not reused.

Every emitted Doctor rule diagnostic must include a `fix` string, even though `nostics` and Vite DevTools allow fixes to be optional. Doctor is optimized for agent consumers and CI remediation, so a reported rule diagnostic must always provide next-step guidance. Structured edit plans remain optional Doctor metadata, while `nostics.fix` is the human and agent remediation guidance.

Diagnostic documentation lives at `https://vite-doctor.onmax.me/diagnostics/CODE`. Every user-facing project diagnostic code that reports an issue in analyzed project code must have a generated documentation page before shipping. Internal authoring failures, invariant diagnostics, and run-stopping Surface Configuration validation diagnostics may opt out of docs links when the actionable fix is fully contained in the diagnostic. Rule catalog pages remain separate from diagnostic pages because one rule can emit multiple diagnostic codes.

Doctor no longer owns a custom human formatter model. The default human output uses `nostics` rendering. Machine-readable JSON and SARIF encodings remain for automation and code-scanning integrations.

Agent consumers run Doctor and consume diagnostics. Claude Code is the first supported agent consumer through a Doctor skill; Codex and Cursor are planned. Doctor does not expose an MCP server as part of this model.
