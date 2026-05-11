export function createBoundedLogBuffer(maxChars: number) {
  let value = "";

  return {
    append(data: string) {
      value = `${value}${data}`.slice(-maxChars);
      return value;
    },
    clear() {
      value = "";
    },
    read() {
      return value;
    },
  };
}
