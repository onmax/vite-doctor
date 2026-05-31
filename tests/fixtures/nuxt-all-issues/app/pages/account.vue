<template>
  <button>Toast</button>
</template>

<script setup lang="ts">
const content = queryContent("/docs");
const toast = useToast();
toast.add({ title: "Saved" });

console.log(content);
</script>
