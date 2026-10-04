// @ts-nocheck
export function useSocketState() {
  return useState("callback-state", function () {
    return function () {};
  });
}
