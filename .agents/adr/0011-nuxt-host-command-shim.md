# Nuxt Host Command Shim

Doctor keeps `vite-doctor` as the only public install package, but ships a `nuxt-doctor` binary shim inside that package so Nuxt CLI can resolve `nuxt doctor` through its `nuxt-<command>` host-command fallback. This follows the NuxtHub-style subcommand pattern while preserving Doctor's package identity: users install `vite-doctor` and run `pnpm nuxt doctor`, and docs should not present `nuxt-doctor` as a standalone package or direct user-facing CLI.

**Consequences**

The `nuxt-doctor` bin is a Nuxt host-command shim, not a separate public Doctor distribution. It must delegate to the shared Doctor Run path, return diagnostic exit codes cleanly without Node stack traces, and remain covered by packed-artifact checks so release cleanup does not accidentally break `nuxt doctor`.

Packed-artifact validation must check both the direct shim and the Nuxt host command. As of Nuxt CLI 3.35.2, the unknown-command fallback runs `nuxt-<command>` with `tinyexec`, catches non-ENOENT failures, and exits with code 0. That means `pnpm nuxt doctor` can emit the correct Doctor report while still dropping nonzero diagnostic exit codes in the Nuxt parent process. Until Nuxt propagates host-command failures, CI surfaces that require diagnostic exit codes should use `pnpm vite-doctor ...` or the direct `nuxt-doctor` shim while the user-facing Nuxt command remains valid for local reports.
