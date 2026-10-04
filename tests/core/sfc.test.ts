import { parse } from "@vue/compiler-sfc";
import { expect, test } from "vite-plus/test";
import { createVueScriptForParsing, parseVueScripts } from "../../src/core/internal/sfc.ts";

function parseAdjacentScripts(source: string) {
  const { descriptor } = parse(source, { filename: "app.vue" });
  const script = createVueScriptForParsing(descriptor, source);
  const ast = parseVueScripts("app.vue", descriptor, source) as { body: any[] } | null;
  return { source, script, ast };
}

test("separates adjacent script blocks without changing source offsets", () => {
  const fixture = parseAdjacentScripts(
    `<script lang="ts">import { watch as observe } from 'vue'</script><script setup lang="ts">const { count } = defineProps<{count: number}>(); observe(count, () => {})</script>`,
  );
  expect(fixture.ast?.body).toHaveLength(3);
  expect(fixture.script.text[fixture.source.indexOf("const { count }")]).toBe("c");
  expect(fixture.ast?.body[1]?.start).toBe(fixture.source.indexOf("const { count }"));
});

test("terminates a trailing line comment before an adjacent setup block", () => {
  const fixture = parseAdjacentScripts(
    `<script>const value = 1 // trailing</script><script setup>const browser = window</script>`,
  );
  expect(fixture.ast?.body).toHaveLength(2);
  expect(fixture.ast?.body[1]?.start).toBe(fixture.source.indexOf("const browser"));
});

test("prevents adjacent setup expressions from changing the preceding statement", () => {
  const fixture = parseAdjacentScripts(
    `<script>const value = fn</script><script setup>(function () {})()</script>`,
  );
  expect(fixture.ast?.body).toHaveLength(2);
  expect(fixture.ast?.body[0]?.type).toBe("VariableDeclaration");
  expect(fixture.ast?.body[1]?.type).toBe("ExpressionStatement");
});

test("orders script blocks by their source offsets", () => {
  const fixture = parseAdjacentScripts(
    `<script setup>const value = window</script><script>import { ref } from 'vue'</script>`,
  );
  expect(fixture.ast?.body).toHaveLength(2);
  expect(fixture.ast?.body[0]?.type).toBe("VariableDeclaration");
  expect(fixture.ast?.body[1]?.type).toBe("ImportDeclaration");
});

test.each([
  "const value = 1",
  "import { ref } from 'vue'",
  "export default {}",
  "const value = fn // trailing",
])("preserves statement ends at script content boundaries: %s", (statement) => {
  const fixture = parseAdjacentScripts(
    `<script>${statement}</script><script setup>(function () {})()</script>`,
  );
  const expectedEnd =
    fixture.source.indexOf("</script>") - (statement.includes(" //") ? " // trailing".length : 0);
  expect(fixture.ast?.body).toHaveLength(2);
  expect(fixture.ast?.body[0]?.end).toBe(expectedEnd);
});
