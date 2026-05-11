export function useTotals() {
  const items = ref<{ price: number }[]>([]);
  const total = computed(async () => {
    const rates = await $fetch<{ usd: number }>("/api/rates");
    return items.value.reduce((sum, item) => sum + item.price * rates.usd, 0);
  });
  return { items, total };
}
