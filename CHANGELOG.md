# agent-index-filesystem-gdrive — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

---

## [2.2.1] — 2026-05-04

### Fixed

- **Bundle now contains the v2.0 contract ops it advertised in 2.2.0.** The 2.2.0 release added the source-level implementations of `aifs_share`, `aifs_unshare`, `aifs_get_permissions`, `aifs_search`, and `aifs_transfer_ownership` to `src/adapters/gdrive.js` (582 lines) and dispatcher cases to `src/exec.mjs` (60 lines), and bumped `adapter.json` to declare them in `supported_operations`. But `dist/aifs-exec.bundle.js` was never rebuilt — the shipped bundle was byte-identical to 2.1.3, so every call to a v2.0 op returned `UNKNOWN_TOOL` at runtime. Bug `20260502-8d20ea22-2` documented the gap. **2.2.1 is the rebuilt bundle**; the same 5 ops are now actually runnable. New bundle SHA `d1b7ffa040617f4985510e584960f1ad79f0c3bb667ca6399d87a9ad95e4ac9f` (was `ce57443eca9e17d786fffe14efe12dab026a75ed9d7a278872807c4d6f692fcc`). Bundle size 1854225 bytes (was 1833685; +20540 bytes for the new op handlers). `--help` now reports all 14 tools (was 9 in the broken 2.2.0).

- **`supported_operations_pending: []` is now honest.** The 2.2.0 manifest left this field empty despite 5 declared ops being unimplemented at runtime; the field's purpose is to broadcast exactly that gap. With 2.2.1 it remains `[]` because nothing is actually pending now, but the next time we declare ops without runtime support, we'll populate this field accurately rather than skip it.

### Notes

- This release is the no-implementation companion to the implementation work that landed in commit `4e8eec7` ("feat: 2.2.0 — full v2.0 adapter contract implementation," 2026-04-30). The original commit added all five op implementations to source but didn't rebuild the bundle before commit. The commit message even included a TODO at the bottom (*"Before publishing 3.1.0 to org installs, run: `npm run build:exec`"*) — the rebuild step was known but skipped. 2.2.1 is the rebuild.
- Combined with `agent-index-core` 3.3.0's `permission-change-helper` skill and binary, the v3.1.0+ admin task family (`invite-member`, `remove-member`, etc.) is now end-to-end functional pending the consumer-side rewrite tracked in the `admin-tasks-use-permission-plan-pattern` core-improvements idea.
- A new preflight check (`preflight-bundle-vs-supported-ops`) is filed in the developer-collection ideas to catch this class of release-discipline failure at upstream-release time rather than in production.

---

## [2.2.0] — 2026-04-30 (defective)

**Note:** This release advertised the v2.0 contract ops (`share`, `unshare`, `getPermissions`, `search`, `transferOwnership`) in `adapter.json` but the bundle was the 2.1.3 build. Every call to a v2.0 op returned `UNKNOWN_TOOL`. Use 2.2.1 instead.

The source-level work was done in this commit and remains valid; only the bundle was stale. See 2.2.1 above for the rebuild that delivers what 2.2.0 promised.

---

## [2.1.3] — 2026-04-19

### Fixed

- Shared-drive delete behavior, overwrite-based locks, binary write encoding.

---

## [2.1.2] — 2026-04-15

### Fixed

- Lock-leak cleanup, copy/delete stale-cache, sandbox OAuth, quiet output.

---

## Earlier history

See `git log` on this repository for releases prior to 2.1.2.
