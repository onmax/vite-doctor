export function useScroll() {
  const y = ref(window.scrollY);
  return { y };
}
