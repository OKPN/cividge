# Cividge Lifecycle Specification

This document is the normative lifecycle contract for **Civitai Bridge (Cividge)**.
It defines properties that implementations in the Pages application and the
`cividge-kv-worker` repository must preserve. It is not a description of the
current implementation: a feature that violates an invariant below is a bug,
even if it appears to work in the UI.

## Scope and terms

| Term | Meaning |
| --- | --- |
| **Object** | Immutable final content bytes identified by `sha256:<digest>`, independent of storage provider, key, or CID. |
| **Link** | A user-facing canonical `host:filename` binding owned by LinkBinding and projected into delivery KV. |
| **Placement** | Physical presence of the Object at an R2, Filebase, or Kubo locator. |
| **Active link** | A link which has not been manually deleted and has not expired. A password gate may restrict access without making the link inactive. |
| **Peer Link** | Any additional canonical `host:filename` Link to the same Object. Peer Links have no original/alias hierarchy. |
| **Preservation pin** | A Kubo pin retained for an IPFS CID to preserve an origin independently of Filebase capacity release. |
| **Physical cleanup** | Deleting an authorized R2 Placement, removing/unpinning an authorized Filebase Placement, or unpinning an authorized Kubo Placement. |

Object, Link, and Placement are deliberately different. A rename-style UI
action creates a peer Link; it does not mutate or remove the old Link. A
retention or password change applies only to its selected Link.

## Safety invariants

1. **Resolvable active links** — Every active Link resolves to exactly one
   registered ObjectId. A Link must never silently resolve to a different
   object after creation.
2. **Shared-object protection** — An Object with one or more active
   Links must not undergo physical cleanup.
3. **Last-reference cleanup** — Physical cleanup is eligible only after the
   final active Link to that Object has been removed or expired.
4. **Link-local controls** — Retention, expiry, password gates, peer Links, and
   delivery domains belong to a Link. Changing one Link must not change the
   policy of another Link to the same Object.
5. **No pre-auth origin disclosure** — A password-protected Link must not
   return its resolved storage URL, object key, CID gateway URL, or response
   body before successful authorization.
6. **Idempotent lifecycle requests** — Retrying a successful upload,
   registration, peer Link creation, pin, or cleanup request must not create duplicate Links,
   duplicate preservation pins, or contradictory metadata.
7. **Recoverable failure** — A failure between storage upload, authoritative Link binding,
   KV projection, peer Link creation, expiry processing, or pinning must leave enough state to
   retry or repair the operation without violating invariants 1–6.
8. **Expiry is a Link-level delivery decision** — Cividge uses access-time
   expiry rather than a mandatory cron sweep. Public GET returns 404 for an
   expired Link; that GET does not delete KV, R2, Filebase, or Kubo data.
   Physical cleanup is a separate authorized operation subject to the
   last-reference rule.
9. **Authority by fact** — LinkBinding's SQLite-backed Durable Object owns
   canonical Link uniqueness, binding, generation, and Link-level policy.
   The ObjectLifecycle Durable Object named from canonical ObjectId owns Object
   membership, Placement state, and release authorization. Delivery KV is a
   projection; localStorage is neither authority nor a last-reference oracle.
10. **Actuator separation** — R2 cleanup is executed by the Worker. A
   Worker-managed Filebase RPC Placement may be unpinned by the Worker only
   after ObjectLifecycle authorization and only inside an explicitly dedicated
   Cividge bucket. Browser S3 Filebase and Kubo capability holders execute
   only their authorized Placement tasks. Reports never authorize release;
   browser-held credentials remain an out-of-band trust boundary.
11. **Immutable Object bytes** — Conversion, metadata policy, EXIF processing,
   and MP4 FastStart complete before Object creation. Different bytes require
   a new ObjectId and must never overwrite an existing locator before conflict
   authorization succeeds.
12. **Placement liveness** — Browser-actuated claims have an authoritative
   lease. An abandoned `PINNING`/`RELEASING` claim returns to a claimable
   state, and an older generation can never mutate the recovered Placement.
13. **Stable relay namespace** — Relay delivery ingress is
   `/r/<relay-id>/<filename>`. `/r/` is routing/security classification, not
   Link identity, and must not be flattened or replaced by per-relay WAF rules.

`ObjectRef` in existing API field names is the canonical ObjectId, not an R2
key or IPFS CID. It is `sha256:<digest>` of the exact final bytes after every
conversion/metadata/FastStart operation. R2 `(bucket,key)`, Filebase S3
`(bucket,key,cid)`, Worker-managed Filebase RPC `cid`, and Kubo `cid` are
Placement locators. The delivery KV may project these locators but is never
the authority for Object membership or physical release. CIDv0 is
case-sensitive; a CID field never carries a backend marker.

## Required lifecycle transitions

| Operation | Required result |
| --- | --- |
| New upload | Determine final-byte ObjectId and authoritative Link/Object preflight before physical PUT. Acquire or identify the needed Placement, then complete the Link. A successful response must not advertise a Link before its delivery projection is usable. |
| Duplicate Filebase content | Reuse the matching final-byte Object and CID, then register a peer Link; do not re-upload identical bytes solely to obtain a different filename. |
| Re-upload after release | The same canonical Link and ObjectId are accepted idempotently after the upload confirms a PRESENT Placement. The lifecycle authority advances the Placement generation, republishes the Link projection, and purges the stale 404; Link creation alone cannot resurrect released storage. |
| Rename or new delivery domain | Create a new peer Link while retaining the source Link and the same Object. A duplicate canonical Link key is a conflict, not an update. |
| Change TTL or password | Modify only the selected Link's policy. |
| Delete one of several links | Begin authoritative removal, delete that Link's delivery projection, then complete authoritative removal; retain the shared Object and preservation pin. Every partial failure is retryable with the same ObjectRef and Link key. |
| Expiry on access | Return the configured not-found response without deleting a Link, KV record, or physical Placement in the GET path. |
| Delete or expire the final link | Make the Object release-eligible only after the authoritative Link set and pending-removal set are empty. Physical cleanup still requires a valid Placement claim. |
| Filebase capacity release | Before releasing a Filebase copy that still needs preservation, transition Kubo through `PIN_REQUESTED → PINNING → PRESENT`. `pinning` is not preservation. A failed attempt becomes retryable and must not release the source. |
| Abandoned actuator | Revoke only the expired claim, return acquisition to `PIN_REQUESTED` (or release to `RETRYABLE`), and reject reports from the expired generation. |

## Authoritative mutation and actuator protocol

- Direct lifecycle management requires the admin capability. An upload-only or
  test-upload token authorizes only the Worker's constrained upload workflow;
  it is not a general lifecycle-management capability.
- A Placement executor receives a task containing canonical ObjectRef,
  Placement kind, operation, claim ID, and generation. Only the matching
  current claim may advance state.
- Duplicate reports for the same completed claim are idempotent. A report for
  an older generation or a contradictory outcome is rejected.
- R2 deletion may be executed by the Worker. Worker-managed Filebase RPC
  unpin requires an ObjectLifecycle release claim, durable Worker-managed
  provenance, and `FILEBASE_DEDICATED_BUCKET=true`. Browser S3 Filebase and
  Kubo actuation remain with their respective capability holders. No actuator
  decides for itself whether release is allowed.
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
The Pages compatibility probe accepts a selected host only when its final
`/r/<relay-id>/404-character.webp` path and the Worker's canonical relay-host
response identify that same host. A 200 response through another relay is not
proof that the selected host is configured.

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

## Managed List and Gateway boundaries

Every current-schema Managed List entry has an explicit kind. A `link` entry
retires through canonical `removeLink`; a `local` entry retires through local
`retireManagedEntry` without requesting physical deletion. R2/Filebase/Kubo
presence is an observation that may update an entry but cannot itself perform
the entry's retirement. A physical-only discovery is not a lifecycle Link.
After authoritative deletion, LinkBinding retains a RETIRED generation.
An explicit admin refresh shows only BOUND Links whose KV projection carries
that exact generation; a stale KV row cannot revive a deleted Link. The browser
discards pre-delete in-flight list results. On reload it may show last-observed
Link rows from localStorage as a cached presentation, not as binding authority.
Acknowledged deletion and policy changes update both memory and this cache.
A successful explicit refresh replaces the cache even with zero entries; a
failed refresh preserves it. Explicit re-upload/rebind creates a newer generation.
An explicit upload may reconcile an uncertain Placement release only after a
read-only inspection of the same physical locator: verified presence restores
PRESENT, absence settles RELEASED before a fresh acquisition. An active
release claim cannot be bypassed. Human-facing navigation 404 HTML embeds
its character image; stale edge 404 variants cannot replace that page.
The admin list projects acknowledged Link expiry policy from LinkBinding,
not an older eventually consistent KV metadata value.

An HTTP Public Gateway is a CID retrieval endpoint, not a Placement, Kubo RPC
node, Filebase provider route, or libp2p peer. Gateway selection and retrieval
failures never mutate Object, Link, or Placement lifecycle state. The current
The frontend contains a public bootstrap catalog, but it is not authority.
An authenticated control-plane API stores the canonical GatewayConfig under
`config:ipfs_gateways` in the Worker's KV namespace. On an IPFS delivery cache
miss, the Worker orders enabled peers using the actual viewer request's
continent or the manual selection, then falls back across peers. Filebase's
provider gateway remains a separate origin candidate. KV propagation is
eventual, so a saved change may take time to reach other Cloudflare regions.

## Verification matrix

Automated tests should live primarily with the Worker, because it owns the KV
registry and cleanup decisions. The browser application should cover the client
state and request construction that feed those API tests.

| Invariant | Minimum automated scenario |
| --- | --- |
| 1 | Register a Link and resolve it; verify that it identifies the registered object/CID only. |
| 2–3 | Create two Links for one CID; delete or expire one; verify that the pin/object remains. Remove the final Link; verify cleanup becomes eligible. |
| 4 | Give two peer Links different TTLs and passwords; modify one and verify the other remains unchanged. |
| 5 | Request a password-protected Link without credentials; assert that no origin URL, CID gateway URL, or file bytes appear in the response. |
| 6 | Replay upload/register/peer-Link/pin requests; assert one logical Link per requested name and no additional pin count. |
| 7 | Simulate a failure after storage upload and before KV registration, then retry; assert a usable single Link and no accidental cleanup. |
| 8 | Access an expired Link; assert a not-found response, then confirm that another active peer Link to the same Object remains usable. |
| 9–10 | Fail KV deletion and authority completion separately; retry the same Link removal and assert no early release. Replay, stale, and contradictory Placement reports and assert deterministic acceptance/rejection. |
| Observation | Record three HEAD failures and assert local UI retirement only; record success and assert the counter resets. |

## Change rule

Any pull request that changes upload, peer Link creation, expiry, password, FIFO, storage
cleanup, Filebase, or Kubo behavior must identify the affected invariant(s) and
add or update the corresponding test. If a new storage backend is introduced,
it must implement the same lifecycle contract before it is presented as a
fully supported Cividge backend.
