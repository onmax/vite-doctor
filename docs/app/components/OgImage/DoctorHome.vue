<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
  }>(),
  {
    title: "Catch the AI slop your agents ship.",
    description:
      "Doctor scans your project before review and flags framework bugs agents often miss.",
  },
);
</script>

<template>
  <div
    style="
      position: relative;
      display: flex;
      width: 1200px;
      height: 630px;
      overflow: hidden;
      background: #fbfaf7;
      color: #171717;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        &quot;Segoe UI&quot;,
        sans-serif;
    "
  >
    <img
      src="/og/doctor-lifeline-bg.png"
      alt=""
      style="position: absolute; inset: 0; width: 1200px; height: 630px; object-fit: cover"
    />
    <img
      src="/og/doctor-icon.png"
      alt=""
      style="
        position: absolute;
        top: 58px;
        left: 72px;
        width: 76px;
        height: 76px;
        border-radius: 17px;
      "
    />
    <div
      style="
        position: absolute;
        top: 178px;
        left: 72px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        width: 1020px;
      "
    >
      <div
        style="
          margin: 0;
          width: 980px;
          font-size: 42px;
          font-weight: 650;
          line-height: 1;
          color: #171717;
          white-space: nowrap;
        "
      >
        Catch the AI slop your agents ship.
      </div>
      <p
        style="
          margin: 28px 0 0;
          max-width: 610px;
          font-size: 28px;
          line-height: 1.22;
          color: #52525b;
        "
      >
        {{ props.description }}
      </p>
    </div>
  </div>
</template>
