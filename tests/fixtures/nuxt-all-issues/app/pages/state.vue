<template>
  <p>state issue</p>
</template>

<script setup lang="ts">
const value = useState("set-state", function () {
  return new Set();
});
console.log(value);
</script>
