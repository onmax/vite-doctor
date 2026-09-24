import * as v from "valibot";
import type { NuxtDoctorManifest } from "../primitives.js";
import { doctorConfigSchema } from "./config-schema.js";

const stringArray = v.array(v.string());
const sourcePattern = v.object({ source: v.string(), flags: v.string() });

const manifestSchema = v.object({
  generatedAt: v.optional(v.string()),
  nuxtConfigMtimeMs: v.optional(v.number()),
  nuxtVersion: v.optional(v.string()),
  vueVersion: v.optional(v.string()),
  compatibilityVersion: v.optional(v.number()),
  rootDir: v.optional(v.string()),
  srcDir: v.optional(v.string()),
  appDir: v.optional(v.string()),
  buildDir: v.optional(v.string()),
  autoImportEnabled: v.optional(v.boolean()),
  autoImportTransform: v.optional(
    v.object({
      include: v.array(sourcePattern),
      exclude: v.array(sourcePattern),
    }),
  ),
  autoImports: v.optional(v.array(v.unknown())),
  components: v.optional(v.array(v.unknown())),
  layers: v.optional(
    v.array(
      v.object({
        root: v.string(),
        name: v.optional(v.string()),
        priority: v.number(),
      }),
    ),
  ),
  aliases: v.optional(v.record(v.string(), v.string())),
  routeRules: v.optional(v.record(v.string(), v.unknown())),
  serverHandlers: v.optional(
    v.array(
      v.object({
        route: v.optional(v.string()),
        file: v.string(),
        method: v.optional(v.string()),
        middleware: v.optional(v.boolean()),
      }),
    ),
  ),
  pages: v.optional(
    v.array(
      v.object({
        path: v.optional(v.string()),
        file: v.optional(v.string()),
        name: v.optional(v.string()),
      }),
    ),
  ),
  prerenderRoutes: v.optional(stringArray),
  buildManifest: v.optional(
    v.object({
      hasBuildManifest: v.boolean(),
      chunks: v.array(
        v.object({
          file: v.optional(v.string()),
          src: v.optional(v.string()),
          isEntry: v.optional(v.boolean()),
          isDynamicEntry: v.optional(v.boolean()),
        }),
      ),
    }),
  ),
  modules: v.optional(
    v.array(
      v.object({
        name: v.string(),
        version: v.optional(v.string()),
        doctorPlugin: v.optional(v.string()),
      }),
    ),
  ),
  moduleSources: v.optional(
    v.array(
      v.object({
        module: v.string(),
        root: v.string(),
        packageDir: v.optional(v.string()),
        include: v.optional(stringArray),
        exclude: v.optional(stringArray),
        runtimeDirs: v.optional(stringArray),
        appDirs: v.optional(stringArray),
      }),
    ),
  ),
  doctorConfig: v.optional(doctorConfigSchema),
  runtimeConfig: v.optional(v.unknown()),
  keyedComposables: v.optional(v.array(v.unknown())),
  importsDirs: v.optional(stringArray),
  pluginFiles: v.optional(stringArray),
  appScanRoots: v.optional(stringArray),
  sharedScanRoots: v.optional(stringArray),
});

export function parseNuxtManifest(value: unknown): Partial<NuxtDoctorManifest> {
  return v.parse(manifestSchema, value);
}
