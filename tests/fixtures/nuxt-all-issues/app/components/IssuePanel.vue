<template>
  <section>
    <p v-if="process.client">client-only branch</p>
    <p>{{ $route.fullPath }}</p>
  </section>
</template>

<script setup lang="ts">
import { useAsyncData } from "#imports";
import { useFetch } from "@vueuse/core";
import { useRoute } from "vue-router";

const route = useRoute();
const width = window.innerWidth;
const theme = localStorage.getItem("theme");
const now = Date.now();
localStorage.setItem("theme", theme ?? "dark");
await fetch("/api/user");
await useAsyncData(() => $fetch("/api/user"));

console.log(route, width, now, useFetch);
</script>
