/** The Report Budget of a text or agent report when the caller sets none. */
export const DEFAULT_REPORT_BUDGET = 8000;

/** One Diagnostic Code group of a Progressive Report, measured in characters. */
export interface BudgetGroup {
  /** Severity tier; lower tiers are planned first. */
  tier: number;
  /** The group's header, at its longest. */
  header: number;
  /** Each row, in the order the group prints them. */
  rows: number[];
  /** What showing every Diagnostic in detail adds on top of the header and all rows. */
  detail: number;
}

export type BudgetUnit =
  | { kind: "header"; group: number }
  | { kind: "row"; group: number }
  | { kind: "detail"; group: number };

export interface GroupShown {
  header: boolean;
  rows: number;
  detail: boolean;
}

export interface BudgetHidden {
  /** Groups whose header is hidden. */
  groups: number;
  /** Diagnostics without a row, including those of hidden groups. */
  rows: number;
  /** Diagnostics not shown in detail. */
  detail: number;
}

/**
 * Plans which units of a Progressive Report fit `maxChars`, given the `fixed` cost of its head
 * and footer. Each severity tier adds every group header with its first row, then the remaining
 * rows round-robin across the tier's groups, and the first unit that doesn't fit hides everything
 * after it. Detail comes only when nothing is hidden, one whole group at a time, skipping groups
 * that don't fit.
 */
export function planReportBudget(
  fixed: number,
  groups: readonly BudgetGroup[],
  maxChars: number,
): BudgetUnit[] {
  const units: BudgetUnit[] = [];
  let used = fixed;
  const fits = (cost: number) => used + cost <= maxChars;
  const tiers = [...new Set(groups.map((group) => group.tier))].sort((a, b) => a - b);
  for (const tier of tiers) {
    const members = groups.flatMap((group, index) => (group.tier === tier ? [index] : []));
    // A header alone says what is wrong but not where, so it takes its first row along.
    for (const index of members) {
      const group = groups[index]!;
      const first = group.rows[0];
      if (!fits(group.header + (first ?? 0))) return units;
      used += group.header + (first ?? 0);
      units.push({ kind: "header", group: index });
      if (first !== undefined) units.push({ kind: "row", group: index });
    }
    const depth = Math.max(0, ...members.map((index) => groups[index]!.rows.length));
    for (let row = 1; row < depth; row++) {
      for (const index of members) {
        const cost = groups[index]!.rows[row];
        if (cost === undefined) continue;
        if (!fits(cost)) return units;
        used += cost;
        units.push({ kind: "row", group: index });
      }
    }
  }
  for (const [index, group] of groups.entries()) {
    if (!fits(group.detail)) continue;
    used += group.detail;
    units.push({ kind: "detail", group: index });
  }
  return units;
}

/** What each group shows under a planned prefix of units. */
export function shownGroups(groups: readonly BudgetGroup[], units: readonly BudgetUnit[]) {
  const shown: GroupShown[] = groups.map(() => ({ header: false, rows: 0, detail: false }));
  for (const unit of units) {
    const group = shown[unit.group]!;
    if (unit.kind === "header") group.header = true;
    else if (unit.kind === "row") group.rows++;
    else group.detail = true;
  }
  return shown;
}

export function hiddenCounts(
  groups: readonly BudgetGroup[],
  shown: readonly GroupShown[],
): BudgetHidden {
  const hidden: BudgetHidden = { groups: 0, rows: 0, detail: 0 };
  for (const [index, group] of groups.entries()) {
    const state = shown[index]!;
    if (!state.header) hidden.groups++;
    hidden.rows += group.rows.length - (state.header ? state.rows : 0);
    if (!state.detail) hidden.detail += group.rows.length;
  }
  return hidden;
}

export function hasHidden(hidden: BudgetHidden): boolean {
  return hidden.groups + hidden.rows + hidden.detail > 0;
}
