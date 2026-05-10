// @ts-nocheck
export async function useWrappedUser() {
  return await useAsyncData(() => $fetch("/api/user"));
}
