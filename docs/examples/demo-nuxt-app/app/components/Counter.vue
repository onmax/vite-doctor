<script setup lang="ts">
const props = defineProps<{ modelValue: number }>();
defineEmits<{ "update:modelValue": [value: number] }>();

function increment() {
  props.modelValue++;
}
</script>

<template>
  <button @click="increment">Count: {{ props.modelValue }}</button>
</template>
