import { createRule } from "./shared.js";

export const sessionPasswordTooShort = createRule({
  meta: {
    id: "h3/security/session-password-too-short",
    title: "Use a session password of at least 32 characters",
    description:
      "Flags a literal session password shorter than 32 characters passed to useSession(), getSession(), updateSession(), sealSession(), or unsealSession().",
    why: 'H3 seals sessions with iron-webcrypto, which rejects passwords under 32 characters. Every session read or write then throws "Password string too short", and a short literal password is a weak, committed secret anyway.',
    recommendedReplacement:
      "Read a secret of at least 32 characters from runtime configuration or an environment variable instead of a literal.",
    category: "security",
    severity: "error",
    confidence: "proven",
    fixable: "suggestion",
    docsUrl: "https://h3.dev/utils/session",
    requires: { script: true },
  },
  create() {
    return undefined;
  },
});
