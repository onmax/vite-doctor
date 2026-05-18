#!/usr/bin/env bash
set -euo pipefail

skill_dir="${CODEX_HOME:-$HOME/.codex}/skills/doctor"
mkdir -p "$skill_dir"

base_url="https://raw.githubusercontent.com/onmax/vite-doctor/main/skills/doctor"
curl -fsSL "$base_url/SKILL.md" -o "$skill_dir/SKILL.md"
curl -fsSL "$base_url/README.md" -o "$skill_dir/README.md"

printf 'Installed Doctor skill to %s\n' "$skill_dir"
