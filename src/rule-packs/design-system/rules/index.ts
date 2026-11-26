import { preferProjectComponent } from "./prefer-project-component.js";
import { createDesignSystemRule } from "./shared.js";
import { unreadableContract } from "./unreadable-contract.js";

export { preferProjectComponent, unreadableContract };

export const noRestyle = createDesignSystemRule({
  id: "design-system/no-restyle",
  title: "Avoid restyling design-system components",
  description: "Keep component-owned visual styles inside the component contract.",
  rule: "no-restyle",
  confidence: "heuristic-medium",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-restyle.md",
});
export const noRawColors = createDesignSystemRule({
  id: "design-system/no-raw-colors",
  title: "Use design-system color tokens",
  description: "Prefer theme colors over raw color values.",
  rule: "no-raw-colors",
  confidence: "heuristic-medium",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-raw-colors.md",
});
export const noArbitraryValues = createDesignSystemRule({
  id: "design-system/no-arbitrary-values",
  title: "Avoid arbitrary Tailwind values",
  description: "Use the design system's existing values instead of arbitrary utilities.",
  rule: "no-arbitrary-values",
  confidence: "heuristic-high",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-arbitrary-values.md",
});
export const noInlineStyles = createDesignSystemRule({
  id: "design-system/no-inline-styles",
  title: "Avoid inline styles",
  description: "Keep styling in the design system rather than component call sites.",
  rule: "no-inline-styles",
  confidence: "heuristic-high",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-inline-styles.md",
});
export const requireStaticClasses = createDesignSystemRule({
  id: "design-system/require-static-classes",
  title: "Keep component classes statically analyzable",
  description: "Use class values that the design-system analyzer can resolve.",
  rule: "require-static-classes",
  confidence: "heuristic-high",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/require-static-classes.md",
});
export const noUnknownClasses = createDesignSystemRule({
  id: "design-system/no-unknown-classes",
  title: "Use known design-system classes",
  description: "Avoid classes that are not declared by the project's Tailwind theme.",
  rule: "no-unknown-classes",
  confidence: "heuristic-medium",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-unknown-classes.md",
});

export const designSystemRules = [
  noRestyle,
  noRawColors,
  noArbitraryValues,
  noInlineStyles,
  requireStaticClasses,
  noUnknownClasses,
  preferProjectComponent,
  unreadableContract,
];
