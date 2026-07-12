# agent-index-filesystem-gdrive — Changelog

## [2.11.1] — 2026-07-12 — Release C.1.4.3.1 — fix aifs_get_permissions regression (getpermsinvalidownerfield)

### Fixed
- **`aifs_get_permissions` no longer requests the invalid `owner` permission field (`getpermsinvalidownerfield`).** 2.11.0's getpermsownerwriter fix added `owner` to the Drive `permissions.list` fields selector, but the Drive v3 *permission* resource has no `owner` field — so every `aifs_get_permissions` call failed with "Invalid field selection owner" (broke invite pre-state diffs, publish 6e reconcile, find-doc reconcile, transfer gate). The selector now requests only real permission fields; the owner is still surfaced (role `owner`) via the permission's `role === 'owner'` (the `p.owner === true` fallback is removed — it was meaningless). Test suite corrected to not mock a nonexistent field and now guards the selector against re-introducing `owner`.

## [2.11.0] — 2026-07-12 — Release C.1.4.3 — surface owner role (getpermsownerwriter)

### Fixed
- **`aifs_get_permissions` surfaces the true `owner` role for My-Drive items (`getpermsownerwriter`).** `_driveRoleToAifsRole` mapped `owner → writer`, so ownership couldn't be read back from the permissions list; now the owning user of a My-Drive item is reported with role `owner` (from the Drive permission's `role === 'owner'` / `owner: true` flag, with the `owner` field added to the query). `reader`/`writer`/`organizer` mappings unchanged; Shared-Drive items (no single owner) still report `organizer → writer`. Adds regression tests (suite green). OneDrive parity is tracked separately (Graph exposes the owner differently) — see `onedriveownernotsurfaced`.

## [2.10.0] — 2026-07-10 — Release C.1.4.2 — advertise batch ops + rootsilent

### Fixed
- **`batchopsnotadvertised` — `writeBatch`/`statBatch` added to `adapter.json` `supported_operations`.** They were implemented + dispatched since 2.9.0 but not advertised, so consumers that gate on `supported_operations` fell back to per-file (the timeout the batch op was meant to remove). Now discoverable + reliably used.
- **`rootsilent` — a non-Drive-member's empty root listing fails loud.** `list("/")` for a non-member returned a silent `[]` (they can't enumerate a Shared Drive they aren't a member of), which reads as "the org is empty." It now throws `AIFS_ROOT_NOT_ENUMERABLE` with guidance to address items by id-anchor (org-config `folder_id`s / `id:{fileId}`); a *member's* genuinely-empty root still returns `[]`. Regression-tested.

## [2.9.0] — 2026-07-08 — Release C.1.4.0 — batch ops (bulkuploadserial)

### Added
- **`aifs_write_batch` and `aifs_stat_batch` — many files in ONE process.** Closes bug `20260706-8d20ea22-bulkuploadserial`: the one-process-per-op exec model made the publish-updates Step 0 SHA walk and dist uploads spawn a Node process per file (impractical for hundreds of files — which pushed agents to shortcut the walk; see core `pubstep0versionmatch`). `aifs_write_batch` uploads an array of `{path, content|content_file}` with the full M2 durable read-back per file; `aifs_stat_batch` returns size + Drive `md5Checksum` per path so the Step-0 diff can run without downloading content. Best-effort (a single file's failure doesn't abort the batch; per-file results returned).
- **Duplicate-parent-folder safe by construction.** Google Drive permits same-named siblings, so unserialized concurrent writes to `/foo/bar/f1` + `/foo/bar/f2` can each create their own `/foo/bar`. `writeBatch` pre-ensures the UNIQUE set of parent dirs ONCE, up front, through the locked `_ensureParentDirs` (in-process + cross-process locks + query-before-create), then writes the files into the resolved parents — collapsing N caller processes into one and making the batch a net *reduction* in duplicate-folder risk vs N separate `aifs_write` calls. Regression-tested.

## [2.8.2] — 2026-07-06 — Release C.1.3.7 — search read-path fix

Closes bug `20260706-8d20ea22-searchpathunresolvable`, surfaced by the Agent Index Dev 1 gdrive-arm validation (admin couldn't read a cross-drive-shared library doc via agent-index).

### Fixed
- **`search()` returns a resolvable locator per result.** It set each result's `path` from an `_idToPath(f.id)` session-cache lookup with a fabricated `/${f.name}` fallback when the id wasn't cached — under the (wrong) premise that "search results aren't critical-path for path resolution." That path was not round-trippable: any caller that searched-then-read an uncached or cross-drive hit (e.g. library `find-doc` on a doc another member shared) got `FILE_NOT_FOUND` from `stat`/`read`/`exists`. Now each result's `path` is the cached human-readable path when known, else the file's **`id:{fileId}` anchor** (which `stat`/`read`/`exists`/`get_permissions` resolve directly and is cross-drive-safe), and each result also carries the raw **`id`** so callers can address it unambiguously.

### Added
- Unit tests for the search→read round trip: an uncached hit returns an `id:{id}` anchor + `id` (not `/{name}`); a cached hit keeps its real path and still carries `id`.

### Notes
- `contract_version` unchanged at `2.0.0` (additive `id` field on search results + a resolvable `path`; no op contract change).
- Bundle SHA / `bundle_built_at` recomputed at native build; `exec_bundle_checksum` updated by the build.

## [2.8.1] — 2026-07-02 — Release C.1.3.6 — member-auth parity (onedrive port)

Closes the gdrive half of member-onboarding bug `20260701-8d20ea22-memberauthbootstrap`. onedrive has had both of these since the `pkcerestart` fix; this ports them to gdrive.

### Fixed
- **`aifs_authenticate` infers `complete` from `auth_code` (`exec.mjs`).** The dispatch was `action = args.action || 'start'`, so a caller that passed the pasted code but omitted `action:"complete"` silently re-ran `start` and ignored the code — a driver without the exact contract in context could never finish (blocked a live member onboarding on Agent Index Dev 1). Now `action = args.action || (args.auth_code ? 'complete' : 'start')`, matching the onedrive adapter.
- **`startAuth` messages name the completion call.** The `awaiting_code` / `awaiting_callback` responses now tell the caller to finish by calling `aifs_authenticate` with `action:"complete"` and `auth_code` (and not to re-issue `start`), so the completion contract is discoverable from the response itself — matching onedrive's self-documenting message.

### Notes
- `contract_version` unchanged at `2.0.0`. No behavior change to any data op; auth-dispatch + message only.
- Bundle SHA / `bundle_built_at` recomputed at native build; `exec_bundle_checksum` updated by the build.

## [2.8.0] — 2026-07-01 — Release C.1.3.5 — M2 write-integrity parity

Companion to core 3.22.5. Ports the C.1.3.4 OneDrive M2 durable read-back to gdrive so cross-backend write-integrity is verified, not inferred. Reference: `/shared/reference/ms365-adapter/59-gdrive-arm-M2-and-mitmcadefer-design.md`.

### Added
- **M2 — durable committed-size read-back in `write()` (HIGH).** After a write, the adapter now (a) checks the create/update **response** `size` against the bytes sent, and (b) independently re-reads the **committed** size via a fresh `fields=size` metadata GET and compares again. Catches torn/partial commits of **non-sentinel** content — JSON config, binaries — that the sentinel re-read never covered (the sentinel path only fires for text ending in `AIFS:FILE-END`; ms_install_10's `collection.json` shipped at 31030/32402 bytes and would slip past a response-only check). Expected byte count is computed correctly for both text (`Buffer.byteLength(…, 'utf-8')`) and `base64:` binary (decoded length). Best-effort reads (transient errors ride the 500ms/1s/2s backoff; an unreadable size returns null = "cannot confirm", never a false failure); on a confirmed mismatch it rewrites once, then throws `AIFS_WRITE_VERIFY_FAILED` with `{ path, expected_bytes, actual_bytes, verify: 'durable-readback' }` — the same contract shape as onedrive 2.4.0. `size` was added to the `fields` of all three `doWrite()` branches to enable the response-size check.

### Notes
- `contract_version` unchanged at `2.0.0` — internal write-verification logic only, no contract change.
- Bundle SHA-256 and `bundle_built_at` are recomputed at native build time (host-side); `exec_bundle_checksum` in `adapter.json` is updated by the build.

## [2.7.0] — 2026-06-29 — Release C.1.3.3 — bootstraplinkunavailable parity

Backfilled retroactively (2.7.0 shipped without a changelog entry).

### Added
- **`web_url` in `stat`** (via Drive `webViewLink`) so invite-member can put a real clickable bootstrap-download link in the welcome email, matching the onedrive adapter (K3 welcome-email-link parity). Additive field; no scope change.
- **`.gitattributes`** — autocrlf protection for the repo (C.1.3.2 line-ending guard, ported to gdrive).

## [2.6.0] — 2026-06-09 — Platform Reliability

Release record: core-improvements `releases/platform-reliability/`. Closes bugs `20260604-8d20ea22-143415-2837` (F4), `20260608-8d20ea22-233527-clicap`, `20260609-8d20ea22-flakyread`; tail-loss prevention for `20260608-8d20ea22-003039-trunc`.

### Fixed
- **F4 — byte-exact reads**: the exec layer emitted `aifs_read` string results via `console.log`, appending a trailing newline to every file read and poisoning hash/diff comparisons fleet-wide. String results now go through `process.stdout.write` unchanged; structured (JSON) output is unaffected.
- **flakyread — no more silent empties**: `read()` never returns empty content for a file whose metadata reports non-zero size — it stat-gates, retries with backoff (500ms/1s/2s), and throws `AIFS_READ_UNRELIABLE` if the backend keeps returning empty. Transient NOT_FOUND on resolution gets one cache-busted re-resolution before `FILE_NOT_FOUND`. Genuinely empty / genuinely missing files behave exactly as before.

### Added
- **`content_file` / `content_stdin` on `aifs_write`** (closes clicap): payloads can be read from a local file path or stdin, bypassing the ~128KB single-CLI-arg cap. With `encoding: "base64"`, file/stdin payloads are treated as raw binary and encoded by the executor. The `content` arg path is unchanged.
- **Sentinel-aware write verification** (standards.md § "File-integrity sentinel"): when written text content ends with an `AIFS:FILE-END` encoding, the adapter reads back post-write and confirms the marker survived; one rewrite attempt, then `AIFS_WRITE_VERIFY_FAILED`. Unstamped and binary content: zero overhead. Exported helpers `detectSentinel` / `AIFS_SENTINEL` for tooling reuse.
- **Unit test suite** (`src/adapters/gdrive.test.js`, `node --test`, mocked Drive): 14 tests covering sentinel detection (all four encodings + negatives), flakyread retry semantics, and write-verification pass/heal/fail paths. Live binary round-trip and large-write tests are in the release test plan (S1).

## [2.5.1] — 2026-06-08

### Fixed

- **bin5 — binary upload (HIGH).** `write()` with `base64:`-prefixed content now wraps the decoded Buffer in a `Readable` stream before handing it to the googleapis media writer. The writer calls `part.body.pipe()`, which threw `part.body.pipe is not a function` on a raw Buffer — so no PNG/JPG/binary file could be created or updated. Strings are unaffected. (Surfaced by brand-book manage-assets logo upload.)
- **db13 — duplicate-name resolution (HIGH).** The non-Drive-member drive-root fallback in `_resolvePathToId()` previously ran an unconstrained global name search (`corpora: allDrives`) and silently picked the first match — resolving the WRONG same-named folder when more than one was accessible (e.g. `/shared/{name}`, or strays in the member's My Drive). It now disambiguates by parent **as a tie-breaker applied only when there is more than one candidate**: (1) exactly one accessible match → use it as-is (NO parent filter — a non-member's view of a directly-shared folder frequently omits the inaccessible drive-root parent, so filtering a single legitimate match would wrongly resolve the whole tree to null); (2) multiple matches → keep those whose parent is the drive root, and if exactly one remains use it, otherwise FAIL LOUD with the candidate list; (3) `id:{folderId}` anchors bypass name search entirely. (bug 20260606-62a14c43-230135-db13)

### Deferred

- **F4 (aifs_read trailing newline)** is NOT changed here. read() returns raw UTF-8 with no appended newline; the spurious trailing newline originates in the exec output layer, and altering the read output contract requires a dedicated caller-regression sweep. Deferred to its own focused effort to avoid destabilizing callers that already compensate.

### Behavior change note

- The db13 fail-loud path can surface an explicit "ambiguous path segment" error where the adapter previously returned a silently-wrong folder. This is intended — loud beats wrong — but admins should be aware the error is new.

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
