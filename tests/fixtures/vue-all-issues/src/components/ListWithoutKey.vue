<template>
  <article v-for="item in items">{{ item.name }}</article>
</template>

<script setup lang="ts">
const items = [{ name: "One" }];
</script>
