import { expect, test } from "vite-plus/test";
import { createAgentReport } from "../../../src/core/reports.ts";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  createNuxtAuthorizationReviewExtension,
  createOpenAICompatibleAuthorizationReviewer,
  type AuthorizationReviewer,
  type AuthorizationReviewResult,
} from "../../../src/rule-packs/nuxt/review/authorization.ts";

const files = {
  "app/middleware/auth.ts": `export default defineNuxtRouteMiddleware(() => navigateTo('/login'))`,
  "server/api/account.get.ts": `export default defineEventHandler(() => ({ private: true }))`,
};

async function runReview(reviewer: AuthorizationReviewer) {
  const extension = createNuxtAuthorizationReviewExtension(reviewer);
  return runProjectFixture({
    framework: "nuxt",
    files,
    rules: extension.rulePacks![0]!.rules,
  });
}

test("opt-in authorization review reports cited server gaps", async () => {
  const result = await runReview(async (candidate) => ({
    status: "report",
    reason: "The handler returns private data without a server guard.",
    citations: [
      { path: candidate.handler.path, line: 1 },
      { path: candidate.sources[0]!.path, line: 1 },
    ],
  }));

  expect(result.diagnostics.map((item) => item.code)).toContain("NUXT0074");
  expect(result.diagnostics.find((item) => item.code === "NUXT0074")?.related).toHaveLength(1);
  expect(result.diagnostics.find((item) => item.code === "NUXT0074")?.range).toEqual({
    start: 0,
    end: files["server/api/account.get.ts"].length,
    line: 1,
    column: 1,
  });
});

test.each([
  "rejection",
  undefined,
  null,
  { status: "unknown" },
  { status: "report", reason: "Missing citations" },
  { status: "report", reason: "Malformed citation", citations: [null] },
  { status: "unknown", reason: "Invalid flag", citations: [], incomplete: "true" },
])(
  "reviewer failure %j preserves diagnostics and continues with incomplete evidence",
  async (failure) => {
    const reviewed: string[] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      reviewed.push(candidate.handler.path);
      if (candidate.handler.path === "server/api/profile.get.ts") {
        if (failure === "rejection") throw new Error("Provider unavailable");
        return failure as unknown as AuthorizationReviewResult;
      }
      return {
        status: "report",
        reason: "The handler has no server guard.",
        citations: [
          { path: candidate.handler.path, line: 1 },
          { path: candidate.sources[0]!.path, line: 1 },
        ],
      };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/profile.get.ts": files["server/api/account.get.ts"],
        "server/api/settings.get.ts": files["server/api/account.get.ts"],
      },
      rules: extension.rulePacks![0]!.rules,
    });

    expect(reviewed).toHaveLength(3);
    expect(result.diagnostics.filter((item) => item.code === "NUXT0074")).toHaveLength(2);
    expect(result.project.evidenceGaps).toContainEqual({
      source: "vite-doctor/nuxt-authorization-review",
      message:
        "Authorization review failed for server/api/profile.get.ts; the handler was not reviewed.",
      files: ["server/api/profile.get.ts"],
    });
    expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  },
);

test("unknown reviews and fabricated citations produce no diagnostic", async () => {
  const unknown = await runReview(async () => ({
    status: "unknown",
    reason: "The guard implementation is outside the supplied evidence.",
    citations: [],
  }));
  const fabricated = await runReview(async (candidate) => ({
    status: "report",
    reason: "Unverified claim.",
    citations: [
      { path: candidate.handler.path, line: 1 },
      { path: "server/middleware/missing.ts", line: 1 },
    ],
  }));

  expect(unknown.diagnostics.some((item) => item.code === "NUXT0074")).toBe(false);
  expect(fabricated.diagnostics.some((item) => item.code === "NUXT0074")).toBe(false);
});

test.each([
  ["server/api/account.get.ts", false],
  ["server/routes/private.get.ts", false],
  ["server/handlers/entry.ts", true],
])("omitted sensitive handler makes evidence incomplete: %s", async (path, registered) => {
  const reviewed: string[] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    reviewed.push(candidate.handler.path);
    return { status: "suppress", reason: "Guard", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      [path]: "x".repeat(16_001),
      "server/api/profile.get.ts": files["server/api/account.get.ts"],
      "server/api/public.get.ts": "x".repeat(16_001),
      ...(registered
        ? {
            ".nuxt/doctor.manifest.json": JSON.stringify({
              generatedAt: "2100-01-01T00:00:00.000Z",
              resolvedServerHandlers: [
                { file: path, route: "/api/account" },
                { file: "server/api/profile.get.ts", route: "/api/profile" },
              ],
            }),
          }
        : {}),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(reviewed).not.toContain(path);
  expect(reviewed).toContain("server/api/profile.get.ts");
  expect(result.project.evidenceGaps).toContainEqual(
    expect.objectContaining({
      source: "vite-doctor/nuxt-authorization-review",
      files: [path],
    }),
  );
  expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
});

test("OpenAI-compatible reviewer accepts structured JSON", async () => {
  const reviewer = createOpenAICompatibleAuthorizationReviewer({
    endpoint: "https://example.test/v1/chat/completions",
    model: "review-model",
    apiKey: "test-key",
    fetcher: async (_url, init) => {
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "unknown",
                  reason: "Need more evidence",
                  citations: [],
                }),
              },
            },
          ],
        }),
      );
    },
  });
  const result = await reviewer({
    handler: { path: "server/api/account.ts", text: "" },
    sources: [],
  });
  expect(result.status).toBe("unknown");
});

test.each(["~/server/guard", "@/server/guard", "#guards/guard", "../guard"])(
  "collects guard evidence imported through %s",
  async (specifier) => {
    const candidates: Parameters<AuthorizationReviewer>[0][] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      candidates.push(candidate);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/account.get.ts": `import guard from '${specifier}'; export default defineEventHandler(guard)`,
        "server/guard.ts": "export default () => ({ private: true })",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
          appDir: "app",
          generatedAt: "2100-01-01T00:00:00.000Z",
          aliases: { "~": ".", "@": ".", "#guards": "server" },
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sources.map((source) => source.path)).toContain("server/guard.ts");
  },
);

test("reviews registered sensitive handlers using middleware from a layer", async () => {
  const paths: string[] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    paths.push(candidate.handler.path);
    return {
      status: "report",
      reason: "Missing server guard",
      citations: [
        { path: candidate.handler.path, line: 1 },
        { path: "layers/admin/app/middleware/auth.ts", line: 1 },
      ],
    };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      "layers/admin/app/middleware/auth.ts": files["app/middleware/auth.ts"],
      "server/handlers/entry.ts": "export default defineEventHandler(() => ({}))",
      "server/handlers/account.ts": "export default defineEventHandler(() => ({}))",
      "server/handlers/auth.ts": "export default defineEventHandler(() => ({}))",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        appDir: "app",
        layers: [{ root: "layers/admin", srcDir: "layers/admin/app", priority: 0 }],
        resolvedServerHandlers: [
          { file: "server/handlers/entry.ts", route: "/api/account" },
          { file: "server/handlers/entry.ts", route: "/api/profile" },
          { file: "server/handlers/account.ts", route: "/api/data" },
          { file: "server/handlers/auth.ts", middleware: true },
          { file: "server/handlers/missing.ts", route: "/api/account" },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(paths.sort()).toEqual(["server/handlers/entry.ts"]);
  expect(result.project.evidenceGaps).toContainEqual(
    expect.objectContaining({
      source: "vite-doctor/nuxt-authorization-review",
      files: ["server/handlers/missing.ts"],
    }),
  );
  expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  expect(result.diagnostics.filter((item) => item.code === "NUXT0074")).toHaveLength(1);
});

test.each(["界".repeat(40_000), "x".repeat(119_700), '"'.repeat(40_000)])(
  "skips oversized encoded requests without failing the review",
  async (text) => {
    let called = false;
    const reviewer = createOpenAICompatibleAuthorizationReviewer({
      endpoint: "https://example.test/v1/chat/completions",
      model: "review-model",
      apiKey: "test-key",
      fetcher: async () => {
        called = true;
        throw new Error("Oversized request sent");
      },
    });
    const result = await reviewer({
      handler: { path: "server/api/account.ts", text },
      sources: [],
    });
    expect(result.status).toBe("unknown");
    expect(result.incomplete).toBe(true);
    expect(called).toBe(false);
  },
);

test.each([true, false])(
  "collects resolved registered middleware only with a current manifest: %s",
  async (current) => {
    const candidates: Parameters<AuthorizationReviewer>[0][] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      candidates.push(candidate);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/handlers/entry.ts": "export default defineEventHandler(() => ({}))",
        "server/guards/global.ts": "export default defineEventHandler(requireUserSession)",
        "nuxt.config.ts": "export default defineNuxtConfig({})",
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: current ? "2100-01-01T00:00:00Z" : "2000-01-01T00:00:00Z",
          resolvedServerHandlers: [
            { file: "server/api/account.get.ts", route: "/api/account" },
            { file: "server/handlers/entry.ts", route: "/api/account" },
            { file: "server/guards/global.ts", middleware: true },
          ],
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(candidates.map((candidate) => candidate.handler.path)).toEqual(
      current ? ["server/api/account.get.ts", "server/handlers/entry.ts"] : [],
    );
    expect(
      candidates.some((candidate) =>
        candidate.sources.some((source) => source.path === "server/guards/global.ts"),
      ),
    ).toBe(current);
  },
);

test.each(
  ["ts", "js", "mts", "mjs", "cts", "cjs"].flatMap((extension) => [
    `guard.${extension}`,
    `guard/index.${extension}`,
  ]),
)("collects extensionless guard evidence from %s", async (guard) => {
  const candidates: Parameters<AuthorizationReviewer>[0][] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    candidates.push(candidate);
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts":
        "import guard from '../guard'; export default defineEventHandler(guard)",
      [`server/${guard}`]: "export default () => ({ private: true })",
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(candidates[0]!.sources.map((source) => source.path)).toContain(`server/${guard}`);
});

test.each(
  ["~", "@", "~~", "@@"].flatMap((alias) => [
    { alias, local: true },
    { alias, local: false },
    { alias, local: undefined },
  ]),
)("resolves layer aliases: $alias, local=$local", async ({ alias, local }) => {
  const candidates: Parameters<AuthorizationReviewer>[0][] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    candidates.push(candidate);
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  const layerGuard = `layers/admin/${alias.length === 1 ? "src/" : ""}guard.ts`;
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": files["app/middleware/auth.ts"],
      "layers/admin/server/api/account.ts": `import guard from '${alias}/guard'; export default defineEventHandler(guard)`,
      [layerGuard]: "export default () => ({ private: true })",
      "guard.ts": "export default () => ({ unrelated: true })",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        generatedAt: "2100-01-01T00:00:00.000Z",
        localLayerAliases: local,
        layers: [{ root: "layers/admin", srcDir: "layers/admin/src", priority: 0 }],
        aliases: { "~": ".", "@": ".", "~~": ".", "@@": "." },
        resolvedServerHandlers: [
          { file: "layers/admin/server/api/account.ts", route: "/api/account" },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  if (local === undefined) {
    expect(candidates).toHaveLength(0);
    expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
    expect(result.project.evidenceGaps).toContainEqual(
      expect.objectContaining({
        source: "vite-doctor/nuxt-authorization-review",
        files: [`${alias}/guard`],
      }),
    );
    return;
  }
  expect(candidates).toHaveLength(1);
  const paths = candidates[0]!.sources.map((source) => source.path);
  expect(paths).toContain(local ? layerGuard : "guard.ts");
  expect(paths).not.toContain(local ? "guard.ts" : layerGuard);
});

test.each([
  ["https://example.test/v1", true],
  ["http://localhost:8080/v1", true],
  ["http://127.0.0.1:8080/v1", true],
  ["http://[::1]:8080/v1", true],
  ["http://example.test/v1", false],
  ["http://localhost.example.test/v1", false],
  ["ftp://localhost/v1", false],
] as const)("validates provider transport for %s", (endpoint, allowed) => {
  const create = () =>
    createOpenAICompatibleAuthorizationReviewer({ endpoint, model: "model", apiKey: "key" });
  if (allowed) expect(create).not.toThrow();
  else expect(create).toThrow("HTTPS or loopback HTTP");
});

test.each([
  [true, "layers/admin/src", "middleware"],
  [false, "layers/admin/src", "middleware"],
  [true, "layers/admin", "middleware"],
  [true, "layers/admin", "app/middleware"],
  [true, "layers/admin/src", "app/middleware"],
  [false, "layers/admin", "middleware"],
  [false, "layers/admin", "app/middleware"],
  [false, "layers/admin/src", "app/middleware"],
] as const)(
  "layer middleware requires a current manifest: %s, %s, %s",
  async (current, srcDir, middlewareDir) => {
    const candidates: Parameters<AuthorizationReviewer>[0][] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      candidates.push(candidate);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        "nuxt.config.ts": "export default defineNuxtConfig({})",
        [`${srcDir}/${middlewareDir}/auth.ts`]: files["app/middleware/auth.ts"],
        "server/api/account.get.ts": files["server/api/account.get.ts"],
        ".nuxt/doctor.manifest.json": JSON.stringify({
          resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
          generatedAt: current ? "2100-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z",
          layers: [
            {
              root: "layers/admin",
              srcDir,
              appMiddlewareDir: `${srcDir}/${middlewareDir}`,
              priority: 0,
            },
          ],
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(candidates).toHaveLength(current ? 1 : 0);
    if (current)
      expect(candidates[0]!.sources.map((source) => source.path)).toContain(
        `${srcDir}/${middlewareDir}/auth.ts`,
      );
  },
);

test.each([false, true])(
  "server middleware must fit the evidence limit: oversized=%s",
  async (oversized) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      calls++;
      return {
        status: "report",
        reason: "No guard visible",
        citations: [
          { path: candidate.handler.path, line: 1 },
          { path: "app/middleware/auth.ts", line: 1 },
        ],
      };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/middleware/auth.ts":
          "export default defineEventHandler(event => requireAuth(event))" +
          (oversized ? " ".repeat(16_001) : ""),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(result.project.evidenceGaps ?? []).toEqual(
      oversized
        ? [
            expect.objectContaining({
              source: "vite-doctor/nuxt-authorization-review",
              files: ["server/middleware/auth.ts"],
            }),
          ]
        : [],
    );
    if (oversized) expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
    expect(calls).toBe(oversized ? 0 : 1);
    expect(result.diagnostics.filter((item) => item.code === "NUXT0074")).toHaveLength(
      oversized ? 0 : 1,
    );
  },
);

test.each([true, false])("manifest aliases require current evidence: %s", async (current) => {
  const candidates: Parameters<AuthorizationReviewer>[0][] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    candidates.push(candidate);
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      "server/api/account.get.ts":
        "import guard from '#guards/guard'; export default defineEventHandler(guard)",
      "server/old/guard.ts": "export default () => ({ private: true })",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: current ? "2100-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z",
        aliases: { "#guards": "server/old" },
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(candidates).toHaveLength(current ? 1 : 0);
  if (current)
    expect(candidates[0]!.sources.some((source) => source.path === "server/old/guard.ts")).toBe(
      true,
    );
});

test.each([false, true])(
  "omitted app middleware makes evidence incomplete: other middleware=%s",
  async (otherMiddleware) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async () => {
      calls++;
      return { status: "suppress", reason: "Guard", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "app/middleware/auth.ts": files["app/middleware/auth.ts"] + " ".repeat(16_001),
        ...(otherMiddleware ? { "app/middleware/admin.ts": files["app/middleware/auth.ts"] } : {}),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(0);
    expect(result.project.evidenceGaps).toContainEqual(
      expect.objectContaining({
        source: "vite-doctor/nuxt-authorization-review",
        files: ["app/middleware/auth.ts"],
      }),
    );
    expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  },
);

test.each([
  ["layers/admin", "middleware"],
  ["layers/admin/app", "middleware"],
  ["layers/admin/src", "middleware"],
  ["layers/admin/src", "app/middleware"],
  ["layers/admin/src", "guards"],
])("collects only resolved layer middleware: %s/%s", async (srcDir, middlewareDir) => {
  const candidates: Parameters<AuthorizationReviewer>[0][] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    candidates.push(candidate);
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  const activePath = `${srcDir}/${middlewareDir}/auth.ts`;
  const inactivePath = `${srcDir}/${middlewareDir === "middleware" ? "app/middleware" : "middleware"}/private.ts`;
  await runProjectFixture({
    framework: "nuxt",
    files: {
      "server/api/account.get.ts": files["server/api/account.get.ts"],
      [activePath]: files["app/middleware/auth.ts"],
      [inactivePath]: files["app/middleware/auth.ts"],
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [
          {
            root: "layers/admin",
            srcDir,
            appMiddlewareDir: `${srcDir}/${middlewareDir}`,
            priority: 0,
          },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.sources.map((source) => source.path)).toContain(activePath);
  expect(candidates[0]!.sources.map((source) => source.path)).not.toContain(inactivePath);
});

test("oversized combined review evidence marks the handler incomplete", async () => {
  let calls = 0;
  const reviewer = createOpenAICompatibleAuthorizationReviewer({
    endpoint: "https://example.test/v1/chat/completions",
    model: "review-model",
    apiKey: "test-key",
    fetcher: async () => {
      calls++;
      throw new Error("Oversized request sent");
    },
  });
  const extension = createNuxtAuthorizationReviewExtension(reviewer);
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `app/middleware/auth${index}.ts`,
          files["app/middleware/auth.ts"] + " ".repeat(15_800),
        ]),
      ),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(0);
  expect(result.project.evidenceGaps).toContainEqual(
    expect.objectContaining({
      message: "Authorization review request exceeds 120 KB",
      files: ["server/api/account.get.ts"],
    }),
  );
  expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
});

test("local imports beyond the source cap make review evidence incomplete", async () => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async () => {
    calls++;
    return { status: "unknown", reason: "Missing guard", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts":
        Array.from(
          { length: 5 },
          (_, index) => `import guard${index} from '../utils/guard${index}'`,
        ).join("\n") + "\nexport default defineEventHandler(guard4)",
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `server/utils/guard${index}.ts`,
          "export default event => requireAuth(event)",
        ]),
      ),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(0);
  expect(result.project.evidenceGaps).toContainEqual(
    expect.objectContaining({
      files: ["server/utils/guard4.ts"],
    }),
  );
  expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
});

test.each(["accounts", "profiles", "sessions"])(
  "reviews plural sensitive route %s",
  async (route) => {
    const candidates: Parameters<AuthorizationReviewer>[0][] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      candidates.push(candidate);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": files["app/middleware/auth.ts"],
        [`server/api/${route}.get.ts`]: files["server/api/account.get.ts"],
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(candidates.map((candidate) => candidate.handler.path)).toEqual([
      `server/api/${route}.get.ts`,
    ]);
  },
);

test.each(["../guards/auth.cjs", "../guards/auth", "../guards"])(
  "collects CommonJS guard evidence from %s",
  async (specifier) => {
    const guard = specifier === "../guards" ? "server/guards/index.cjs" : "server/guards/auth.cjs";
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      expect(candidate.sources.map((source) => source.path)).toContain(guard);
      return {
        status: "report",
        reason: "The custom guard returns private data without authorization.",
        citations: [
          { path: candidate.handler.path, line: 1 },
          { path: guard, line: 1 },
        ],
      };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        "app/middleware/auth.ts": files["app/middleware/auth.ts"],
        "server/api/account.cjs": `const guard = require('${specifier}'); module.exports = defineEventHandler(guard)`,
        [guard]: "module.exports = () => ({ private: true })",
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(result.diagnostics.map((item) => item.code)).toContain("NUXT0074");
  },
);

test("rejects layer middleware evidence after the active layer config changes", async () => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async () => {
    calls++;
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      "layers/admin/nuxt.config.ts":
        "export default defineNuxtConfig({ dir: { middleware: 'guards' } })",
      "layers/admin/middleware/auth.ts": files["app/middleware/auth.ts"],
      "server/api/account.get.ts": files["server/api/account.get.ts"],
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [
          {
            root: "layers/admin",
            nuxtConfigMtimeMs: 0,
            appMiddlewareDir: "layers/admin/middleware",
            priority: 0,
          },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(result.project.nuxt?.manifest?.isCurrent).toBe(false);
  expect(calls).toBe(0);
});

test.each([
  { cycle: false, dynamic: false },
  { cycle: true, dynamic: false },
  { cycle: false, dynamic: true },
  { cycle: true, dynamic: true },
  { cycle: false, dynamic: "commented" },
])("collects nested guard policy: cycle=$cycle, dynamic=$dynamic", async ({ cycle, dynamic }) => {
  let calls = 0;
  const collected: string[] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    calls++;
    collected.push(...candidate.sources.map((source) => source.path));
    return { status: "unknown", reason: "Policy available for review", citations: [] };
  });
  await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts":
        "import guard from '../utils/guard'; export default defineEventHandler(guard)",
      "server/utils/guard.ts": dynamic
        ? `export default async event => (await import(${dynamic === "commented" ? '/* webpackChunkName: "policy" */' : ""}'./policy')).default(event)`
        : "import policy from './policy'; export default event => policy(event)",
      "server/utils/policy.ts": cycle
        ? "import guard from './guard'; export default guard"
        : "export default event => requireAuth(event)",
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(1);
  expect(collected).toContain("server/utils/policy.ts");
});

test.each([false, true, "commented"])(
  "omitted nested guard policies make the report incomplete: dynamic=%s",
  async (dynamic) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async () => {
      calls++;
      return { status: "unknown", reason: "Missing policy", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/account.get.ts":
          "import guard from '../utils/guard'; export default defineEventHandler(guard)",
        "server/utils/guard.ts": dynamic
          ? `export default async event => (await import(${dynamic === "commented" ? '/* webpackChunkName: "policy" */' : ""}'./policy')).default(event)`
          : "import policy from './policy'; export default event => policy(event)",
        "server/utils/policy.ts": " ".repeat(16_001),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(0);
    expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  },
);

test.each([
  "import guard = require('./policy'); export default guard",
  "export default async event => (await import(`./policy`)).default(event)",
  "import guard from '~/utils/policy'; export default defineNuxtRouteMiddleware(guard)",
])("collects static dependencies from handler and middleware: %s", async (source) => {
  for (const availability of ["present", "missing", "oversized"]) {
    const middleware = source.includes("defineNuxtRouteMiddleware");
    const policy = middleware ? "app/utils/policy.ts" : "server/api/policy.ts";
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      calls++;
      expect(candidate.sources.map((item) => item.path)).toContain(policy);
      return { status: "unknown", reason: "Evidence collected", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        [middleware ? "app/middleware/auth.ts" : "server/api/account.get.ts"]: source,
        ...(availability === "missing"
          ? {}
          : {
              [policy]:
                availability === "oversized"
                  ? " ".repeat(16_001)
                  : "export default event => requireAuth(event)",
            }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(availability === "present" ? 1 : 0);
    if (availability !== "present")
      expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  }
});

test.each(["handler", "middleware"])("retains JSON evidence imported by %s", async (source) => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    calls++;
    expect(candidate.sources).toContainEqual({
      path: "permissions.json",
      text: '{"role":"admin"}',
    });
    return { status: "unknown", reason: "Evidence collected", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      [source === "handler" ? "server/api/account.get.ts" : "app/middleware/auth.ts"]:
        `import permissions from '../../permissions.json'; export default ${source === "handler" ? "defineEventHandler" : "defineNuxtRouteMiddleware"}(() => permissions)`,
      "permissions.json": '{"role":"admin"}',
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(1);
  expect(JSON.parse(createAgentReport(result)).status).not.toBe("incomplete");
});

test.each(["import(`./policies/${tenant}`)", "require(policyPath)"])(
  "non-static dependencies make authorization evidence incomplete: %s",
  async (dependency) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async () => {
      calls++;
      return { status: "unknown", reason: "Missing policy", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/account.get.ts":
          "import guard from '../utils/guard'; export default defineEventHandler(guard)",
        "server/utils/guard.ts": `export default async event => (await ${dependency}).default(event)`,
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(0);
    expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
  },
);

test.each([".", "old-app"])("stale middleware configuration %s is incomplete", async (appDir) => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    calls++;
    expect(candidate.sources.map((source) => source.path)).toContain("app/middleware/auth.ts");
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "nuxt.config.ts": "export default defineNuxtConfig({})",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: "2000-01-01T00:00:00.000Z",
        appDir,
      }),
      "old-app/middleware/auth.ts": "export default () => true",
      "middleware/auth.ts": "export default () => true",
      "current/policies/auth.ts": "export default () => true",
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(result.project.nuxt?.manifest?.isCurrent).toBe(false);
  expect(calls).toBe(0);
  expect(JSON.parse(createAgentReport(result)).status).toBe("incomplete");
});

test.each(["present", "missing", "oversized"])(
  "collects authoritative auto-imported guards: %s",
  async (availability) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      calls++;
      expect(candidate.sources.map((source) => source.path)).toContain("server/utils/access.ts");
      return { status: "unknown", reason: "Evidence collected", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/account.get.ts":
          "export default defineEventHandler(async event => { await enforceAccountAccess(event); return {} })",
        ...(availability === "missing"
          ? {}
          : {
              "server/utils/access.ts":
                availability === "oversized"
                  ? " ".repeat(16_001)
                  : "export const enforceAccountAccess = event => requireUserSession(event)",
            }),
        ".nuxt/doctor.manifest.json": JSON.stringify({
          resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
          generatedAt: new Date(Date.now() + 1000).toISOString(),
          appDir: "app",
          autoImportEnabled: true,
          autoImports: [
            { name: "enforceAccountAccess", from: "~~/server/utils/access", kind: "app" },
          ],
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(availability === "present" ? 1 : 0);
    expect(JSON.parse(createAgentReport(result)).status === "incomplete").toBe(
      availability !== "present",
    );
  },
);

test.each([
  ["assignment target", "enforceAccountAccess = () => {}"],
  ["destructuring target", "({ enforceAccountAccess } = event)"],
  ["array target", "[enforceAccountAccess] = event"],
  ["local variable", "const enforceAccountAccess = () => {}; enforceAccountAccess()"],
  ["hoisted function", "enforceAccountAccess(); function enforceAccountAccess() {}"],
  ["parameter", "const run = (enforceAccountAccess) => enforceAccountAccess()"],
  ["destructured parameter", "const run = ({ enforceAccountAccess }) => enforceAccountAccess()"],
  ["block binding", "{ const enforceAccountAccess = () => {}; enforceAccountAccess() }"],
  ["catch binding", "try {} catch (enforceAccountAccess) { enforceAccountAccess() }"],
  [
    "explicit import",
    "import { enforceAccountAccess } from '../../utils/local'; enforceAccountAccess()",
  ],
  ["member property", "event.enforceAccountAccess()"],
  ["object key", "const access = { enforceAccountAccess: true }"],
  ["method name", "const access = { enforceAccountAccess() {} }"],
  ["type reference", "let access: enforceAccountAccess"],
])("ignores auto-import names used as %s", async (_name, source) => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    calls++;
    expect(candidate.sources.map((item) => item.path)).not.toContain("server/utils/access.ts");
    if (_name === "explicit import") {
      expect(candidate.sources.map((item) => item.path)).toContain("utils/local.ts");
    }
    return { status: "unknown", reason: "Evidence collected", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts": `${source}\nexport default defineEventHandler(() => ({ private: true }))`,
      "utils/local.ts": "export const enforceAccountAccess = () => {}",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: new Date(Date.now() + 1000).toISOString(),
        appDir: "app",
        autoImportEnabled: true,
        autoImports: [
          { name: "enforceAccountAccess", from: "~~/server/utils/access", kind: "app" },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(1);
  expect(JSON.parse(createAgentReport(result)).status).not.toBe("incomplete");
});

test.each([
  "enforceAccountAccess++",
  "enforceAccountAccess += 1",
  "enforceAccountAccess(event)",
  "const access = { enforceAccountAccess }",
  "event[enforceAccountAccess]",
  "{ const enforceAccountAccess = () => {}; } enforceAccountAccess(event)",
])("collects unbound auto-import references: %s", async (source) => {
  let calls = 0;
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    calls++;
    expect(candidate.sources.map((item) => item.path)).toContain("server/utils/access.ts");
    return { status: "unknown", reason: "Evidence collected", citations: [] };
  });
  await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts": `${source}\nexport default defineEventHandler(() => ({ private: true }))`,
      "server/utils/access.ts":
        "export const enforceAccountAccess = event => requireUserSession(event)",
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
        generatedAt: new Date(Date.now() + 1000).toISOString(),
        appDir: "app",
        autoImportEnabled: true,
        autoImports: [
          { name: "enforceAccountAccess", from: "~~/server/utils/access", kind: "app" },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(calls).toBe(1);
});

test.each(["analytics.ts", "auth.ts", "admin/access.ts"])(
  "matches auth middleware within an auth-named layer: %s",
  async (name) => {
    let calls = 0;
    const extension = createNuxtAuthorizationReviewExtension(async () => {
      calls++;
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        "server/api/account.get.ts": files["server/api/account.get.ts"],
        [`layers/admin/app/middleware/${name}`]: files["app/middleware/auth.ts"],
        ".nuxt/doctor.manifest.json": JSON.stringify({
          resolvedServerHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
          generatedAt: "2100-01-01T00:00:00.000Z",
          layers: [
            {
              root: "layers/admin",
              srcDir: "layers/admin/app",
              appMiddlewareDir: "layers/admin/app/middleware",
              priority: 0,
            },
          ],
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(name === "analytics.ts" ? 0 : 1);
  },
);

test.each(["present", "oversized", "inactive", "custom-server"])(
  "collects active layer server middleware: %s",
  async (state) => {
    let calls = 0;
    const serverDir =
      state === "custom-server" ? "extensions/admin/backend" : "extensions/admin/server";
    const guard = `${serverDir}/middleware/auth.ts`;
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      calls++;
      expect(candidate.sources.some((source) => source.path === guard)).toBe(
        state === "present" || state === "custom-server",
      );
      expect(candidate.sources.some((source) => source.path.includes("app/server"))).toBe(false);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "extensions/admin/app/server/middleware/auth.ts": " ".repeat(17000),
        [guard]:
          "export default defineEventHandler(event => requireAuth(event))" +
          (state === "oversized" ? " ".repeat(17000) : ""),
        ".nuxt/doctor.manifest.json": JSON.stringify({
          resolvedServerHandlers: [
            { file: "server/api/account.get.ts", route: "/api/account" },
            ...(state === "inactive" ? [] : [{ file: guard, middleware: true }]),
          ],
          generatedAt: "2100-01-01T00:00:00.000Z",
          layers:
            state === "inactive"
              ? [{ root: ".", srcDir: "app", priority: 0 }]
              : [
                  {
                    root: "extensions/admin",
                    srcDir: "extensions/admin/app",
                    serverDir,
                    priority: 0,
                  },
                ],
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(calls).toBe(state === "oversized" ? 0 : 1);
    expect(JSON.parse(createAgentReport(result)).status === "incomplete").toBe(
      state === "oversized",
    );
  },
);

test.each(["api", "routes"])("reviews conventional layer %s handlers", async (directory) => {
  const handler = `extensions/admin/backend/${directory}/account.ts`;
  const reviewed: string[] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    reviewed.push(candidate.handler.path);
    return {
      status: "report",
      reason: "The handler has no server guard.",
      citations: [
        { path: candidate.handler.path, line: 1 },
        { path: "app/middleware/auth.ts", line: 1 },
      ],
    };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      "app/middleware/auth.ts": files["app/middleware/auth.ts"],
      [handler]: files["server/api/account.get.ts"],
      [`extensions/admin/backend/${directory}/health.ts`]:
        "export default defineEventHandler(() => 'ok')",
      [`extensions/admin/backend/${directory}/status.ts`]: " ".repeat(17000),
      [`extensions/admin/app/server/${directory}/account.ts`]: " ".repeat(17000),
      [`extensions/admin/server/${directory}/account.ts`]: " ".repeat(17000),
      [`extensions/inactive/server/${directory}/account.ts`]: " ".repeat(17000),
      ".nuxt/doctor.manifest.json": JSON.stringify({
        resolvedServerHandlers: [{ file: handler, route: "/api/account" }],
        generatedAt: "2100-01-01T00:00:00.000Z",
        layers: [
          {
            root: "extensions/admin",
            srcDir: "extensions/admin/app",
            serverDir: "extensions/admin/backend",
            priority: 0,
          },
        ],
      }),
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(reviewed).toEqual([handler]);
  expect(result.diagnostics.map((item) => item.code)).toEqual(["NUXT0074"]);
  expect(result.project.evidenceGaps ?? []).toEqual([]);
});

test.each([undefined, [], [{ file: "custom/entry.ts", route: "/api/account" }]])(
  "uses resolved Nitro inventory without scanning excluded or shadowed files: %j",
  async (resolvedServerHandlers) => {
    const reviewed: string[] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      reviewed.push(candidate.handler.path);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    const result = await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "layers/admin/server/api/account.get.ts": files["server/api/account.get.ts"],
        "layers/admin/server/middleware/auth.ts": " ".repeat(17000),
        "custom/entry.ts": files["server/api/account.get.ts"],
        ".nuxt/doctor.manifest.json": JSON.stringify({
          generatedAt: "2100-01-01T00:00:00.000Z",
          layers: [{ root: "layers/admin", serverDir: "layers/admin/server", priority: 0 }],
          serverHandlers: [{ file: "server/api/account.get.ts", route: "/api/account" }],
          resolvedServerHandlers,
        }),
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(reviewed).toEqual(resolvedServerHandlers?.length ? ["custom/entry.ts"] : []);
    expect(JSON.parse(createAgentReport(result)).status === "incomplete").toBe(
      resolvedServerHandlers === undefined,
    );
  },
);

test.each([
  "import type { Policy } from '../types'",
  "import { type Policy } from '../types'",
  "export type { Policy } from '../types'",
  "export { type Policy } from '../types'",
  "export type * from '../types'",
  "import type Policy = require('../types')",
])("erased dependencies do not consume guard evidence: %s", async (declaration) => {
  const candidates: Parameters<AuthorizationReviewer>[0][] = [];
  const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
    candidates.push(candidate);
    return { status: "unknown", reason: "Collected", citations: [] };
  });
  const result = await runProjectFixture({
    framework: "nuxt",
    files: {
      ...files,
      "server/api/account.get.ts": `${declaration}; import guard from '../guard'; export default defineEventHandler(guard)`,
      "server/types.ts": "export interface Policy {}" + " ".repeat(17000),
      "server/guard.ts": "export default event => requireUserSession(event)",
    },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.sources.map((source) => source.path)).toContain("server/guard.ts");
  expect(result.project.evidenceGaps ?? []).toEqual([]);
});

test.each(["import { type Policy, guard }", "export { type Policy, guard }"])(
  "mixed declarations retain runtime evidence: %s",
  async (declaration) => {
    const candidates: Parameters<AuthorizationReviewer>[0][] = [];
    const extension = createNuxtAuthorizationReviewExtension(async (candidate) => {
      candidates.push(candidate);
      return { status: "unknown", reason: "Collected", citations: [] };
    });
    await runProjectFixture({
      framework: "nuxt",
      files: {
        ...files,
        "server/api/account.get.ts": `${declaration} from '../guard'; export default defineEventHandler(() => ({}))`,
        "server/guard.ts":
          "export interface Policy {}; export const guard = event => requireUserSession(event)",
      },
      rules: extension.rulePacks![0]!.rules,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.sources.map((source) => source.path)).toContain("server/guard.ts");
  },
);
