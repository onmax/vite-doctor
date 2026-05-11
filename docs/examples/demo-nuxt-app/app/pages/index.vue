<script setup lang="ts">
const count = ref(0);
const users = [{ id: "1", name: "Ada" }, { id: "2", name: "Linus" }];
const comment = ref("<p>hello</p>");
</script>

<template>
  <div>
    <Comment :body="comment" />
    <UserList :users="users" />
    <Counter v-model="count" />
  </div>
</template>
