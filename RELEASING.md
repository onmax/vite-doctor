# Release Vite Doctor

Doctor uses [uppt](https://github.com/danielroe/uppt) to create release PRs and stage the `vite-doctor` package on npm. A maintainer reviews the release PR and approves the staged package on npm before users can install it.

## Configure publishing once

Before merging the first release PR:

1. In the repository's **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**.
2. Create a GitHub environment named `npm`. Restrict its deployment tags to `v*`.
3. In the existing `vite-doctor` package's npm access settings, configure a GitHub Actions trusted publisher with owner `onmax`, repository `vite-doctor`, workflow `release.yml`, and environment `npm`. Enable the `npm stage publish` permission.

The workflow uses `GITHUB_TOKEN` and npm OIDC trusted publishing. It does not need an npm token secret.

## Release a version

1. Merge changes into `main` using conventional commit titles such as `fix: ...` or `feat: ...`. On each push, uppt creates or updates a draft `release/vX.Y.Z` PR from the changes since the previous release.
2. Review the proposed version and release notes, mark the PR ready, and merge it.
3. Wait for the Release workflow to verify the merged commit. It runs formatting, build, lint, unit tests, and packed-package checks, including Linux, macOS, and Windows on Node 22.20.0 and 24. Release PRs created with `GITHUB_TOKEN` may not run normal PR CI, so this verification is required before tagging.
4. The workflow creates the version tag and GitHub release, then dispatches a run on that tag. That run verifies the tagged commit, builds and packs the root package, and stages its tarball on npm with provenance. The publish job does not check out or build repository code.
5. Review the staged version on npm and approve it with 2FA. Confirm the version and dist-tag on npm after approval. A GitHub release alone does not mean the npm package is available.

`pnpm pack` builds Doctor through `prepack`. The docs workspace is not published. Branch and PR preview packages continue through `pkg-pr-new`.

The publish workflow preserves the existing dist-tag mapping: `-alpha` versions use `alpha`, `-beta` versions use `beta`, `-rc` versions use `rc`, and other versions use `latest`. This mapping does not add a prerelease-version selector to uppt's generated release PRs. Use only the supported prerelease channels when preparing a prerelease tag.

## Check a release locally

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm pack --pack-destination artifacts
```

The packed-package check installs the tarball in a temporary consumer and checks exports, the `vite-doctor` CLI, the `nuxt-doctor` shim, and `nuxt doctor`. Run `pnpm exec vp fmt` to fix formatting before repeating the read-only release checks.

## Recover a failed release

If verification fails before tagging, fix the failure before retrying. If the fix changes repository code, prepare a new release commit; rerunning verification still checks the original merged commit.

If the tag exists but packing or staging failed, dispatch the Release workflow on that exact tag:

```sh
gh workflow run release.yml --repo onmax/vite-doctor --ref vX.Y.Z
```

Dispatching on a branch does not publish. Dispatching on a version tag reruns all release checks before packing. Pushing a tag alone no longer starts a release.

Before retrying staging, check whether the version is already staged or published. Approve an existing staged version instead of staging it twice. If it has the wrong dist-tag, reject the staged version on npm before staging it again; npm fixes the dist-tag when the version is staged. An already published version requires a new version number.
