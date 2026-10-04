<template>
  <p>state issue</p>
</template>

<script setup lang="ts">
const value = useState("callback-state", function () {
  return function () {};
});
console.log(value);
</script>
