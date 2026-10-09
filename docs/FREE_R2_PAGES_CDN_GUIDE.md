# Standalone R2 + Pages example — not current Cividge delivery

An older version of this guide instructed readers to deploy a Pages `_worker.js` that read an R2 bucket directly. **That is a separate, standalone proxy example; it is not the current Cividge architecture or a replacement for `cividge-kv-worker`.** The old instructions were removed because following them for a Cividge public URL would bypass LinkBinding, ObjectLifecycle-aware release, expiry, password gates, peer Links, and parent-owned `?preview=1`.

For Cividge, use the canonical delivery Worker and configure the public host as described in the [README](../README.md). The frontend Pages project has no direct KV binding and does not implement public media delivery by binding an R2 bucket to a Pages Function.

If a simple **direct R2 bucket URL** is all you need, the optional function-free [R2 static relay](../compatibility-layer/r2/README.md) can redirect a `pages.dev` URL to an R2 origin. Treat that URL as a bucket-origin route, not a full Cividge Link. In particular, the template replaces incoming query strings, so it cannot be used as the parent's `?preview=1` route.

“Free” in the old title never meant unlimited free operation. Cloudflare R2 has separate storage and operation pricing even though internet egress is free; see the [current official R2 pricing](https://developers.cloudflare.com/r2/pricing/) before choosing a plan. Availability, quotas, and Cloudflare Pages/Workers billing also depend on the account and current product terms.
