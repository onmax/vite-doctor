import { resolve } from "pathe";
import { createReport, defineDoctorExtension } from "@vue-doctor/core";
import type { DoctorExtension, DoctorRunOptions } from "@vue-doctor/core";
import type { Plugin, ResolvedConfig } from "vite";
import { runViteDoctor, shouldFailDoctorRun } from "./doctor.js";

export interface ViteDoctorSurfaceOptions {
  enabled?: boolean;
  run?: "build" | "serve" | "both";
  mode?: "warn" | "error";
  root?: string;
  framework?: "auto" | "vite" | "vue" | "nuxt";
  extends?: DoctorRunOptions["extends"];
  extensions?: DoctorExtension[];
  rules?: string;
  severity?: "error" | "warn" | "info";
  maxWarnings?: number;
  cache?: boolean;
  format?: "text" | "json" | "sarif";
}

export function doctor(options: ViteDoctorSurfaceOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  let ran = false;

  return {
    name: "vite-doctor",
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      if (options.enabled === false || ran) return;
      const resolved = config;
      if (!resolved || !shouldRun(options.run ?? "build", resolved.command)) return;
      ran = true;

      const result = await runViteDoctor({
        root: options.root ? resolve(resolved.root, options.root) : resolved.root,
        framework: options.framework ?? "auto",
        extends: options.extends,
        extensions: [viteSurfaceExtension(resolved), ...(options.extensions ?? [])],
        rules: options.rules,
        severity: options.severity,
        maxWarnings: options.maxWarnings,
        cache: options.cache ?? true,
        format: options.format,
      });

      const report = createReport(result, options.format ?? "text").trimEnd();
      const shouldFail = shouldFailDoctorRun(result, options.maxWarnings);

      if (shouldFail && (options.mode ?? "error") === "error") {
        this.error(report || "Vite Doctor checks failed.");
        return;
      }

      if (report) {
        if (shouldFail || result.diagnostics.length > 0) resolved.logger.warn(report);
        else resolved.logger.info(report);
      }
    },
  };
}

function viteSurfaceExtension(config: ResolvedConfig): DoctorExtension {
  return defineDoctorExtension({
    name: "vite-doctor/surface-vite",
    setup(api) {
      api.registerProjectInventoryContributor({
        name: "vite",
        contribute() {
          return {
            root: config.root,
            command: config.command,
            mode: config.mode,
            base: config.base,
            publicDir: config.publicDir,
            envDir: config.envDir,
            plugins: config.plugins?.map((plugin) => plugin.name).filter(Boolean) ?? [],
          };
        },
      });
      api.registerRuntimeEvidenceContributor({
        name: "vite",
        contribute() {
          return {
            buildSsr: Boolean(config.build?.ssr),
            ssrExternal: config.ssr?.external ?? [],
            ssrNoExternal: config.ssr?.noExternal ?? [],
          };
        },
      });
    },
  });
}

function shouldRun(run: NonNullable<ViteDoctorSurfaceOptions["run"]>, command: "build" | "serve") {
  if (run === "both") return true;
  return run === command;
}
