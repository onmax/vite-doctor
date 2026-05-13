import { resolve } from "pathe";
import { createReport, runDoctor, type DoctorRunOptions } from "@vue-doctor/core";
import type { Plugin, ResolvedConfig } from "vite";
import { viteDoctorPlugins } from "./rules.js";

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

      const result = await runDoctor({
        root: options.root ? resolve(resolved.root, options.root) : resolved.root,
        framework: options.framework ?? "auto",
        rules: options.rules,
        preset: options.preset,
        severity: options.severity,
        maxWarnings: options.maxWarnings,
        config: options.config ?? false,
        cache: options.cache ?? true,
        format: options.format,
        plugins: viteDoctorPlugins(),
      } satisfies DoctorRunOptions);

      const report = createReport(result, options.format ?? "text").trimEnd();
      const shouldFail =
        result.summary.blocker > 0 ||
        result.summary.error > 0 ||
        (options.maxWarnings !== undefined && result.summary.warn > options.maxWarnings);

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
