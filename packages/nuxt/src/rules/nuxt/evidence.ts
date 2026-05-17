import type { RuleContext } from "@vue-doctor/core";
import {
  classifyExecutionEvidence,
  classifyNuxtFile,
  isClientCallableEvidence,
  isClientOnlyPath,
  isConfigBuildFile,
  isContentDocsFile,
  isKnownGuardedBrowserGlobal,
  isPayloadSerializedEvidence,
  isReusableDataComposableContext,
  isRuntimeAppFile,
  isServerRuntimeFile,
  isSourceOnlyExecutionEvidence,
  isSsrExecutedEvidence,
  hasPriorServerReturnGuard,
  isNuxtRuntimeFile,
  isObjectPropertyKey,
  isVueUseBrowserGlobalTarget,
  type AnyNode,
  type NuxtExecutionEvidence,
  type NuxtFileClass,
} from "./shared.js";

export interface NuxtRuntimeEvidence {
  fileClass: NuxtFileClass;
  executionFor(node: AnyNode): NuxtExecutionEvidence;
  isRuntimeAppFile(): boolean;
  isServerRuntimeFile(): boolean;
  isContentDocsFile(): boolean;
  isConfigBuildFile(): boolean;
  isSsrExecuted(node: AnyNode): boolean;
  isClientCallable(node: AnyNode): boolean;
  isPayloadSerialized(node: AnyNode): boolean;
  isReusableDataComposable(node: AnyNode): boolean;
  isSourceOnlyExecution(node: AnyNode): boolean;
  isActionableUniversalBrowserGlobal(node: AnyNode): boolean;
  universalBrowserGlobalSeverity(node: AnyNode): "error" | "warn";
}

export function createNuxtRuntimeEvidence(ctx: RuleContext): NuxtRuntimeEvidence {
  return {
    fileClass: classifyNuxtFile(ctx),
    executionFor(node) {
      return classifyExecutionEvidence(ctx, node);
    },
    isRuntimeAppFile() {
      return isRuntimeAppFile(ctx);
    },
    isServerRuntimeFile() {
      return isServerRuntimeFile(ctx);
    },
    isContentDocsFile() {
      return isContentDocsFile(ctx);
    },
    isConfigBuildFile() {
      return isConfigBuildFile(ctx);
    },
    isSsrExecuted(node) {
      return isSsrExecutedEvidence(ctx, node);
    },
    isClientCallable(node) {
      return isClientCallableEvidence(ctx, node);
    },
    isPayloadSerialized(node) {
      return isPayloadSerializedEvidence(ctx, node);
    },
    isReusableDataComposable(node) {
      return isReusableDataComposableContext(ctx, node);
    },
    isSourceOnlyExecution(node) {
      return isSourceOnlyExecutionEvidence(ctx, node);
    },
    isActionableUniversalBrowserGlobal(node) {
      return isActionableUniversalBrowserGlobal(ctx, node);
    },
    universalBrowserGlobalSeverity(node) {
      return isSourceOnlyExecutionEvidence(ctx, node) ? "warn" : "error";
    },
  };
}

function isActionableUniversalBrowserGlobal(ctx: RuleContext, node: AnyNode) {
  if (
    !isNuxtRuntimeFile(ctx) ||
    isClientOnlyPath(ctx.file.relativePath) ||
    ctx.helpers.isNuxtServerFile(ctx.file.relativePath)
  )
    return false;
  return !(
    isObjectPropertyKey(node) ||
    ctx.helpers.isTypeOnlyContext(node) ||
    ctx.helpers.isTypeofOperand(node) ||
    ctx.helpers.hasLocalBindingBefore(node, ctx.file.text) ||
    isKnownGuardedBrowserGlobal(ctx.file.text, node.start) ||
    hasPriorServerReturnGuard(ctx.file.text, node.start) ||
    isVueUseBrowserGlobalTarget(node) ||
    isClientCallableEvidence(ctx, node) ||
    ctx.helpers.isClientOnlyExecutionContext(node, ctx.file.text)
  );
}

export {
  classifyExecutionEvidence,
  classifyNuxtFile,
  isClientCallableEvidence,
  isConfigBuildFile,
  isContentDocsFile,
  isPayloadSerializedEvidence,
  isReusableDataComposableContext,
  isRuntimeAppFile,
  isServerRuntimeFile,
  isSourceOnlyExecutionEvidence,
  isSsrExecutedEvidence,
};

export type { NuxtExecutionEvidence, NuxtFileClass };
