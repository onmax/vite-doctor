import { AnyNode, createRule, report } from "./shared.js";

export const noAsyncWatchEffectAfterAwaitRead = createRule({
  meta: {
    id: "vue/watch/no-async-watcheffect-after-await-read",
    title: "Do not read watchEffect dependencies after await",
    category: "watchers",
    severity: "warn",
    fixable: "suggestion",
    requires: { script: true, vue: true },
  },
  create(ctx) {
    return {
      ScriptNode(node: AnyNode) {
        if (!ctx.helpers.isCall(node, "watchEffect")) return;
        const callback = node.arguments?.[0];
        if (!callback?.async || callback.body?.start == null || callback.body?.end == null) return;
        const body = ctx.file.text.slice(callback.body.start, callback.body.end);
        if (!/\bawait\b[\s\S]*\b[A-Za-z_$][\w$]*(?:\.value|\.)/.test(body)) return;
        report(
          ctx,
          node,
          "vue/watch/no-async-watcheffect-after-await-read",
          "warn",
          "watchers",
          "watchEffect only tracks dependencies read before the first await.",
          "Read dependencies before awaiting or use watch() with an explicit source.",
        );
      },
    };
  },
});
