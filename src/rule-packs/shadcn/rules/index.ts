import { createShadcnRule } from "./shared.js";

export const noRestyle = createShadcnRule({
  id: "shadcn/no-restyle",
  title: "Avoid restyling design-system components",
  description: "Keep component-owned visual styles inside the component contract.",
  rule: "no-restyle",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-restyle.md",
});
export const noRawColors = createShadcnRule({
  id: "shadcn/no-raw-colors",
  title: "Use design-system color tokens",
  description: "Prefer theme colors over raw color values.",
  rule: "no-raw-colors",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-raw-colors.md",
});
export const noArbitraryValues = createShadcnRule({
  id: "shadcn/no-arbitrary-values",
  title: "Avoid arbitrary Tailwind values",
  description: "Use the design system's existing values instead of arbitrary utilities.",
  rule: "no-arbitrary-values",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-arbitrary-values.md",
});
export const noInlineStyles = createShadcnRule({
  id: "shadcn/no-inline-styles",
  title: "Avoid inline styles",
  description: "Keep styling in the design system rather than component call sites.",
  rule: "no-inline-styles",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-inline-styles.md",
});
export const requireStaticClasses = createShadcnRule({
  id: "shadcn/require-static-classes",
  title: "Keep component classes statically analyzable",
  description: "Use class values that the design-system analyzer can resolve.",
  rule: "require-static-classes",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/require-static-classes.md",
});
export const noUnknownClasses = createShadcnRule({
  id: "shadcn/no-unknown-classes",
  title: "Use known design-system classes",
  description: "Avoid classes that are not declared by the project's Tailwind theme.",
  rule: "no-unknown-classes",
  docsUrl: "https://github.com/shadcn-ui/lint/blob/main/docs/rules/no-unknown-classes.md",
});

export const shadcnRules = [
  noRestyle,
  noRawColors,
  noArbitraryValues,
  noInlineStyles,
  requireStaticClasses,
  noUnknownClasses,
];
