<script setup lang="ts">
const props = defineProps<{ users: { id: string; name: string }[] }>();
</script>

<template>
  <ul>
    <li v-for="user in props.users">{{ user.name }}</li>
  </ul>
</template>
