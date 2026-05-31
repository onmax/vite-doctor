<template>
  <main>
    <ul>
      <li v-for="item in items" v-if="item.active">{{ item.name }}</li>
    </ul>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch, onWatcherCleanup } from "vue";

const props = defineProps<{ count: number }>();
const { count } = defineProps<{ count: number }>();

props.count++;
watch(count, () => {});

const total = ref(0);
const doubled = total + 1;
const impure = computed(() => {
  total.value++;
  return total.value;
});
const asyncValue = computed(async () => await fetch("/api/user"));

await Promise.resolve();
onWatcherCleanup(() => {});

const width = window.innerWidth;
const items = [{ name: "One", active: true }];
console.log(doubled, impure, asyncValue, width);
</script>
