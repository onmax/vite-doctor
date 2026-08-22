# Language-Owned TypeScript Rule Pack

Doctor keeps generic TypeScript diagnostics in a built-in `vite-doctor/typescript` Rule Pack. The pack activates its Recommended Preset when Project Inventory proves that the project contains TypeScript. Framework Rule Packs do not copy or own these rules.

The Vite Doctor distribution registers the TypeScript Rule Pack for every Doctor Run, while language activation keeps JavaScript-only projects unaffected. `typescript/strict` remains explicit because it contains opinionated policies that are unsuitable as defaults.

TypeScript diagnostics use the package-owned `TS` code prefix. Rules that require semantic type analysis remain out of the pack until Doctor's Type Graph can provide evidence rather than syntax-only guesses.
