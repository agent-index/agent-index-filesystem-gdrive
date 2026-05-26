# agent-index-filesystem-gdrive — Changelog

All notable changes will be documented here.

Format: [MAJOR.MINOR.PATCH] — YYYY-MM-DD

---

## [2.4.1] — <RELEASE_DATE> — companion to core 3.7.4

### Fixed

- **Non-admin onboarding blocker, properly this time** (closes bug `20260522-8d20ea22`, high severity). Verified empirically against two real accounts (Bill: Drive-member; testproduction: non-Drive-member). 2.4.0 attempted this fix but shipped with a broken `corpora: 'allDrives'` + `driveId` combination that the Drive API rejects ("driveId must be specified if and only if corpora is set to drive"). 2.4.1 replaces it with three coordinated changes:

  1. **`_detectDriveMembership()` (new)** probes Shared Drive membership at first need via fail-open `drives.get(driveId)` — 200 → member; 404 → non-member; other → rethrow. Result cached on the adapter instance.

  2. **`_listParams()` (new)** branches every `files.list` query based on membership:
     - Member: `corpora: 'drive'` + `driveId` (the pre-2.4.0 admin path — known good)
     - Non-member: `corpora: 'user'` (no `driveId` — required by the Drive API constraint)
     Both branches set `supportsAllDrives: true` + `includeItemsFromAllDrives: true` when `driveId` is configured.

  3. **Drive-root fallback for path-walking** in `_resolvePathToId`: when an "in parents = `driveId` and name = X" query returns 0 results for a non-Drive-member, fall back to global name search with `corpora: 'allDrives'`. Non-Drive-members cannot enumerate the Drive root itself (`'driveId' in parents` returns nothing), but global name search returns entries they have direct access to. This is what allows path-walking from drive root to succeed for non-Drive-members once invite-member 1.3.0 has applied the direct shares.

  All four `corpora: 'drive'` literal sites in 2.3.0 (and the broken `corpora: 'allDrives'` + `driveId` sites in 2.4.0) now route through `_listParams()`. The single remaining `corpora: 'allDrives'` reference is the intentional drive-root fallback.

  **2.4.1 requires invite-member 1.3.0 (shipping in agent-index-core 3.7.4) for the direct-share grants that make path resolution work for non-Drive-members.** Existing non-admin members need a one-time backfill — see core 3.7.4 release notes.

### Notes

- Bundle SHA-256: `cf6402129a2f807cb859833b1661ba0be977d499dae0420e438033762f790408` (was `60529b80…b952c10e95` in 2.4.0; original `0381116983…d0a423bd3` in 2.3.0).
- `contract_version` unchanged at `2.0.0` — this release fixes internal logic; no contract change.
- **2.4.0 should NOT be installed.** It is broken (Drive API rejects every list operation for any user). 2.4.1 supersedes it. Members who already applied 2.4.0 should run `@ai:update` to pick up 2.4.1 immediately.
- **Empirical verification (this time):** `tmp/aifs-exec-241.bundle.js` tested against Bill's and testproduction's actual gdrive credentials with the full two-account suite (`test-final.mjs`): 13 of 13 operations pass. Bill: membership=true, all reads/lists succeed. testproduction before direct share: membership=false, listing fails gracefully with PATH_NOT_FOUND. testproduction with direct share on `/shared/` (simulating invite-member 1.3.0): all reads/lists succeed and return the same entries Bill sees.

### Retro lesson explicit

The 2.4.0 bug shipped because the WS1 pre-build empirical-verification step couldn't run from the build session (no OAuth credentials). Mechanical bundle verification passed (correct strings in bundle) but the API constraint was never tested. 2.4.1 was written by uploading testproduction's actual credentials and running the two-account suite BEFORE the version bump. This pattern is now adopted as the gdrive-adapter release requirement: any change touching `files.list` query parameters or `drives.get` MUST run the two-account empirical suite before commit.

---

## [2.3.0] — 2026-05-20

### Fixed

- **`share()` actually implements `inherit: false`.** Pre-2.3.0 the option was accepted from callers but discarded with `void options.inherit;`. The original comment cited a Shared-Drive-non-member assumption that doesn't hold when the recipient is already a drive member (e.g., an all-members group). On the client-intelligence install (per-instance ACLs underneath an all-members-Writer parent), the gap surfaced as: every collection member retained Writer access on every instance via inherited parent permissions, regardless of the explicit grant. Documented as the V1 limitation in idea `helper-spec-needs-inherit-passthrough`. Identified during the 3.7.3 release blocker check.

  **New behavior:** when `options.inherit === false`, `share()` first calls `drive.files.update` with `inheritedPermissionsDisabled: true` on the file resource (the Drive-canonical mechanism for limited-access folders; works on both Shared Drives and My Drive), then proceeds to the existing `permissions.create` call. Order is deliberate — disabling inheritance first prevents any transient window where the recipient has broader (inherited) access than intended.

  **Permission requirement:** setting `inheritedPermissionsDisabled` requires `organizer` role on the Shared Drive (or `owner` on My Drive). If the applying user (whoever's OAuth token is in effect — typically the user who clicked Accept on the permission-helper review page) lacks that role, `share()` raises `AccessDeniedError` with an actionable message before the explicit grant runs. No partial state results.

  **Return shape:** `share()` now also returns `inherit_disabled: <boolean>` alongside the existing fields, confirming to callers what semantics were applied.

  **Backward compatible:** specs without `inherit` (or with `inherit: true`) behave exactly as 2.2.x. Only `inherit: false` triggers the new path.

  Companion: agent-index-core 3.7.3 ships the helper-spec v1.1 plumbing (validate.js + apply.js + page.html + the skill spec) that propagates `inherit` from caller specs through to this adapter. Closes bug `20260519-8d20ea22` (the broader permission-helper trust-contract realignment) end-to-end with respect to the inherit-passthrough piece; client-intelligence callers activate the `inherit: false` use case in the same release (per the V1 limitation note in `helper-spec-needs-inherit-passthrough`).

### Notes

- `adapter.json` version 2.2.2 → 2.3.0. `package.json` version 2.2.2 → 2.3.0. `contract_version` unchanged at 2.0.0 (no contract change; just an implementation fix). `supported_operations` unchanged. Bundle SHA-256 changes; `bundle_built_at` refreshed.
- No other op semantics change. `unshare()` does not touch `inheritedPermissionsDisabled` — once set, the flag persists across share/unshare cycles. Re-enabling inheritance when the last explicit grant is removed is intentionally out of scope; it's a separate semantic worth its own idea if ever needed.
- A preflight check that warns when a spec uses `inherit: false` against an adapter advertising `contract_version < 2.0.0` is filed in core-improvements `helper-spec-needs-inherit-passthrough` section 4 (deferred from 3.7.3, stays in the parent idea).

---

## [2.2.2] — 2026-05-07

### Fixed

- **`aifs_delete` no longer misdiagnoses permission denials as `FILE_NOT_FOUND`.** Closes bug `20260416-62a14c43` (open 21 days). On shared drives, Drive's `files.delete` returns `404` for permission denials (not `403`) when the caller lacks the organizer/contentManager role. The pre-2.2.2 code interpreted "404 from delete + same file ID returned by re-resolve" as "Drive really doesn't have it" and threw `FileNotFoundError`. The inference was backwards — the same ID coming back from `_resolvePathToId` (which queries `files.list`) means Drive *did* find the file, so the 404 from `files.delete` was a permission signal, not a missing-file signal. The new logic disambiguates: re-resolve → if file exists, throw `AccessDeniedError` with an actionable message ("On shared drives, files are typically owned by the drive itself; removing them requires the organizer or contentManager role. Ask your Workspace admin to remove the file…"). If re-resolve finds nothing, still throw `FileNotFoundError` (negative-existence case unchanged). The existing trash-via-update fallback inside `driveRemove` is unchanged — that path still runs first for writers who CAN trash.

### Changed

- **`AccessDeniedError` constructor accepts an optional `detail` argument** (in `agent-index-filesystem/src/errors.js`). Backward-compatible: existing one-arg and two-arg call sites work unchanged. New three-arg form lets callers attach actionable guidance to the error message. Used by the gdrive delete-permission-denial diagnostic above.

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
