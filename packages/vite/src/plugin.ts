import { resolve } from "pathe";
import { createReport } from "@vue-doctor/core";
import type { Plugin, ResolvedConfig } from "vite";
import { runViteDoctor, shouldFailDoctorRun } from "./doctor.js";

export interface ViteDoctorPluginOptions {
  enabled?: boolean;
  run?: "build" | "serve" | "both";
  mode?: "warn" | "error";
  root?: string;
  framework?: "auto" | "vite" | "vue" | "nuxt";
  rules?: string;
  preset?: string;
  severity?: "error" | "warn" | "info";
  maxWarnings?: number;
  config?: boolean;
  cache?: boolean;
  format?: "text" | "json" | "sarif";
}

export function doctor(options: ViteDoctorPluginOptions = {}): Plugin {
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
        rules: options.rules,
        preset: options.preset,
        severity: options.severity,
        maxWarnings: options.maxWarnings,
        config: options.config ?? false,
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

function shouldRun(run: NonNullable<ViteDoctorPluginOptions["run"]>, command: "build" | "serve") {
  if (run === "both") return true;
  return run === command;
}
