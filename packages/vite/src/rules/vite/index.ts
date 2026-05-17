export {
  noRuntimeObjectDefine,
  noSecretDefine,
  noUntypedDefine,
  noUnusedDefine,
} from "./define.js";
export {
  noBroadEnvPrefix,
  noClientSecretPattern,
  noEmptyEnvPrefix,
  noUntypedEnv,
  preferDirectImportMetaEnvAccess,
} from "./env.js";
export { noDynamicNewUrl, noPublicSrcImport, noSrcAbsolutePublicUrl } from "./assets.js";
export { noDynamicWorkerUrl, noNodeApiInWorker, requireWorkerUrlPattern } from "./worker.js";
export { noBrowserGlobalInSsrEntry } from "./ssr.js";
export { noBroadFsAllow, noDisabledFsStrict } from "./server.js";
export {
  requireDisposeForSideEffects,
  requirePluginName,
  preferTransformFilter,
} from "./plugin-hmr.js";

import { defineRulePack } from "@vue-doctor/core";
import {
  noRuntimeObjectDefine,
  noSecretDefine,
  noUntypedDefine,
  noUnusedDefine,
} from "./define.js";
import {
  noBroadEnvPrefix,
  noClientSecretPattern,
  noEmptyEnvPrefix,
  noUntypedEnv,
  preferDirectImportMetaEnvAccess,
} from "./env.js";
import { noDynamicNewUrl, noPublicSrcImport, noSrcAbsolutePublicUrl } from "./assets.js";
import { noDynamicWorkerUrl, noNodeApiInWorker, requireWorkerUrlPattern } from "./worker.js";
import { noBrowserGlobalInSsrEntry } from "./ssr.js";
import { noBroadFsAllow, noDisabledFsStrict } from "./server.js";
import {
  requireDisposeForSideEffects,
  requirePluginName,
  preferTransformFilter,
} from "./plugin-hmr.js";

const rules = [
  noUnusedDefine,
  noUntypedDefine,
  noRuntimeObjectDefine,
  noSecretDefine,
  noUntypedEnv,
  noClientSecretPattern,
  preferDirectImportMetaEnvAccess,
  noEmptyEnvPrefix,
  noBroadEnvPrefix,
  noPublicSrcImport,
  noSrcAbsolutePublicUrl,
  noDynamicNewUrl,
  requireWorkerUrlPattern,
  noDynamicWorkerUrl,
  noNodeApiInWorker,
  noBrowserGlobalInSsrEntry,
  noDisabledFsStrict,
  noBroadFsAllow,
  requirePluginName,
  preferTransformFilter,
  requireDisposeForSideEffects,
];

const recommended = [
  noSecretDefine,
  noClientSecretPattern,
  noEmptyEnvPrefix,
  noBroadEnvPrefix,
  noPublicSrcImport,
  noSrcAbsolutePublicUrl,
  noDynamicNewUrl,
  requireWorkerUrlPattern,
  noDynamicWorkerUrl,
  noBrowserGlobalInSsrEntry,
  noDisabledFsStrict,
  noBroadFsAllow,
  requireDisposeForSideEffects,
].map((rule) => rule.meta.id);

const viteRulePack = defineRulePack({
  name: "vite-doctor/vite",
  version: "0.0.0",
  rules,
  presets: {
    recommended,
    strict: rules.map((rule) => rule.meta.id),
  },
});

export default viteRulePack;
