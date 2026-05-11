import type { FileSystemTree } from "@webcontainer/api";

type TreeFile = { contents: string | Uint8Array };
type TreeNode = { file: TreeFile } | { directory: FileSystemTree };

export interface FixtureEntry {
  contents: string;
  encoding?: "base64";
}

export function fixtureToTree(fixtureMap: Record<string, FixtureEntry>): FileSystemTree {
  const tree: FileSystemTree = {};
  for (const [absPath, entry] of Object.entries(fixtureMap)) {
    const path = absPath.replace(/^\/+/, "");
    if (!path) continue;
    insertTreeFile(tree, path, decodeFixtureEntry(entry));
  }
  return tree;
}

export function mergeFileSystemTrees(...trees: FileSystemTree[]): FileSystemTree {
  const merged: FileSystemTree = {};
  for (const tree of trees) mergeTreeInto(merged, tree);
  return merged;
}

export function mergeRuntimeTree(
  targetTree: FileSystemTree,
  runtimeTree: FileSystemTree,
): FileSystemTree {
  const targetPackageJson = targetTree["package.json"];
  const merged = mergeFileSystemTrees(targetTree, runtimeTree);
  if (targetPackageJson && "file" in targetPackageJson)
    merged["package.json"] = { file: targetPackageJson.file as TreeFile };
  return merged;
}

function decodeFixtureEntry(entry: FixtureEntry): string | Uint8Array {
  if (entry.encoding !== "base64") return entry.contents;
  const binary = atob(entry.contents);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function insertTreeFile(tree: FileSystemTree, path: string, contents: string | Uint8Array) {
  const parts = path.split("/");
  let node = tree;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    const existing = node[part];
    if (!existing || !("directory" in existing)) node[part] = { directory: {} };
    node = (node[part]! as { directory: FileSystemTree }).directory;
  }
  node[parts[parts.length - 1]!] = { file: { contents } };
}

function mergeTreeInto(target: FileSystemTree, source: FileSystemTree) {
  for (const [name, sourceNode] of Object.entries(source) as [string, TreeNode][]) {
    if ("file" in sourceNode) {
      target[name] = { file: sourceNode.file };
      continue;
    }

    const existing = target[name];
    if (!existing || !("directory" in existing)) target[name] = { directory: {} };
    mergeTreeInto((target[name]! as { directory: FileSystemTree }).directory, sourceNode.directory);
  }
}
