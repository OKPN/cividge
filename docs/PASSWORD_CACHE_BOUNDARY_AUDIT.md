# Password gate / cache boundary audit (2026-10-14)

This audit uses the current frontend and Worker source, not historical line numbers.
No deployment, production load test, Dashboard change, new authority, or new
domain persistence was performed. Cloudflare Dashboard rules are **unverified**.

## Findings and minimum repairs

| Finding before repair | Evidence / repair |
|---|---|
| Cache API lookup preceded routing, KV, expiration and password validation | A cached public 200 bypassed later password protection and KV-visible deletion/expiry. Move lookup after these gates and OGP selection. |
| Existing URL Cache API key did not depend on current projection | Same URL could reuse the old Object or policy. Add a SHA-256 fingerprint of the observed projection to the internal cache key, without storing a new record. Old cache entries become unreachable, not synchronously physically purged. |
| Normal KV miss used 86400-second negative freshness | Use browser `max-age=0`, shared `s-maxage=60`. Remove negative Cache API writes/reads; each Worker request checks KV. Invalid routing/unsupported addresses retain their separate rejection policy. |
| Random query strings produced distinct internal cache keys | Strip non-semantic query fields; preserve presence of `preview`, `raw`, `thumb`, separate human navigation, and use cache epoch 6. External CDN key configuration is a separate concern. |
| Wrong-password POST sleeps for three seconds | Four concurrent test POSTs incur four KV reads and four verifications, not one serialized admission. At the user's request, use a three-second delay for wrong-password and form-processing errors as limited sequential-retry friction; it does not enforce a rate limit. |
| Session 303 had no explicit no-store; protected media allowed private freshness | Add no-store to successful session responses and protected media. Existing prompt/error/preview already used no-store. No shared storage of authenticated bytes. |
| Session payload identified filename only | Bind the existing HMAC session to canonical Link key, generation and ObjectId. Password hash still supplies the signing key; no session database. Existing cookies need reauthentication. |
| Malformed percent-encoded cookies threw outside the gate | Ignore malformed cookie entries; fail closed through the usual password prompt. Reject non-string password form values. |
| OGP interpolated external filenames/URLs into HTML | Escape text and attribute values, using the existing HTML escaping primitive. |
| `waitUntil(purge()) || purge()` and equivalent cache writes ran twice when waitUntil returned undefined | Schedule one promise. Include direct custom-domain URLs in REST purge, not just relay URLs; do not send empty purge lists or log returned error bodies. |

## Cost of password attempts

For one nonempty wrong password submitted directly to a protected relay Link:
one delivery Worker invocation, one `getWithMetadata`, one PBKDF2 key import
and one 100,000-iteration SHA-256 derivation. There is no Object/R2/Gateway
retrieval, KV write, DO call or HMAC cookie verification on POST. Invalid or
empty form values do not perform a PBKDF2 derivation. A successful POST also
imports an HMAC key and signs a one-hour session; the browser's subsequent
303 GET is another invocation/KV read and validates the HMAC before retrieval.
This count excludes the user's preceding form GET and any Cloudflare platform
implementation costs. A regular protected form GET cannot be shared-cached:
it depends on current Link expiration/protection and the requesting session.

The three-second delay is configured at the user's request. It slows sequential
retries but does not reduce Worker invocations, KV reads, or PBKDF2 operations
already performed. PBKDF2 cost and attempt volume still require pre-Worker admission control.
Distributed IPs, shared NATs and rate-limit propagation remain limitations.

## Dashboard configuration and safe confirmation

Use the zone that owns the actual backend host (`relay.k7m.f5.si` in this install).
Under Security / WAF / Rate limiting rules, inspect enabled rules, their order,
Skip rules, expression, counting characteristics, threshold and mitigation.
Method matching and periods/actions depend on the account's plan; do not claim
this rule exists or is available without checking the Dashboard.

Suggested match (keep `/r/`; never enumerate current relay identifiers):

```text
(http.host eq "relay.k7m.f5.si"
 and starts_with(http.request.uri.path, "/r/")
 and http.request.method eq "POST")
```

Use source IP as the counter (not filename, so changing filenames does not reset
the counter). A starting proposal is 10 attempts/minute and a 60-second block,
subject to available plan periods and normal users sharing an IP. This is an
operational proposal, not a configured value. POST over `/r/` is the password
form route; `/api/upload` and admin APIs are outside this match. GET, HEAD,
OPTIONS and video Range GET must not match. Do not count only responses with
403: that may require first running the Worker. Inspect direct custom-domain
delivery separately; another ingress must not silently bypass this boundary.
workers.dev rejects delivery but keeps authenticated control-plane APIs.

Before relying on the rule, use a disposable protected Link in a test host or
test zone. With explicit approval, send only the small number of attempts needed
to cross the chosen threshold. Check Security Events and Worker invocation logs
that excess POSTs are stopped before Worker execution. Confirm ordinary GET,
authenticated video Range and preview continue working and one normal password
entry succeeds. No automatic production burst test is authorized by this audit.

For strict per-request gating, bypass any **outer shared response cache** on
Worker delivery ingress. The controlled Cache API byte cache remains available
inside the Worker, after KV/gate checks. At minimum bypass `/r/` on the backend
host, and review direct media ingress too. Do not apply a Cache Everything / Edge
TTL override to password forms, POST, cookies, API, preview, OGP or 503. Inspect
Cache Rules, Workers Cache configuration, query normalization and rule ordering.
Any cache before the Worker can otherwise return old public bytes without gates.

## Meaning and consistency guarantees

- INVALID_ADDRESS: invalid relay mapping, blocked ingress, or unsupported address
  under the existing delivery policy; no KV/origin search. No dynamic filename
  whitelist or extra name ledger is introduced. Existing extension/length policy
  is unchanged and does not by itself prove anything about Object existence.
- NOT_FOUND: a successful exact canonical KV projection lookup returned no Link,
  or the observed Link is expired. KV is not lifecycle authority; this is a
  delivery observation, not proof of global authoritative deletion. No DO read or
  mutation is added to GET. A known but unusable projection is 503, not 404.
- UNAVAILABLE: failed KV, malformed known projection, or no available origin is
  503/no-store. Origin 404 alone cannot establish Link absence.
- Public byte cache hits now save an origin read, **not a KV read**. Current KV
  expiration and protection gates always run. Metadata changes select a different
  internal byte cache. Newly returned freshness, including cache hits, is capped
  by remaining Link lifetime. Preview is no-store and never shares a body key.
- A new Link observed by KV is immediately eligible for delivery inside Worker;
  an old negative Cache API entry cannot suppress it. A compliant outer negative
  cache is assigned at most 60 seconds at each miss. KV propagation can extend
  publication/deletion delay and can cause another miss to assign another 60
  seconds. There is **no hard global 60-second publication SLA**. Existing
  pre-hardening 24-hour 404s do not disappear merely because code changed.
- Policy/expiry/password changes use the existing authenticated projection
  mutation path. Binding different bytes to an active Link is a conflict; the
  valid sequence is explicit delete and new binding with a new generation.
  No policy-change UI or new mutation is introduced.
- Purge runs after mutation commit, best effort. API success is not proof that
  all clients/PoPs have observed it. Failure is logged without reversing the
  mutation. Cache API delete is local to the executing PoP; REST purge addresses
  configured relay/direct public URLs, not all hash-versioned internal keys or
  upstream provider caches. Projection-key changes logically retire old internal
  bytes. Browser caches, downloaded bytes and local presentation preview caches
  cannot be remotely erased. Old public content cannot be made secret again.
- Upstream CID-byte caching (normal one year / unpinned seven days, capped when
  assigned by Link lifetime) is unchanged. It protects origins and does not prove
  Placement presence; password-protected upstream fetch uses zero cache TTL.

## Verification checkpoint

Focused tests reproduce the pre-fix bypass and negative-cache blockage, wrong
parallel attempts, authenticated session/rotation, malformed cookies, KV failure,
projection changes, query normalization, invalid relay rejection, IPFS Range 206,
origin 503, inert OGP input, and purge targets. Existing upload/lifecycle/preview
tests are retained. These are local mocks, not proof of Cloudflare edge behavior.

Manual checks before deployment: protected GET/wrong and correct POST; authenticated
Range/preview and unauthenticated crawler; ordinary image/video direct links; 404
then new publish; delete/shorten TTL; explicit delete/rebind; cached startup previews.
After deployment only with approval, compare normal browser and fresh-profile
observations, headers/redirects and Dashboard rules. Deep failure/race testing is
deferred until this **MANUAL EXPLORATORY CHECKPOINT** passes.
