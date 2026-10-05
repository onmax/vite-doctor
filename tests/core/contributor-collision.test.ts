import { expect, test } from "vite-plus/test";
import { defineDoctorExtension, runDoctor } from "../../src/core/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "pathe";
import { tmpdir } from "node:os";

test.each(["inventory", "runtimeEvidence"] as const)(
  "preserves registered %s identities when contributors mutate names",
  async (namespace) => {
    const root = await mkdtemp(join(tmpdir(), "doctor-contributor-mutation-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      const later = {
        name: "later",
        contribute() {
          this.name = "first";
          return { from: "later" };
        },
      };
      const first = {
        name: "first",
        contribute() {
          later.name = "first";
          return { from: "first" };
        },
      };
      const result = await runDoctor({
        root,
        framework: "vue",
        cache: false,
        extensions: [
          defineDoctorExtension({
            name: "mutable-contributors",
            setup(api) {
              if (namespace === "inventory") {
                api.registerProjectInventoryContributor(first);
                api.registerProjectInventoryContributor(later);
              } else {
                api.registerRuntimeEvidenceContributor(first);
                api.registerRuntimeEvidenceContributor(later);
              }
            },
          }),
        ],
      });
      expect(result.project[namespace]).toMatchObject({
        first: { from: "first" },
        later: { from: "later" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("rejects duplicate contributor names within each evidence namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-contributor-collision-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/index.ts"), "export const ok = true;\n");
    const duplicateInventory = defineDoctorExtension({
      name: "inventory-collision",
      setup(api) {
        api.registerProjectInventoryContributor({
          name: "same",
          contribute: () => ({ from: "a" }),
        });
        api.registerProjectInventoryContributor({
          name: "same",
          contribute: () => ({ from: "b" }),
        });
      },
    });
    await expect(
      runDoctor({ root, framework: "vue", cache: false, extensions: [duplicateInventory] }),
    ).rejects.toMatchObject({ name: "DOC0026", code: "DOC0026" });

    const duplicateRuntimeEvidence = defineDoctorExtension({
      name: "runtime-collision",
      setup(api) {
        api.registerRuntimeEvidenceContributor({ name: "same", contribute: () => ({ from: "a" }) });
        api.registerRuntimeEvidenceContributor({ name: "same", contribute: () => ({ from: "b" }) });
      },
    });
    await expect(
      runDoctor({ root, framework: "vue", cache: false, extensions: [duplicateRuntimeEvidence] }),
    ).rejects.toMatchObject({ name: "DOC0026", code: "DOC0026" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows the same contributor name in separate evidence namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-contributor-collision-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", dependencies: { vue: "^3.5.0" } }),
    );
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/index.ts"), "export const ok = true;\n");
    const result = await runDoctor({
      root,
      framework: "vue",
      cache: false,
      extensions: [
        defineDoctorExtension({
          name: "shared-name",
          setup(api) {
            api.registerProjectInventoryContributor({
              name: "same",
              contribute: () => ({ inventory: true }),
            });
            api.registerRuntimeEvidenceContributor({
              name: "same",
              contribute: () => ({ runtime: true }),
            });
          },
        }),
      ],
    });
    expect(result.project.inventory?.same).toEqual({ inventory: true });
    expect(result.project.runtimeEvidence?.same).toEqual({ runtime: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
