import type { ComponentContractInput } from "./rule-packs/design-system/contracts.js";

export type { ComponentContractInput };

declare module "vue" {
  interface ComponentCustomOptions {
    /** Doctor's Component Contract: the raw HTML elements call sites should render this component instead of. */
    doctor?: ComponentContractInput;
  }
}
