import { expect, test } from "vite-plus/test";
import { runProjectFixture } from "../../../src/core/testkit.ts";
import {
  createNuxtAuthorizationReviewExtension,
  createOpenAICompatibleAuthorizationReviewer,
  type AuthorizationReviewer,
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
});

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

test("oversized source is not sent to the reviewer", async () => {
  let called = false;
  const extension = createNuxtAuthorizationReviewExtension(async () => {
    called = true;
    return { status: "unknown", reason: "No evidence", citations: [] };
  });
  await runProjectFixture({
    framework: "nuxt",
    files: { ...files, "server/api/account.get.ts": "x".repeat(16_001) },
    rules: extension.rulePacks![0]!.rules,
  });
  expect(called).toBe(false);
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
          appDir: "app",
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
        appDir: "app",
        layers: [{ root: "layers/admin/app", priority: 0 }],
        serverHandlers: [
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
  expect(paths.sort()).toEqual(["server/handlers/account.ts", "server/handlers/entry.ts"]);
  expect(result.diagnostics.filter((item) => item.code === "NUXT0074")).toHaveLength(2);
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
    expect(called).toBe(false);
  },
);
