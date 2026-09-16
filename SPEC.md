# Cividge Lifecycle Specification

This document is the normative lifecycle contract for **Civitai Bridge (Cividge)**.
It defines properties that implementations in the Pages application and the
`cividge-kv-worker` repository must preserve. It is not a description of the
current implementation: a feature that violates an invariant below is a bug,
even if it appears to work in the UI.

## Scope and terms

| Term | Meaning |
| --- | --- |
| **Object** | An R2 object, or the byte content addressed by an IPFS CID. |
| **Link** | A user-facing delivery name, normally `delivery-domain/file-name`, registered in the KV control plane. |
| **Active link** | A link which has not been manually deleted and has not expired. A password gate may restrict access without making the link inactive. |
| **Alias** | A second Link that resolves to the same Object or CID. |
| **Preservation pin** | A Kubo pin retained for an IPFS CID to preserve an origin independently of Filebase capacity release. |
| **Physical cleanup** | Deleting an R2 object, removing a Filebase object, or unpinning a Kubo CID. |

An Object and a Link are deliberately different resources. A rename, domain
selection, retention change, or password change operates on a Link unless this
specification explicitly says otherwise.

## Safety invariants

1. **Resolvable active links** — Every active Link resolves to exactly one
   registered Object or CID. A Link must never silently resolve to a different
   object after creation.
2. **Shared-object protection** — An Object or CID with one or more active
   Links must not undergo physical cleanup.
3. **Last-reference cleanup** — Physical cleanup is eligible only after the
   final active Link to that Object or CID has been removed or expired.
4. **Link-local controls** — Retention, expiry, password gates, aliases, and
   delivery domains belong to a Link. Changing one Link must not change the
   policy of another Link to the same Object or CID.
5. **No pre-auth origin disclosure** — A password-protected Link must not
   return its resolved storage URL, object key, CID gateway URL, or response
   body before successful authorization.
6. **Idempotent lifecycle requests** — Retrying a successful upload,
   registration, alias, pin, or cleanup request must not create duplicate Links,
   duplicate preservation pins, or contradictory metadata.
7. **Recoverable failure** — A failure between storage upload, KV registration,
   alias creation, expiry processing, or pinning must leave enough state to
   retry or repair the operation without violating invariants 1–6.
8. **Expiry is link invalidation** — Cividge uses access-time expiry rather than
   a mandatory cron sweep. Once an expired Link is accessed, it must no longer
   serve the Object. Its physical cleanup remains subject to the last-reference
   rule.

## Required lifecycle transitions

| Operation | Required result |
| --- | --- |
| New upload | Store or identify an Object, then register its Link. A successful response must not advertise a Link before its registry entry is usable. |
| Duplicate Filebase content | Reuse the matching CID and register a new Alias/Link; do not re-upload identical bytes solely to obtain a different filename. |
| Rename or new delivery domain | Create or update a Link while retaining the same Object/CID. |
| Change TTL or password | Modify only the selected Link's policy. |
| Delete one of several links | Remove that Link only; retain the shared Object/CID and preservation pin. |
| Expiry on access | Invalidate the expired Link and return the configured not-found response; do not clean up a shared Object/CID. |
| Delete or expire the final link | Permit physical cleanup and/or Kubo unpin according to the configured storage policy. |
| Filebase capacity release | Before releasing a Filebase copy that still needs preservation, attempt the configured Kubo pin flow; a failed or deferred pin must remain recoverable. |

## Verification matrix

Automated tests should live primarily with the Worker, because it owns the KV
registry and cleanup decisions. The browser application should cover the client
state and request construction that feed those API tests.

| Invariant | Minimum automated scenario |
| --- | --- |
| 1 | Register a Link and resolve it; verify that it identifies the registered object/CID only. |
| 2–3 | Create two Links for one CID; delete or expire one; verify that the pin/object remains. Remove the final Link; verify cleanup becomes eligible. |
| 4 | Give two aliases different TTLs and passwords; modify one and verify the other remains unchanged. |
| 5 | Request a password-protected Link without credentials; assert that no origin URL, CID gateway URL, or file bytes appear in the response. |
| 6 | Replay upload/register/alias/pin requests; assert one logical Link per requested name and no additional pin count. |
| 7 | Simulate a failure after storage upload and before KV registration, then retry; assert a usable single Link and no accidental cleanup. |
| 8 | Access an expired Link; assert a not-found response, then confirm that another active alias to the same Object remains usable. |

## Change rule

Any pull request that changes upload, aliasing, expiry, password, FIFO, storage
cleanup, Filebase, or Kubo behavior must identify the affected invariant(s) and
add or update the corresponding test. If a new storage backend is introduced,
it must implement the same lifecycle contract before it is presented as a
fully supported Cividge backend.
