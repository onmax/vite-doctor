import type { Linter } from "eslint";

type MessageData = Record<string, string>;

interface FindingCopy {
  /** What people using the app see or lose because of the finding. */
  consequence: string;
  /** The remedy, when the upstream message has none or only hints at it. Defaults to the upstream remedy. */
  fix?: (data: MessageData) => string;
}

/** Marks a messageId upstream uses only to describe a suggested edit. */
const suggestion = "suggestion";

export type MessageCopy = FindingCopy | typeof suggestion;

const fixedColor: FindingCopy = {
  consequence:
    "The color stays the same when the theme or dark mode changes, so it can clash with the rest of the interface or lose contrast.",
};
const missingColor =
  "Tailwind generates no CSS for an undeclared color, so the element renders without it.";
const offScale =
  "One-off values sit off the spacing and sizing scale, so this element lines up differently from the rest of the interface.";
const restyled =
  "The class overrides the component's own styles, so this instance looks different from the same component elsewhere in the app.";
const respaced =
  "The class overrides the component's own spacing, so this instance is sized differently from the same component elsewhere in the app.";
const relaidOut =
  "Layout classes on the component can fight the layout it sets itself, so this instance can render differently from the same component elsewhere in the app.";
const noCss = "The element renders without the style that class was meant to add.";

/**
 * Doctor's copy for every @shadcn/lint messageId, keyed by upstream Rule name. A Diagnostic's `why`
 * is the upstream problem sentence plus `consequence`; its `fix` is `fix(data)` or the upstream remedy.
 */
export const designSystemMessageCopy: Record<string, Record<string, MessageCopy>> = {
  "no-restyle": {
    appearanceClass: { consequence: restyled },
    appearanceClassWithVariants: { consequence: restyled },
    appearanceClassNoVariants: { consequence: restyled },
    appearanceClassViaWrapper: { consequence: restyled },
    deniedClass: {
      consequence: restyled,
      fix: (d) =>
        `Remove "${d.className}" from <${d.component}>, and use one of its variants for a different look.`,
    },
    layoutClass: { consequence: relaidOut },
    layoutClassClosed: { consequence: relaidOut },
    unclassifiedClass: {
      consequence:
        "If the class is misspelled, Tailwind generates no CSS for it and the intended style never appears.",
    },
    declaredClass: { consequence: restyled },
    spacingClassWithSizes: { consequence: respaced },
    spacingClassNoSizes: { consequence: respaced },
    spacingClassViaWrapperWithSizes: { consequence: respaced },
    spacingClassViaWrapperNoSizes: { consequence: respaced },
  },
  "no-raw-colors": {
    paletteClass: fixedColor,
    paletteClassNear: {
      ...fixedColor,
      fix: (d) =>
        `Replace "${d.className}" with ${nearest(d.suggestions, "theme token")}, or declare --color-<name> in ${d.file} for a new color.`,
    },
    paletteClassFar: fixedColor,
    paletteClassListed: fixedColor,
    undeclaredToken: { consequence: missingColor },
    undeclaredTokenTypo: {
      consequence: missingColor,
      fix: (d) => `Replace "${d.className}" with "${d.suggestion}".`,
    },
    rawColorAttribute: fixedColor,
    rawColorAttributeNear: fixedColor,
    useToken: suggestion,
  },
  "no-arbitrary-values": {
    arbitraryValue: { consequence: offScale },
    arbitraryValueWithScale: {
      consequence: offScale,
      fix: (d) => `Replace "${d.className}" with "${d.replacement}" (same value, on the scale).`,
    },
    arbitraryValueNearScale: {
      consequence: offScale,
      fix: (d) => `Replace "${d.className}" with ${nearest(d.suggestions, "scale value")}.`,
    },
    arbitraryColorNear: {
      ...fixedColor,
      fix: (d) =>
        `Replace "${d.className}" with ${nearest(d.suggestions, "theme token")}, or declare --color-<name> in ${d.file} for a new color.`,
    },
    arbitraryColorFar: fixedColor,
    useScale: suggestion,
    useToken: suggestion,
  },
  "no-inline-styles": {
    inlineStyle: {
      consequence:
        "Inline styles skip the theme, so this element keeps the same look when the theme, dark mode, or a hover or breakpoint state changes.",
    },
    dynamicStyle: {
      consequence:
        "Values computed at runtime are never checked against the theme, so an off-theme color or size can reach the page unnoticed.",
    },
    customPropColor: fixedColor,
    styleElement: {
      consequence:
        "Its rules live outside the theme, so they ignore theme and dark mode changes and can restyle components elsewhere on the page.",
    },
  },
  "require-static-classes": {
    dynamicClasses: {
      consequence:
        "Tailwind only generates CSS for class names written out in full, so a class assembled at runtime can render with no styles, and the other design-system Rules cannot check it.",
      fix: (d) =>
        `Pass complete class strings to <${d.component}> and choose between them in code, such as wide ? "w-full" : "w-auto".`,
    },
  },
  "no-unknown-classes": {
    unknownClass: { consequence: noCss },
    unknownClassSuggest: {
      consequence: noCss,
      fix: (d) => `Replace "${d.className}" with "${d.suggestion}".`,
    },
    unknownVariant: { consequence: "The styles behind that variant never apply." },
    useSuggestion: suggestion,
  },
};

function nearest(list: string, noun: string): string {
  const items = list.split(", ").map((item) => `"${item}"`);
  return items.length === 1
    ? `${items[0]}, the nearest ${noun}`
    : `one of the nearest ${noun}s: ${items.join(", ")}`;
}

interface ParsedTemplate {
  problem: string;
  remedy: string;
  matcher: RegExp;
}

const placeholder = /\{\{\s*(\w+)\s*\}\}/g;
const parsedTemplates = new Map<string, ParsedTemplate>();

function parseTemplate(template: string): ParsedTemplate {
  let parsed = parsedTemplates.get(template);
  if (parsed) return parsed;
  const cut = template.search(/[.?] /);
  const names = new Set<string>();
  const pattern = template
    .split(/(\{\{\s*\w+\s*\}\})/)
    .map((part) => {
      const name = /^\{\{\s*(\w+)\s*\}\}$/.exec(part)?.[1];
      if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (names.has(name)) return `\\k<${name}>`;
      names.add(name);
      return `(?<${name}>[\\s\\S]*?)`;
    })
    .join("");
  parsed = {
    problem: cut === -1 ? template : template.slice(0, cut + 1),
    remedy: cut === -1 ? "" : template.slice(cut + 2),
    matcher: new RegExp(`^${pattern}$`),
  };
  parsedTemplates.set(template, parsed);
  return parsed;
}

function interpolate(template: string, data: MessageData): string {
  return template.replace(placeholder, (match, name: string) => data[name] ?? match);
}

/**
 * Turns one upstream finding into Doctor's why and fix. `templates` are the upstream Rule's
 * `meta.messages`, which recover the data ESLint interpolated into the message.
 */
export function designSystemCopy(
  rule: string,
  message: Linter.LintMessage,
  templates: Record<string, string>,
  docsUrl: string,
): { why: string; fix: string } {
  const id = message.messageId;
  const copy = id ? designSystemMessageCopy[rule]?.[id] : undefined;
  const template = id ? templates[id] : undefined;
  const parsed = template === undefined ? undefined : parseTemplate(template);
  const match = parsed?.matcher.exec(message.message);
  // A custom `message` option or settings note replaces the upstream text and drops its messageId.
  if (!copy || copy === suggestion || !parsed || !match) return customCopy(message, docsUrl);
  const data: MessageData = { ...match.groups };
  // ESLint keeps a suggestion's data on the message, though its types omit it.
  const suggested = message.suggestions?.[0] as { data?: Record<string, unknown> } | undefined;
  for (const [key, value] of Object.entries(suggested?.data ?? {})) data[key] ??= String(value);
  return {
    why: `${interpolate(parsed.problem, data)} ${copy.consequence}`,
    fix: copy.fix?.(data) ?? interpolate(parsed.remedy, data),
  };
}

function customCopy(message: Linter.LintMessage, docsUrl: string): { why: string; fix: string } {
  const text = message.message.trim();
  const cut = text.search(/[.?] /);
  const remedy = cut === -1 ? "" : text.slice(cut + 2);
  return {
    why: cut === -1 ? text : text.slice(0, cut + 1),
    fix: message.suggestions?.[0]?.desc ?? (remedy || `Resolve it as ${docsUrl} describes.`),
  };
}
