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

**Preset**:
A named selection of rules inside a rule pack.
_Avoid_: Group, ruleset

**Recommended Preset**:
The required default preset in every rule pack.
_Avoid_: Default group

**Strict Preset**:
An optional preset that enables all rules in a rule pack, including noisy, migration-oriented, or opinionated rules.
_Avoid_: Full group

**Surface Configuration**:
The options passed to a CLI surface or plugin surface to select rule packs, presets, extensions, and failure behavior for a Doctor run.
_Avoid_: Config file

**Config Extends**:
The surface configuration field that selects rule-pack-qualified presets.
_Avoid_: Preset list

**Activation**:
The conditions that make a rule pack and its default preset apply automatically to a project.
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

**Runtime Evidence**:
Facts that explain where and how code executes across client, server, build, and framework runtimes.
_Avoid_: Context, environment

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
- A **Plugin Surface** receives **Surface Configuration** from its host system.
- **Surface Configuration** can include **Config Extends**.
- A **Rule** produces zero or more **Diagnostics**.
- A **Diagnostic** has one **Diagnostic Code**.
- A **Diagnostic Code** starts with one **Diagnostic Code Prefix**.
- A **Diagnostics Host** defines, registers, and exposes **Diagnostic Codes**.
- A **Rule** can produce more than one **Diagnostic Code** when distinct emitted conditions need distinct documentation or fixes.
- A **Rule** reads **Project Inventory** and **Runtime Evidence**.
- A **Doctor** can be exposed through **CLI Surfaces** and **Plugin Surfaces**.
- A **Plugin Surface** can contribute **Project Inventory** and **Runtime Evidence**.
- The **Vite Plugin Surface** is a **Plugin Surface**.
- The **Nuxt 4 Bridge** is a transitional **Plugin Surface** boundary, not a **Rule Pack**.
- The **Nuxt 4 Bridge** can expose the **Nuxt Doctor Command**.
- A **Rule Catalog** documents **Rule Packs** and **Rules**.
- A **Diagnostic Reference** documents **Diagnostic Codes**.
- An **Agent Consumer** runs Doctor or consumes Doctor reports; it is not a Doctor surface.

## Example Dialogue

> **Dev:** "Should this Nitro server rule move into Nuxt?"
> **Domain expert:** "Only if the **Rule** depends on Nuxt concepts. If it describes a Nitro runtime contract, it belongs in the Nitro **Rule Pack**, and Nuxt can aggregate it through its **Plugin Surface** or **CLI Surface**."

## Flagged Ambiguities

- "plugin" can mean a Doctor extension, a Vite plugin, or a Nuxt module. Resolved: use **Plugin Surface** for framework/build-tool integrations that run Doctor, **Doctor Extension** for Doctor's internal extension format, and **Rule Pack** for collections of rules.
- "context" can mean runtime context, domain docs, or execution environment. Resolved: use **Runtime Evidence** for code execution facts and `CONTEXT.md` only for project language.
- "diagnostic" and "rule" can be confused because a rule often emits one diagnostic condition. Resolved: use **Rule** for the executable policy and **Diagnostic Code** for the stable emitted condition documented at `/diagnostics/CODE`.
