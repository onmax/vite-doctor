import type { RuleContext } from "@vue-doctor/core";
import {
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
  };
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
