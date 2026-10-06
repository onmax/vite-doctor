import { dirname, relative, resolve } from "node:path";
import { projectFor, reportDoctor } from "./shared.mjs";

const CODE = "VITE0002";

/** Port of `vite/assets/no-public-src-import`. Reads `publicDir`, root and Nuxt `appDir` from settings. */
export const noPublicSrcImport = {
  meta: { type: "problem", docs: { url: "https://vite-doctor.onmax.me/diagnostics/VITE0002" } },
  create(context) {
    const project = projectFor(context);
    if (!project) return {};
    return {
      ImportDeclaration(node) {
        const source = String(node.source?.value ?? "");
        if (!isPublicImport(context.filename, project, source)) return;
        reportDoctor(
          context,
          node,
          CODE,
          `Public media and font assets should be referenced by URL, not imported: ${source}`,
        );
      },
    };
  },
};

function isPublicImport(filename, project, source) {
  const publicDir = project.vite?.publicDir;
  if (publicDir === false || publicDir === "") return false;
  const path = source.split(/[?#]/)[0];
  if (/\.(?:json|json5)(?:\?.*)?$/i.test(path)) return false;
  let target;
  if (path.startsWith("./") || path.startsWith("../")) target = resolve(dirname(filename), path);
  else if (path.startsWith("/") && !path.startsWith("//"))
    target = resolve(project.root, `.${path}`);
  else if (project.hasNuxt) {
    if (path.startsWith("~~/") || path.startsWith("@@/"))
      target = resolve(project.root, path.slice(3));
    else if (path.startsWith("~/") || path.startsWith("@/"))
      target = resolve(project.nuxtAppDir, path.slice(2));
  }
  if (!target) return false;
  const publicPath = relative(
    resolve(project.root, typeof publicDir === "string" ? publicDir : "public"),
    target,
  );
  return publicPath !== ".." && !publicPath.startsWith("../") && !publicPath.startsWith("/");
}
