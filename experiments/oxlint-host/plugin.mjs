import { noDynamicNewUrl } from "./rules/no-dynamic-new-url.mjs";
import { noPublicSrcImport } from "./rules/no-public-src-import.mjs";
import { noRawFetchInSetup } from "./rules/no-raw-fetch-in-setup.mjs";
import { noSetupPropsDestructure } from "./rules/no-setup-props-destructure.mjs";
import { noUnvalidatedDeserialization } from "./rules/no-unvalidated-deserialization.mjs";
import { preferValidatedQuery } from "./rules/prefer-validated-query.mjs";

/** oxlint JS plugin hosting the ported Doctor Rules. Rule names match `rule-map.mjs`. */
export default {
  meta: { name: "doctor" },
  rules: {
    "no-unvalidated-deserialization": noUnvalidatedDeserialization,
    "no-public-src-import": noPublicSrcImport,
    "no-dynamic-new-url": noDynamicNewUrl,
    "no-setup-props-destructure": noSetupPropsDestructure,
    "prefer-validated-query": preferValidatedQuery,
    "no-raw-fetch-in-setup": noRawFetchInSetup,
    /** Visits only `Program`: the floor cost of handing every AST to JS. */
    noop: { create: () => ({ Program() {} }) },
  },
};
