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
    <div style="position: absolute; inset: 0; background: #fbfaf7; opacity: 0.32" />
    <div
      style="
        position: absolute;
        top: 0;
        left: 0;
        width: 780px;
        height: 630px;
        background: #fbfaf7;
        opacity: 0.94;
      "
    />
    <div
      style="
        position: relative;
        display: flex;
        flex-direction: column;
        justify-content: center;
        width: 720px;
        padding: 72px;
      "
    >
      <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 34px">
        <div
          style="
            display: flex;
            align-items: center;
            justify-content: center;
            width: 46px;
            height: 46px;
            border-radius: 12px;
            background: #059669;
            color: white;
            font-size: 26px;
            font-weight: 700;
          "
        >
          +
        </div>
        <div style="font-size: 26px; font-weight: 650">Doctor</div>
      </div>
      <h1
        style="
          margin: 0;
          max-width: 650px;
          font-size: 72px;
          font-weight: 650;
          line-height: 0.95;
          color: #171717;
        "
      >
        {{ props.title }}
      </h1>
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
      <div style="display: flex; gap: 18px; margin-top: 42px; color: #52525b; font-size: 20px">
        <span style="display: flex; align-items: center; gap: 7px">
          <span style="width: 12px; height: 12px; border-radius: 999px; background: #10b981" />
          Nuxt
        </span>
        <span style="display: flex; align-items: center; gap: 7px">
          <span style="width: 12px; height: 12px; border-radius: 999px; background: #42b883" />
          Vue
        </span>
        <span style="display: flex; align-items: center; gap: 7px">
          <span style="width: 12px; height: 12px; border-radius: 999px; background: #f59e0b" />
          Vite
        </span>
      </div>
    </div>
  </div>
</template>
