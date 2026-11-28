import type {
  ComponentContractInput,
  ComponentLimitInput,
} from "./rule-packs/design-system/contracts.js";

export type { ComponentContractInput, ComponentLimitInput };

declare module "vue" {
  interface ComponentCustomOptions {
    /** Doctor's Component Contract: the raw HTML elements this component replaces, and how many of its usages one view may render. */
    doctor?: ComponentContractInput;
  }
}
