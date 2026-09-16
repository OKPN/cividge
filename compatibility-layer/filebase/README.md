# Filebase static public URL layer

This is an optional, function-free Cloudflare Pages front door for Filebase
media. It keeps the board-facing `pages.dev/file-name.ext` URL separate from
Cividge's actual Filebase delivery Worker/domain.

The relay has no JavaScript, Functions, KV binding, storage credential, CID
lookup, or file list. It only issues a `307` redirect while preserving the path.

## Create a relay project

1. Create an empty directory outside this repository, for example `filebase-public-relay`.
2. Copy `_redirects.template` into that directory as `_redirects`.
3. Replace `__FILEBASE_COMPATIBILITY_ORIGIN__` with the HTTPS origin of the
   Filebase compatibility/delivery Worker. Do not add a trailing slash. The
   worker must be configured with exactly one allowed static public hostname.
4. Deploy it to the Pages project whose `pages.dev` address you want to share
   publicly (for example, the existing `content-relay` project):

   ```powershell
   npx wrangler pages deploy filebase-public-relay --project-name=content-relay
   ```

5. Add the public `https://content-relay.pages.dev` URL through Cividge's
   **Filebase delivery-domain** list and select it. There is no per-upload
   compatibility switch.

## Verify before enabling

```powershell
curl.exe -I "https://content-relay.pages.dev/example.webp"
```

Confirm that the redirect `Location` preserves `/example.webp`, points to the
Filebase compatibility/delivery Worker, and contains the internal
`/__cividge/` marker. Add a URL Rewrite Rule on the backend domain that removes
the query string; this marker survives that rewrite and identifies the allowed
public entry to Cividge.

Changing the real delivery domain later requires updating and redeploying this
one static `_redirects` file (or updating that Bulk Redirect). File uploads do
not require relay redeployment.
