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
