<script setup lang="ts">
interface FooterLink {
  icon: string;
  to: string;
  target: "_blank";
  "aria-label": string;
}

const appConfig = useAppConfig();

const links = computed<FooterLink[]>(() => {
  const socialLabels: Record<string, string> = {
    x: "Onmax on X",
  };

  const socialLinks = Object.entries(appConfig.socials || {}).flatMap(([key, url]) => {
    if (typeof url !== "string" || !url) {
      return [];
    }

    return [
      {
        icon: `i-simple-icons-${key}`,
        to: url,
        target: "_blank" as const,
        "aria-label": socialLabels[key] || `${key} social link`,
      },
    ];
  });

  const githubLink =
    appConfig.github && appConfig.github.url
      ? [
          {
            icon: "i-simple-icons-github",
            to: appConfig.github.url,
            target: "_blank" as const,
            "aria-label": "GitHub repository",
          },
        ]
      : [];

  const nuxtSkillLink = [
    {
      icon: "i-logos-nuxt-icon",
      to: "https://nuxt-skill.onmax.me",
      target: "_blank" as const,
      "aria-label": "Nuxt Skill",
    },
  ];

  return [...socialLinks, ...githubLink, ...nuxtSkillLink];
});
</script>

<template>
  <template v-if="links.length">
    <UButton
      v-for="(link, index) of links"
      :key="index"
      size="sm"
      v-bind="{ color: 'neutral', variant: 'ghost', ...link }"
    />
  </template>
  <UColorModeButton />
</template>
