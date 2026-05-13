<script setup lang="ts">
const route = useRoute();

const framework = computed(() => String(route.params.framework || ""));

definePageMeta({
  validate(route) {
    return ["vue", "vite", "nuxt", "nitro"].includes(String(route.params.framework));
  },
});

await navigateTo(`/rules/${framework.value}`, { redirectCode: 301 });
</script>
