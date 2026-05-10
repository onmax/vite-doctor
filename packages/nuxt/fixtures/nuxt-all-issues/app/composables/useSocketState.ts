// @ts-nocheck
export function useSocketState() {
  return useState("set-state", function () {
    return new Set();
  });
}
