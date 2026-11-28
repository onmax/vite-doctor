// Vue's own check, copied from @vue/compiler-dom's `isValidHTMLNesting` (3.5.43,
// dist/compiler-dom.cjs.js:702). compiler-dom does not export it, and production builds drop the
// `validateHtmlNesting` transform that calls it, so Doctor cannot reach it. Keep the tables in sync.

/** Whether Vue's template compiler accepts `child` as a direct child element of `parent`. */
export function isValidHTMLNesting(parent: string, child: string): boolean {
  if (parent === "template") return true;
  const children = own(onlyValidChildren, parent);
  if (children) return children.has(child);
  const parents = own(onlyValidParents, child);
  if (parents) return parents.has(parent);
  if (own(knownInvalidChildren, parent)?.has(child)) return false;
  if (own(knownInvalidParents, child)?.has(parent)) return false;
  return true;
}

/**
 * Whether the browser's HTML parser closes, drops, or moves `child` when server-rendered markup
 * nests it directly in `parent`. Vue rejects every such pair, but it also rejects pairs the parser
 * keeps in place, such as `<dd>` in `<section>`, which do not break hydration.
 */
export function parserMovesChild(parent: string, child: string): boolean {
  if (isValidHTMLNesting(parent, child)) return false;
  if (UNSETTLED_PARENTS.has(parent)) return false;
  // Table insertion modes foster-parent other content or insert implied `<tbody>` and `<tr>`.
  if (TABLE_PARENTS.has(parent)) return !TABLE_KEPT_CHILDREN.has(child);
  const closers = own(KEPT_OUTSIDE_CLOSERS, child);
  return !closers || closers.has(parent);
}

// Browsers parse `<select>` content differently since customizable `<select>`, and a component
// does not render into `<head>`.
const UNSETTLED_PARENTS = new Set(["head", "select", "optgroup", "option"]);
const TABLE_PARENTS = new Set(["table", "tbody", "thead", "tfoot", "tr", "colgroup"]);
// `<input type="hidden">` stays in a table too; Doctor does not read the type.
const TABLE_KEPT_CHILDREN = new Set(["template", "script", "style", "input", "form"]);
// The parser keeps these anywhere except under the open elements their start tag closes.
const KEPT_OUTSIDE_CLOSERS: Record<string, Set<string>> = {
  dd: new Set(["p", "dd", "dt"]),
  dt: new Set(["p", "dd", "dt"]),
  figcaption: new Set(["p"]),
  summary: new Set(["p"]),
  area: new Set(),
};

function own(table: Record<string, Set<string>>, tag: string): Set<string> | undefined {
  return Object.hasOwn(table, tag) ? table[tag] : undefined;
}

const headings = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const emptySet = new Set<string>([]);

const onlyValidChildren: Record<string, Set<string>> = {
  head: new Set([
    "base",
    "basefront",
    "bgsound",
    "link",
    "meta",
    "title",
    "noscript",
    "noframes",
    "style",
    "script",
    "template",
  ]),
  optgroup: new Set(["option"]),
  select: new Set(["optgroup", "option", "hr"]),
  table: new Set(["caption", "colgroup", "tbody", "tfoot", "thead"]),
  tr: new Set(["td", "th"]),
  colgroup: new Set(["col"]),
  tbody: new Set(["tr"]),
  thead: new Set(["tr"]),
  tfoot: new Set(["tr"]),
  script: emptySet,
  iframe: emptySet,
  option: emptySet,
  textarea: emptySet,
  style: emptySet,
  title: emptySet,
};

const onlyValidParents: Record<string, Set<string>> = {
  html: emptySet,
  body: new Set(["html"]),
  head: new Set(["html"]),
  td: new Set(["tr"]),
  colgroup: new Set(["table"]),
  caption: new Set(["table"]),
  tbody: new Set(["table"]),
  tfoot: new Set(["table"]),
  col: new Set(["colgroup"]),
  th: new Set(["tr"]),
  thead: new Set(["table"]),
  tr: new Set(["tbody", "thead", "tfoot"]),
  dd: new Set(["dl", "div"]),
  dt: new Set(["dl", "div"]),
  figcaption: new Set(["figure"]),
  summary: new Set(["details"]),
  area: new Set(["map"]),
};

const knownInvalidChildren: Record<string, Set<string>> = {
  p: new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "fieldset",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "nav",
    "menu",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
  ]),
  svg: new Set([
    "b",
    "blockquote",
    "br",
    "code",
    "dd",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "menu",
    "meta",
    "ol",
    "p",
    "pre",
    "ruby",
    "s",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "u",
    "ul",
    "var",
  ]),
};

const knownInvalidParents: Record<string, Set<string>> = {
  a: new Set(["a"]),
  button: new Set(["button"]),
  dd: new Set(["dd", "dt"]),
  dt: new Set(["dd", "dt"]),
  form: new Set(["form"]),
  li: new Set(["li"]),
  h1: headings,
  h2: headings,
  h3: headings,
  h4: headings,
  h5: headings,
  h6: headings,
};
