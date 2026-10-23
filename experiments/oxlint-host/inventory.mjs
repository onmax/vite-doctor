import { relative } from "node:path";
import { loadDoctorApi } from "./doctor-api.mjs";
import { portedRules } from "./rule-map.mjs";

/**
 * Runs Doctor once with a capture Rule to record the Project Inventory each file's Rules see,
 * then reduces it to the JSON-only shape oxlint `settings` can carry.
 *
 * Returns `{ settings, files, activeRules, inventoryMs }`:
 * - `settings.doctor.projects`: per-project facts the ported Rules read.
 * - `files`: absolute paths Doctor handed to file Rules (the parity scope).
 * - `activeRules`: Doctor Rule IDs that actually ran on at least one file.
 */
export async function captureInventory(root, { doctorRoot, framework = "auto" } = {}) {
  const { runViteDoctor, createRule, defineDoctorExtension, defineRulePack } =
    await loadDoctorApi(doctorRoot);
  const projects = new Map();
  const files = new Set();
  const capture = createRule({
    meta: {
      id: "experiment/capture-inventory",
      title: "Capture Project Inventory for the oxlint host experiment",
      category: "experiment",
      severity: "info",
      requires: { script: true },
    },
    create(ctx) {
      files.add(ctx.file.path);
      const project = ctx.project;
      if (!projects.has(project.root)) projects.set(project.root, serializableProject(project));
      const entry = projects.get(project.root);
      if (ctx.file.relativePath !== relative(project.root, ctx.file.path).replaceAll("\\", "/"))
        entry.relativePathMismatches++;
    },
  });
  const started = performance.now();
  const result = await runViteDoctor({
    root,
    framework,
    cache: false,
    profile: true,
    rules: [capture.meta.id, ...portedRules.map((rule) => rule.doctor)].join(","),
    extensions: [
      defineDoctorExtension({
        name: "experiment/oxlint-host",
        rulePacks: [
          defineRulePack({
            name: "experiment",
            version: "0.0.0",
            rules: [capture],
            presets: { recommended: [capture.meta.id] },
          }),
        ],
      }),
    ],
  });
  const inventoryMs = Math.round(performance.now() - started);
  const activeRules = (result.ruleTimings ?? [])
    .filter((timing) => timing.files > 0 && timing.rule !== capture.meta.id)
    .map((timing) => timing.rule);
  return {
    settings: { doctor: { projects: [...projects.values()] } },
    files: [...files].sort((a, b) => a.localeCompare(b)),
    activeRules,
    inventoryMs,
    projectPhaseMs: result.timings?.project ?? null,
  };
}

/** Everything here must survive JSON: oxlint settings are deserialized from JSON on the JS side. */
function serializableProject(project) {
  const vite = project.inventory?.vite;
  return {
    root: project.root,
    framework: project.framework,
    nuxtAppDir: project.nuxt?.appDir ?? null,
    hasNuxt: Boolean(project.nuxt),
    vite: vite
      ? {
          publicDir: vite.publicDir ?? null,
          aliases: serializeAliases(vite.aliases),
        }
      : null,
    relativePathMismatches: 0,
  };
}

function serializeAliases(aliases) {
  if (Array.isArray(aliases))
    return aliases.map((alias) => {
      const find = typeof alias === "string" ? alias : alias?.find;
      if (find instanceof RegExp) return { regexp: { source: find.source, flags: find.flags } };
      return { find: typeof find === "string" ? find : null };
    });
  if (aliases && typeof aliases === "object") return Object.keys(aliases).map((find) => ({ find }));
  return null;
}
