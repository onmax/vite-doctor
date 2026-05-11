export interface WcCapabilities {
  supported: boolean;
  reason?: string;
}

export function checkWcCapabilities(): WcCapabilities {
  if (typeof window === "undefined") return { supported: false, reason: "no-window" };
  if (typeof SharedArrayBuffer === "undefined") return { supported: false, reason: "no-sab" };
  if (!("crossOriginIsolated" in window) || !window.crossOriginIsolated)
    return { supported: false, reason: "no-coi" };
  const ua = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (ua?.mobile) return { supported: false, reason: "mobile" };
  if (window.innerWidth < 768) return { supported: false, reason: "small-screen" };
  return { supported: true };
}
