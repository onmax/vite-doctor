import { expect, test } from "vite-plus/test";
import {
  hiddenCounts,
  planReportBudget,
  shownGroups,
  type BudgetGroup,
} from "../../src/core/internal/report-budget.ts";

const group = (tier: number, rows: number[], detail = 100): BudgetGroup => ({
  tier,
  header: 10,
  rows,
  detail,
});

test("errors are planned before warnings, whatever their order", () => {
  const groups = [group(2, [1, 1]), group(1, [1, 1])];
  const units = planReportBudget(0, groups, 23);
  expect(units).toEqual([
    { kind: "header", group: 1 },
    { kind: "row", group: 1 },
    { kind: "row", group: 1 },
    { kind: "header", group: 0 },
    { kind: "row", group: 0 },
  ]);
});

test("a header takes its first row, then rows go round-robin across a tier", () => {
  const groups = [group(0, [1, 1, 1]), group(0, [1, 1, 1])];
  const units = planReportBudget(0, groups, 25);
  expect(units).toEqual([
    { kind: "header", group: 0 },
    { kind: "row", group: 0 },
    { kind: "header", group: 1 },
    { kind: "row", group: 1 },
    { kind: "row", group: 0 },
    { kind: "row", group: 1 },
    { kind: "row", group: 0 },
  ]);
});

test("the first unit that doesn't fit hides every unit after it", () => {
  // The second group's long first row doesn't fit, so the third group's short one is not planned.
  const groups = [group(0, [1]), group(0, [50]), group(0, [1])];
  expect(planReportBudget(0, groups, 40)).toEqual([
    { kind: "header", group: 0 },
    { kind: "row", group: 0 },
  ]);
  const shown = shownGroups(groups, planReportBudget(0, groups, 40));
  expect(hiddenCounts(groups, shown)).toEqual({ groups: 2, rows: 2, detail: 3 });
});

test("the fixed head and footer count against the budget", () => {
  expect(planReportBudget(95, [group(0, [1])], 100)).toEqual([]);
  expect(planReportBudget(89, [group(0, [1])], 100)).toHaveLength(2);
});

test("detail comes only once every row is shown, skipping groups it doesn't fit", () => {
  const groups = [group(0, [1, 1], 200), group(0, [1], 5)];
  const units = planReportBudget(0, groups, 40);
  expect(units.filter((unit) => unit.kind === "detail")).toEqual([{ kind: "detail", group: 1 }]);
  const shown = shownGroups(groups, units);
  expect(shown).toEqual([
    { header: true, rows: 2, detail: false },
    { header: true, rows: 1, detail: true },
  ]);
  expect(hiddenCounts(groups, shown)).toEqual({ groups: 0, rows: 0, detail: 2 });

  const cut = planReportBudget(0, [group(0, [1, 50], 1)], 30);
  expect(cut.some((unit) => unit.kind === "detail")).toBe(false);
});

test("more budget never shows fewer rows", () => {
  const groups = [group(0, [3, 9, 2, 7]), group(0, [4, 4]), group(1, [5, 1, 1])];
  let previous = groups.map(() => 0);
  for (let maxChars = 0; maxChars <= 120; maxChars++) {
    const rows = shownGroups(groups, planReportBudget(0, groups, maxChars)).map(
      (state) => state.rows,
    );
    rows.forEach((count, index) => expect(count).toBeGreaterThanOrEqual(previous[index]!));
    previous = rows;
  }
});
