<template>
  <button ref="submitButton" v-html="html">Submit</button>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useRoute } from "vue-router";

const submitButton = ref();
const html = String(useRoute().query.label ?? "");
console.log(submitButton);
</script>
