import { noHttpErrorMasking } from "./no-http-error-masking.js";
import { noRemovedH3Send } from "./no-removed-h3-send.js";
import { preferAssertMethod } from "./prefer-assert-method.js";
import { preferGetRequestIp } from "./prefer-get-request-ip.js";
import { preferH3RedirectResponse } from "./prefer-h3-redirect-response.js";
import { preferH3WithBase } from "./prefer-h3-with-base.js";
import { preferValidatedBody } from "./prefer-validated-body.js";
import { preferValidatedQuery } from "./prefer-validated-query.js";
import { preferValidatedRouterParams } from "./prefer-validated-router-params.js";

export { noHttpErrorMasking } from "./no-http-error-masking.js";
export { noRemovedH3Send } from "./no-removed-h3-send.js";
export { preferAssertMethod } from "./prefer-assert-method.js";
export { preferGetRequestIp } from "./prefer-get-request-ip.js";
export { preferH3RedirectResponse } from "./prefer-h3-redirect-response.js";
export { preferH3WithBase } from "./prefer-h3-with-base.js";
export { preferValidatedBody } from "./prefer-validated-body.js";
export { preferValidatedQuery } from "./prefer-validated-query.js";
export { preferValidatedRouterParams } from "./prefer-validated-router-params.js";

export const h3Rules = [
  noRemovedH3Send,
  preferH3RedirectResponse,
  preferH3WithBase,
  noHttpErrorMasking,
  preferAssertMethod,
  preferGetRequestIp,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
];
