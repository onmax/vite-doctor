<template>
  <button ref="submitButton" v-html="html">Submit</button>
</template>

<script setup lang="ts">
import { ref } from "vue";

const submitButton = ref();
const html = "<strong>trusted?</strong>";
console.log(submitButton);
</script>
