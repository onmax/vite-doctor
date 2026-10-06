import { relative } from "node:path";
import { getCalleeName, isVueFile, projectFor, relativePath, reportDoctor } from "./shared.mjs";

const CODE = "NUXT0026";
const WHY =
  "This fetch runs in setup for SSR-rendered data. Use useFetch() or useAsyncData() to avoid duplicate fetching and hydration issues.";
const RAW_FETCH = new Set(["$fetch", "fetch", "axios.get"]);
const APP_SURFACES = ["pages", "components", "layouts"];

/** Port of `nuxt/fetch/no-raw-fetch-in-setup`. The Nuxt `appDir` comes from Project Inventory. */
export const noRawFetchInSetup = {
  meta: { type: "suggestion", docs: { url: "https://vite-doctor.onmax.me/diagnostics/NUXT0026" } },
  create(context) {
    const project = projectFor(context);
    if (!project || !isVueFile(context)) return {};
    const appDir = project.nuxtAppDir ? relative(project.root, project.nuxtAppDir) : "app";
    const path = relativePath(context, project);
    if (!APP_SURFACES.some((dir) => path.startsWith(`${appDir}/${dir}/`))) return {};
    return {
      AwaitExpression(node) {
        if (RAW_FETCH.has(getCalleeName(node.argument)))
          reportDoctor(context, node.argument, CODE, WHY);
      },
    };
  },
};
