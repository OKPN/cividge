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
| **Peer Link** | Any additional canonical `host:filename` Link to the same Object. Peer Links have no original/alias hierarchy. |
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
9. **Lifecycle authority** — The SQLite-backed Durable Object named from the
   canonical ObjectRef (`r2:<s3Key>` or `ipfs:<cid>`) owns the authoritative
   Link relation and lifecycle state. Delivery KV is a projection and
   localStorage is neither an Object authority nor a last-reference oracle.
10. **Actuator separation** — R2 cleanup is executed by the Worker. Filebase
   and Kubo capability holders may be browser-local, but can execute only an
   authorized Placement task and must report `released` or `retryable`; their
   report never authorizes release. Browser-held storage credentials are an
   explicit out-of-band trust boundary.
11. **Immutable Object bytes** — Conversion, metadata policy, EXIF processing,
   and MP4 FastStart complete before Object creation. Different bytes require
   a new Object and must never overwrite an existing locator before conflict
   authorization succeeds.
12. **Placement liveness** — Browser-actuated claims have an authoritative
   lease. An abandoned `PINNING`/`RELEASING` claim returns to a claimable
   state, and an older generation can never mutate the recovered Placement.
13. **Stable relay namespace** — Relay delivery ingress is
   `/r/<relay-id>/<filename>`. `/r/` is routing/security classification, not
   Link identity, and must not be flattened or replaced by per-relay WAF rules.

## Required lifecycle transitions

| Operation | Required result |
| --- | --- |
| New upload | Store or identify an Object, then register its Link. A successful response must not advertise a Link before its registry entry is usable. |
| Duplicate Filebase content | Reuse the matching CID and register a new Alias/Link; do not re-upload identical bytes solely to obtain a different filename. |
| Rename or new delivery domain | Create a new peer Link while retaining the source Link and the same Object/CID. A duplicate canonical Link key is a conflict, not an update. |
| Change TTL or password | Modify only the selected Link's policy. |
| Delete one of several links | Begin authoritative removal, delete that Link's delivery projection, then complete authoritative removal; retain the shared Object/CID and preservation pin. Every partial failure is retryable with the same ObjectRef and Link key. |
| Expiry on access | Invalidate the expired Link and return the configured not-found response; do not clean up a shared Object/CID. |
| Delete or expire the final link | Make the Object release-eligible only after the authoritative Link set and pending-removal set are empty. Physical cleanup still requires a valid Placement claim. |
| Filebase capacity release | Before releasing a Filebase copy that still needs preservation, transition Kubo through `PIN_REQUESTED → PINNING → PRESENT`. `pinning` is not preservation. A failed attempt becomes retryable and must not release the source. |
| Abandoned actuator | Revoke only the expired claim, return acquisition to `PIN_REQUESTED` (or release to `RETRYABLE`), and reject reports from the expired generation. |

## Authoritative mutation and actuator protocol

- Every lifecycle mutation requires the admin capability. An upload-only or
  test-upload token is not a lifecycle capability.
- A Placement executor receives a task containing canonical ObjectRef,
  Placement kind, operation, claim ID, and generation. Only the matching
  current claim may advance state.
- Duplicate reports for the same completed claim are idempotent. A report for
  an older generation or a contradictory outcome is rejected.
- R2 deletion may be executed by the Worker. Filebase deletion and Kubo unpin
  may be executed by browser/local capability holders, but the capability
  holder never decides whether release is allowed.
- Delivery KV is updated from authoritative Placement state after a successful
  mutation/report. It projects `PIN_REQUESTED`, `PINNING`, `PRESENT`, and
  `RETRYABLE` without collapsing them. Client-supplied `kuboStatus` is not authority.

## Relay routing and security namespace

`test-up.pages.dev/foo.webp` may statically redirect to
`relay.k7m.f5.si/r/test-up/foo.webp`. The Worker resolves `test-up` to its
public host and performs exactly one canonical `host:filename` KV lookup.
`kv.k7m.f5.si/<filename>` remains a separate direct-delivery capability.
Zone-wide rate limiting is abuse policy and does not replace the `/r/`
routing/WAF boundary.

## Verification order

After syntax, build, and startup checks, development stops at a manual
exploratory checkpoint. Deep concurrency, failure-injection, and production
E2E testing starts only after ordinary upload, list, delivery, peer-Link,
Kubo, reload, and delete interactions have no obvious anomaly.

## Observation and UI retirement

HEAD/audit failures are observations, not lifecycle mutations. Three
consecutive drifting observations may retire an item from the local UI cache,
but must not delete a Link, request Object release, or perform physical cleanup.
One successful observation resets the confidence counter.

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
| 9–10 | Fail KV deletion and authority completion separately; retry the same Link removal and assert no early release. Replay, stale, and contradictory Placement reports and assert deterministic acceptance/rejection. |
| Observation | Record three HEAD failures and assert local UI retirement only; record success and assert the counter resets. |

## Change rule

Any pull request that changes upload, aliasing, expiry, password, FIFO, storage
cleanup, Filebase, or Kubo behavior must identify the affected invariant(s) and
add or update the corresponding test. If a new storage backend is introduced,
it must implement the same lifecycle contract before it is presented as a
fully supported Cividge backend.
