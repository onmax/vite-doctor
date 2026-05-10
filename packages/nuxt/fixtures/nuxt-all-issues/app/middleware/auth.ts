// @ts-nocheck
export default defineNuxtRouteMiddleware(() => {
  const route = useRoute();
  if (!route.meta.public) {
    navigateTo("/login");
  }
});
