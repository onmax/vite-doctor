<script setup lang="ts">
const props = defineProps<{ body: string }>();
</script>

<template>
  <article class="comment">
    <div v-html="props.body" />
  </article>
</template>
