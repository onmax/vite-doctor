<template>
  <p>wrapper issue</p>
</template>

<script setup lang="ts">
async function useWrappedUser() {
  return await useAsyncData(() => $fetch("/api/user"));
}

console.log(useWrappedUser);
</script>
