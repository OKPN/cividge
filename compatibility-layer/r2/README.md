# R2 static public URL layer

This function-free Cloudflare Pages project provides a board-facing
`pages.dev/file-name.ext` URL for an R2 delivery domain. It returns a `307`
redirect, keeps the path, and replaces arbitrary incoming query strings with
the short fixed `?r` marker before the request reaches the R2 origin.

It has no Functions, KV binding, or storage credentials.

## Deploy

1. Copy `_redirects.template` to an empty directory as `_redirects`.
2. Replace `__R2_COMPATIBILITY_ORIGIN__` with the R2 custom domain or `r2.dev`
   origin that already serves the bucket. Do not add a trailing slash.
3. Deploy the directory as its own Pages project:

   ```powershell
   npx wrangler pages deploy r2-public-relay --project-name=r2-content-relay
   ```

4. Add `https://r2-content-relay.pages.dev` to Cividge's **R2 delivery domain**
   list and select it. It then becomes the public URL for R2 uploads and copies.

## Verify

```powershell
curl.exe -I "https://r2-content-relay.pages.dev/example.webp?x=random"
```

The `Location` header must preserve `/example.webp`, point to the R2 origin,
and contain only `?r` rather than the incoming query.
