import { noDiscardedResponse } from "./no-discarded-response.js";
import { noDoubleBodyRead } from "./no-double-body-read.js";
import { noEventFirstArg } from "./no-event-first-arg.js";
import { noExactPathUse } from "./no-exact-path-use.js";
import { noHtmlPlainString } from "./no-html-plain-string.js";
import { noHttpErrorMasking } from "./no-http-error-masking.js";
import { noIgnoredHooks } from "./no-ignored-hooks.js";
import { noNumericCreateError } from "./no-numeric-create-error.js";
import { noPreparedStatusWithResponse } from "./no-prepared-status-with-response.js";
import { noRemovedExports } from "./no-removed-exports.js";
import { noRemovedRouterApi } from "./no-removed-router-api.js";
import { noThrowPlainObject } from "./no-throw-plain-object.js";
import { preferAssertMethod } from "./prefer-assert-method.js";
import { preferGetRequestIp } from "./prefer-get-request-ip.js";
import { preferH3RedirectResponse } from "./prefer-h3-redirect-response.js";
import { preferH3WithBase } from "./prefer-h3-with-base.js";
import { preferValidatedBody } from "./prefer-validated-body.js";
import { preferValidatedQuery } from "./prefer-validated-query.js";
import { preferValidatedRouterParams } from "./prefer-validated-router-params.js";
import { sessionPasswordTooShort } from "./session-password-too-short.js";

export { noDiscardedResponse } from "./no-discarded-response.js";
export { noDoubleBodyRead } from "./no-double-body-read.js";
export { noEventFirstArg } from "./no-event-first-arg.js";
export { noExactPathUse } from "./no-exact-path-use.js";
export { noHtmlPlainString } from "./no-html-plain-string.js";
export { noHttpErrorMasking } from "./no-http-error-masking.js";
export { noIgnoredHooks } from "./no-ignored-hooks.js";
export { noNumericCreateError } from "./no-numeric-create-error.js";
export { noPreparedStatusWithResponse } from "./no-prepared-status-with-response.js";
export { noRemovedExports } from "./no-removed-exports.js";
export { noRemovedRouterApi } from "./no-removed-router-api.js";
export { noThrowPlainObject } from "./no-throw-plain-object.js";
export { preferAssertMethod } from "./prefer-assert-method.js";
export { preferGetRequestIp } from "./prefer-get-request-ip.js";
export { preferH3RedirectResponse } from "./prefer-h3-redirect-response.js";
export { preferH3WithBase } from "./prefer-h3-with-base.js";
export { preferValidatedBody } from "./prefer-validated-body.js";
export { preferValidatedQuery } from "./prefer-validated-query.js";
export { preferValidatedRouterParams } from "./prefer-validated-router-params.js";
export { sessionPasswordTooShort } from "./session-password-too-short.js";

export const h3Rules = [
  noRemovedExports,
  preferH3RedirectResponse,
  preferH3WithBase,
  noHttpErrorMasking,
  preferAssertMethod,
  preferGetRequestIp,
  preferValidatedBody,
  preferValidatedQuery,
  preferValidatedRouterParams,
  noEventFirstArg,
  noDiscardedResponse,
  noPreparedStatusWithResponse,
  noHtmlPlainString,
  noNumericCreateError,
  noThrowPlainObject,
  noDoubleBodyRead,
  sessionPasswordTooShort,
  noIgnoredHooks,
  noRemovedRouterApi,
  noExactPathUse,
];
