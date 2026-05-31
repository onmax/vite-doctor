// @ts-nocheck
export default defineEventHandler(() => {
  useNuxtApp();
  navigateTo("/login");
  return { name: "Ada" };
});
