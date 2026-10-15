# Cividge 配信・キャッシュ運用ガイド

この文書は現行の **Worker-backed Cividge delivery** 向けです。Cloudflare側のルールはWorkerのLink期限、パスワード、`?preview=1`、404/503の区別を壊さない範囲で設定します。[Cloudflare Cache Rulesの公式説明](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/)も確認してください。

## 1. 配信境界

- **通常メディア：** 公開GETはcanonical `host:filename` のKV projectionを一回参照します。KV missなら404ですが、KV障害や既知Linkのorigin障害は404と同一視しません。
- **動画preview：** `?preview=1` は同じ親Linkの**別表現**です。元動画と異なる `image/webp` を返し、別の公開Linkではありません。Workerはpreview応答を `no-store` にしています。
- **relay：** 静的Pages入口は `/r/<relay-id>/<filename>` をWorkerへ渡します。`/r/` はrouting/security namespaceで、relay-idと公開hostの対応が必要です。
- **権限：** パスワード付き応答や管理APIを共有public cacheへ昇格させません。管理用tokenをURLや公開cache keyへ含めないでください。

## 2. Cloudflare cache ruleを設定する場合

Password/cache hardening後は、Worker ingressの `/r/` 等について、認証や期限チェックより前に返す外側のshared cacheをbypassしてください。本文はWorker内Cache APIで現在のKV observationを確認した後に再利用します。運用上の確認項目、POST Rate Limit条件、即時失効を保証できない範囲は [Password/cache audit](PASSWORD_CACHE_BOUNDARY_AUDIT.md) にまとめています。Dashboard設定の適用はソースだけでは確認できません。

旧手順の「**全メディアURLでクエリ文字列を一律無視し、すべてをcache対象にする**」設定は使わないでください。`/video.mp4` と `/video.mp4?preview=1` を同じcache entryへ潰すと、動画の代わりにWebPが返るか、その逆が起こり得ます。Cloudflareの[cache key設定](https://developers.cloudflare.com/cache/how-to/cache-keys/)ではqueryの扱いを選べますが、CividgeではまずWorker応答のcache headerを尊重し、previewを元メディアの共有cacheへ混ぜないことが先です。

1. ルールの対象hostとpathを限定します。`/api/`、管理、認証、`?preview=1`、エラー応答を無条件の「Cache Everything」に含めないでください。
2. `Cache-Control` / `Cloudflare-CDN-Cache-Control` の `no-store` とWorkerが割り当てたedge TTLを上書きしないでください。`BOARD`、`PUBLISHED`、origin safety cap、Link残存期間はWorker側のpolicyです。
3. 既存のzone purge設定がある場合は、その有無によって `BOARD` のWorker TTLが変わります。ルール変更後は削除済みURLが古い200を返さないか確かめてください。
4. キャッシュバスター対策が必要なら、representationを変えるqueryを保持またはbypassし、無意味なqueryだけを正規化する方針を検討します。Cloudflare planごとに利用できるcustom cache keyの選択肢が異なるため、実際のプランで使える設定を確認してください。

## 3. 最低限の確認

実在する、パスワードなしの動画Linkで次を比較します。`-I` だけで挙動が違う場合は通常のGETでも確認してください。

```bash
curl -I "https://<delivery-host>/video.mp4"
curl -I "https://<delivery-host>/video.mp4?preview=1"
curl -I "https://<delivery-host>/missing.mp4"
```

- 元動画は動画のcontent type、previewは `image/webp` を返すこと。`?preview=1` が動画本体や古い404として返らないこと。
- 存在しないLinkの404と、既知Linkの一時的なorigin/KV障害を同一の長期404 cacheへ混ぜないこと。
- `BOARD` と `PUBLISHED` のTTLが期待どおり異なり、Link期限を越えないこと。
- relayを使う場合、redirect先が `/r/<その公開hostを表すrelay-id>/...` であること。別の登録済みrelay経由での200は接続合格ではありません。

この確認はcache hit率や費用の保証ではありません。公開する前に通常ブラウザで動画再生・thumbnail・削除反映も確認してください。
