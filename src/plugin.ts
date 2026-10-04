import { resolve } from "pathe";
import { createReport, defineDoctorExtension, reportStatus } from "./core/index.js";
import type { DoctorConfig, DoctorExtension, DoctorRunOptions } from "./core/index.js";
import type { Plugin, ResolvedConfig } from "vite";
import { runViteDoctor, shouldFailDoctorRun } from "./doctor.js";

export interface ViteDoctorSurfaceOptions {
  enabled?: boolean;
  run?: "build" | "serve" | "both";
  mode?: "warn" | "error";
  root?: string;
  framework?: "auto" | "vite" | "vue" | "nitro" | "nuxt";
  config?: DoctorConfig;
  extends?: DoctorRunOptions["extends"];
  extensions?: DoctorExtension[];
  rules?: string;
  severity?: "error" | "warn" | "info";
  maxWarnings?: number;
  cache?: boolean;
  format?: DoctorRunOptions["format"];
}

export function doctor(options: ViteDoctorSurfaceOptions = {}): Plugin {
  let config: ResolvedConfig | undefined;
  let ran = false;

  return {
    name: "vite-doctor",
    configResolved(resolved) {
      config = resolved;
      ran = false;
    },
    async buildStart() {
      if (options.enabled === false || ran) return;
      const resolved = config;
      if (!resolved || !shouldRun(options.run ?? "build", resolved.command)) return;
      ran = true;

      const result = await runViteDoctor({
        root: options.root ? resolve(resolved.root, options.root) : resolved.root,
        framework: options.framework ?? "auto",
        config: options.config,
        extends: options.extends,
        extensions: [viteSurfaceExtension(resolved), ...(options.extensions ?? [])],
        rules: options.rules,
        severity: options.severity,
        maxWarnings: options.maxWarnings,
        cache: options.cache ?? true,
        format: options.format,
      });

      const report = createReport(result, options.format).trimEnd();
      const incomplete = reportStatus(result) === "incomplete";
      const shouldFail = incomplete || shouldFailDoctorRun(result, options.maxWarnings);

      if (shouldFail && (options.mode ?? "error") === "error") {
        this.error(report || "Vite Doctor checks failed.");
        return;
      }

      if (report) {
        if (
          shouldFail ||
          result.summary.blocker > 0 ||
          result.summary.error > 0 ||
          result.summary.warn > 0
        ) {
          resolved.logger.warn(report);
        } else resolved.logger.info(report);
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
            aliases: config.resolve?.alias ?? [],
            plugins: config.plugins?.map((plugin) => plugin.name).filter(Boolean) ?? [],
          };
        },
      });
      api.registerRuntimeEvidenceContributor({
        name: "vite",
        contribute() {
          const prefixes = config.envPrefix ?? "VITE_";
          const environments = Object.values(config.environments ?? {});
          const hasResolvedConsumers = environments.every(
            ({ consumer }) => consumer === "client" || consumer === "server",
          );
          const defineKeys = [
            ...new Set([
              ...Object.keys(config.define ?? {}),
              ...environments
                .filter(({ consumer }) => consumer === "client")
                .flatMap((environment) => Object.keys(environment.define ?? {})),
            ]),
          ];
          return {
            buildSsr: Boolean(config.build?.ssr),
            ssrExternal: config.ssr?.external ?? [],
            ssrNoExternal: config.ssr?.noExternal ?? [],
            envExposure: hasResolvedConsumers
              ? {
                  root: config.root,
                  prefixes: typeof prefixes === "string" ? [prefixes] : [...prefixes],
                  defineKeys: defineKeys
                    .filter((key) => key.startsWith("import.meta.env."))
                    .map((key) => key.slice("import.meta.env.".length)),
                  hasObjectDefine:
                    defineKeys.includes("import.meta.env") || defineKeys.includes("import.meta"),
                }
              : undefined,
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
