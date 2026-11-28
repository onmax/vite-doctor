# Doctor

Doctor is a diagnostics system for Vue, Vite, Nitro, Nuxt, and adjacent ecosystem projects. It exists to surface framework-specific risks through rules that can run from CLIs and framework integrations.

## Language

**Doctor**:
A diagnostics product that analyzes a project and reports actionable framework or ecosystem issues.
_Avoid_: Linter, checker

**Rule**:
A single diagnostic policy that can report one kind of issue.
_Avoid_: Check, inspection

**Rule Pack**:
A stable library-author format for a named collection of rules owned by a runtime, framework, or ecosystem library.
_Avoid_: Plugin, preset

**TypeScript Rule Pack**:
The built-in language-owned Rule Pack that activates its Recommended Preset when Project Inventory proves that a project contains TypeScript. It composes with framework Rule Packs instead of belonging to any framework preset.
_Avoid_: Vite TypeScript rules, Vue TypeScript rules

**Preset**:
A named selection of rules inside a rule pack.
_Avoid_: Group, ruleset

**Recommended Preset**:
The required default preset in every rule pack.
_Avoid_: Default group

**Strict Preset**:
An optional preset that enables every rule in a rule pack except opt-in policy rules, including noisy, migration-oriented, or opinionated rules. An opt-in policy rule, such as a ban on comments, runs only when Surface Configuration names it in `rules`.
_Avoid_: Full group

**Surface Configuration**:
The options passed to a CLI surface or plugin surface to select rule packs, presets, extensions, and failure behavior for a Doctor run.
_Avoid_: Config file

**Config Extends**:
The surface configuration field that selects rule-pack-qualified presets.
_Avoid_: Preset list

**Activation**:
The conditions that make a rule pack and its default preset apply automatically to a project. Runtime Evidence can activate a rule pack for every workspace package, as MCP servers read with `--mcp-url` activate the MCP rule pack.
_Avoid_: Detection, matching

**Vite Doctor**:
The single public Doctor distribution and package identity. It runs Doctor and activates built-in framework rule packs based on the target project.
_Avoid_: Nuxt Doctor package, Vue Doctor package, Nitro Doctor package

**Doctor Extension**:
An internal extension that contributes rule packs, project inventory, runtime evidence, reporters, or project detectors to Doctor.
_Avoid_: Plugin

**Doctor Run**:
A single execution of Doctor against a project using selected rule packs, project inventory, runtime evidence, and run options.
_Avoid_: Scan, check

**Diagnostic Code**:
A stable short code for one emitted diagnostic condition, used in output, documentation URLs, and agent workflows.
_Avoid_: Rule ID

**Diagnostic Code Prefix**:
An uppercase package-owned prefix reserved for a rule pack family, followed by a four-digit number.
_Avoid_: Error namespace

**Diagnostic**:
A `nostics`-backed reported issue produced by a rule, identified by a diagnostic code and enriched with Doctor metadata such as rule ID, severity, location, evidence, confidence, and suggested remediation.
_Avoid_: Error, warning

**Diagnostics Host**:
The shared Doctor facility for defining, registering, and looking up diagnostic codes through `nostics` handles.
_Avoid_: Formatter, reporter

**Project Inventory**:
The discovered facts about a target project that rules use during analysis.
_Avoid_: Project metadata, scan data

**Component Contract**:
What a component promises the design system, declared statically so Rules can enforce it at call sites. A project component declares it in `<script setup>` as `defineOptions({ doctor: { replaces: "button" } })`; a component the project does not own gets the same object in a design-system Rule's `contracts` option. It holds `replaces`, the raw HTML elements call sites should render the component instead of, and `limits`, how many matching usages one **View** may render.
_Avoid_: Component metadata, component annotation

**View**:
Everything one Nuxt route renders at once: the main app, the route's layout, its parent pages, and the page, each followed through the components they render. Design-system Rules count a usage in a View only when it renders every time the View does.
_Avoid_: Screen, page (a page is one file of a View)

**Runtime Evidence**:
Facts that explain where and how code executes across client, server, build, and framework runtimes.
_Avoid_: Context, environment

**Build Evidence**:
Runtime Evidence that the Vite Plugin Surface collects from a finished `vite build`: each environment's consumer, its output chunks with their module ids, and Vite's importers for each module.
_Avoid_: Bundle stats, build manifest

**Plugin Surface**:
A framework or build-tool integration that runs Doctor inside the host system and can contribute project inventory or runtime evidence.
_Avoid_: Module, extension

**Vite Plugin Surface**:
The Vite-native build-tool bridge for running Doctor with Vite, Vue, Nuxt, and future Vite-based ecosystem integrations.
_Avoid_: Vite rule runner

**Nuxt 4 Bridge**:
A transitional Doctor integration boundary for Nuxt 4 projects that supplies Nuxt-specific project inventory and runtime evidence until Nuxt support can run only through the Vite Plugin Surface.
_Avoid_: Nuxt Rule Pack, Compatibility Layer

**Nuxt Doctor Command**:
The `nuxt doctor` command registered by the Nuxt 4 Bridge inside Nuxt projects.
_Avoid_: Nuxt Doctor package, nuxt-doctor binary

**CLI Surface**:
A command-line entrypoint that runs Doctor directly.
_Avoid_: Binary, command

**Rule Catalog**:
The documented list of rules, their metadata, and their public explanations.
_Avoid_: Docs index, rule docs

**Diagnostic Reference**:
The documented list of diagnostic codes and code-specific remediation pages.
_Avoid_: Error Reference

**Report Budget**:
The character limit of a text or agent report.
_Avoid_: truncation, pagination, verbosity

**Progressive Report**:
A report that prints its head whole, then groups, rows, and detail until the Report Budget, and names the command that shows more.
_Avoid_: compact mode, summary mode

**Report Reader**:
Who Doctor assumes reads a report when no `--format` is given: an agent, CI, a terminal, or a pipe. It changes the report format and the Report Budget, never the Doctor Run.
_Avoid_: mode, audience

**Agent Consumer**:
An AI coding tool that runs Doctor or consumes Doctor reports and uses structured diagnostics to guide remediation.
_Avoid_: Agent surface

## Relationships

- A **Doctor** contains one or more **Rule Packs**.
- A **Doctor Extension** contributes capabilities to a **Doctor**.
- A **Doctor Extension** can contribute **Project Inventory** and **Runtime Evidence**.
- A **Doctor Run** executes a **Doctor** against one project.
- A **Rule Pack** contains one or more **Rules**.
- A **Rule Pack** can define one or more **Presets**.
- A **Rule Pack** must define a **Recommended Preset**.
- A **Rule Pack** can define a **Strict Preset**.
- A **Rule Pack** can define **Activation** conditions.
- **Vite Doctor** activates built-in **Rule Packs** for detected project frameworks.
- **Vite Doctor** activates the **TypeScript Rule Pack** independently for TypeScript projects.
- A **Plugin Surface** receives **Surface Configuration** from its host system.
- **Surface Configuration** can include **Config Extends**.
- A **Rule** produces zero or more **Diagnostics**.
- A **Diagnostic** has one **Diagnostic Code**.
- A **Diagnostic Code** starts with one **Diagnostic Code Prefix**.
- A **Diagnostics Host** defines, registers, and exposes **Diagnostic Codes**.
- A **Rule** can produce more than one **Diagnostic Code** when distinct emitted conditions need distinct documentation or fixes.
- A **Rule** reads **Project Inventory** and **Runtime Evidence**.
- A component declares at most one **Component Contract**; Doctor reads it statically from the SFC into **Project Inventory**, and only literal values count.
- Design-system **Rules** enforce **Component Contracts** at call sites; a contract Doctor cannot read is itself a **Diagnostic**.
- A **Component Contract** can limit how many of its usages one **View** renders; Doctor builds **Views** only for Nuxt routes it can read statically.
- A **Doctor** can be exposed through **CLI Surfaces** and **Plugin Surfaces**.
- A **Plugin Surface** can contribute **Project Inventory** and **Runtime Evidence**.
- A **Plugin Surface** attaches **Doctor Extensions** that other host plugins or modules register through the host, such as Vite plugin `api.doctor` or the Nuxt `doctor:extendExtensions` hook.
- A **CLI Surface** loads host-registered **Doctor Extensions** only from a host command or an explicit opt-in.
- The **Vite Plugin Surface** is a **Plugin Surface**.
- The **Vite Plugin Surface** contributes **Build Evidence** during `vite build`; the **CLI Surface** has none.
- The **Nuxt 4 Bridge** is a transitional **Plugin Surface** boundary, not a **Rule Pack**.
- The **Nuxt 4 Bridge** can expose the **Nuxt Doctor Command**.
- A **Rule Catalog** documents **Rule Packs** and **Rules**.
- A **Diagnostic Reference** documents **Diagnostic Codes**.
- An **Agent Consumer** runs Doctor or consumes Doctor reports; it is not a Doctor surface.
- Text and agent reports are **Progressive Reports** under a **Report Budget**; JSON and SARIF reports are always complete, and a **Report Budget** never changes a **Doctor Run**.
- The **Report Reader** picks the default format and **Report Budget**: an agent gets the agent report, CI gets the complete text report, and a terminal or pipe gets the budgeted text report.

## Example Dialogue

> **Dev:** "Should this Nitro server rule move into Nuxt?"
> **Domain expert:** "Only if the **Rule** depends on Nuxt concepts. If it describes a Nitro runtime contract, it belongs in the Nitro **Rule Pack**, and Nuxt can aggregate it through its **Plugin Surface** or **CLI Surface**."

## Flagged Ambiguities

- "plugin" can mean a Doctor extension, a Vite plugin, or a Nuxt module. Resolved: use **Plugin Surface** for framework/build-tool integrations that run Doctor, **Doctor Extension** for Doctor's internal extension format, and **Rule Pack** for collections of rules.
- "context" can mean runtime context, domain docs, or execution environment. Resolved: use **Runtime Evidence** for code execution facts and `CONTEXT.md` only for project language.
- "diagnostic" and "rule" can be confused because a rule often emits one diagnostic condition. Resolved: use **Rule** for the executable policy and **Diagnostic Code** for the stable emitted condition documented at `/diagnostics/CODE`.
- "incomplete" can mean missing evidence or a report that doesn't show everything. Resolved: an incomplete **Doctor Run** lacks required evidence; what a **Report Budget** leaves out of a **Progressive Report** is hidden.
