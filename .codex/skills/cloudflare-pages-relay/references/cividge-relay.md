# Cividge Pages relay reference

## Architecture

Cividge public media URLs use a function-free Pages project that issues static
307 redirects. The canonical KV Worker is the only delivery implementation.
The application Pages project does not own lifecycle state and must not be
given a second media-delivery implementation or KV binding.

## Roles (Tier 2 Static Relay)

Use a static Pages project as the public URL that is pasted to a board. It
performs a cheap 307 redirect only. The storage delivery Worker or R2 domain
behind it remains the backend; do not paste that backend hostname into
Cividge's public delivery-domain selector when the relay is enabled.

```text
https://<project>.pages.dev/<file>
  → 307
https://<backend>/r/<project>.pages.dev/<file>
```

The public project name becomes the Pages hostname. For example,
`--project-name=content-relay` produces `https://content-relay.pages.dev`.
When deploying a new project name, initialize it first with:
`npx wrangler pages project create <project-name> --production-branch main`

## Filebase / IPFS

Start from Cividge's
`compatibility-layer/filebase/_redirects.template`, copying it to an empty
folder as `_redirects`. Replace
`__FILEBASE_PUBLIC_HOST__` with the exact public Pages hostname (for example
`content-relay.pages.dev`). The backend origin is the canonical relay Worker
declared by the maintained template.

The resulting rule must look like:

```text
/* https://relay.example.com/r/content-relay.pages.dev/:splat 307
```

Deploy:

```powershell
npx wrangler pages deploy .\filebase-public-relay --project-name=content-relay
```

Then verify:

```powershell
curl.exe -I "https://content-relay.pages.dev/example.webp?x=random"
```

The Location must use the backend's
`/r/content-relay.pages.dev/example.webp` path. The query-removal rule belongs
on the backend custom-domain zone; it must preserve `/r/`.

In Cividge, add and select `https://content-relay.pages.dev` under **Filebase
delivery domain**. In the KV Worker configuration, add the public hostname to
`STATIC_RELAY_PUBLIC_HOSTS` (comma-separated list, e.g. `host1.pages.dev,host2.pages.dev`)
and the backend hostname to `STATIC_RELAY_BACKEND_HOSTS` when they are not already
present, then redeploy the worker. The Worker rejects unknown relay identifiers
and performs one lookup for `content-relay.pages.dev:example.webp`; it does not
search across registered hosts.

## R2

Start from Cividge's `compatibility-layer/r2/_redirects.template`. Replace
`__R2_COMPATIBILITY_ORIGIN__` with the R2 custom domain or `r2.dev` origin,
without a trailing slash. The resulting rule must look like:

```text
/* https://media.example.com/:splat?r 307
```

The fixed `?r` replaces arbitrary incoming query strings at the static relay.
Deploy and verify the same way, then add and select the public Pages URL under
**R2 delivery domain**.

## Safety checks

- Keep the deployment directory static. A `functions/` directory changes the
  cost and attack surface.
- Never put credentials, KV bindings, or storage tokens in this project.
- Do not deploy over an existing Pages project unless the user named it or
  authorized the replacement.
- Test an actual media path before changing Cividge's selected delivery URL.
- If the user asks to publish, deploy, or alter a Cloudflare dashboard rule,
  obtain authorization at that mutation step.
