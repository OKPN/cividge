# Cividge 引き継ぎメモ

更新日: 2026-09-15

## 今回の改修

- `staging` の未コミットで壊れていた `app.js` / `index.html` は `main` と同じ内容へ戻した。
- Filebase / R2 のクラウドストレージ設定を確認し、ストレージ画面の初回セットアップを段階式にした。
  - STEP 1 は KV Worker URL と Admin API Token を実際に API へ接続して検証する。
  - 成功後だけ STEP 2 を操作できる。
  - STEP 2 は R2 または Filebase に `ListObjectsV2` を実行して認証情報を検証し、成功後だけ設定を保存する。
  - 成功・失敗を画面内のメッセージで表示する。
- 初回の配信ドメインは、KV Worker 接続成功時に Worker URL を自動登録する。
  - 既に選択済みの配信ドメインは上書きしない。
  - 独自の Pages URL / Custom Domain は任意で追加できる。
- 配信 URL は常に `配信ドメイン/ファイル名` を使う。CID を URL に露出しない。
- ファイルカードのコピーボタンで発生していた未定義関数参照を修正した。
- Filebase の同一 CID は、再アップロードせず既存の S3 実体を指す別名 URL として KV 台帳へ登録する。
  - 重複時はモーダルではなく、アップロード結果の軽い注記で知らせる。
- Filebase の一覧で、過去の Worker URL 設定不備によって KV 台帳へ登録されなかった既存オブジェクトを、取得済み CID から自己修復する。
- Worker URL にスキームがない場合でも、ブラウザがローカル相対 URL として誤解しないよう `https://` を補完する。
- 配信ドメインの案内を整理した。
  - オンボーディングでは短い説明と折りたたみ式の Pages URL 取得手順を表示する。
  - 接続後も `☁️ クラウドストレージ接続設定` 内の `配信 URL の作り方・変更方法` から参照できる。
  - `pages.dev 必須` ではなく、Worker URL も初期配信先として許可する表記に変更した。
- 外部投稿 / Windows「送る」連携を安全化し始めた。
  - 投稿専用の `UPLOAD_TOKEN` を入力する欄を追加し、管理 API トークンを流用しない。
  - URL クエリにトークンを含めない。curl と BAT は `Authorization: Bearer` を使う。
  - Worker URL または投稿トークンが未設定の場合、curl / BAT 生成ボタンを有効化しない。
  - Filebase 投稿は Worker 側の Filebase IPFS RPC API を使い、CID を KV 台帳に登録する実装を `cividge-kv-worker/upload.js` に追加した。
  - 利用前に Worker 側へ `UPLOAD_TOKEN` と `FILEBASE_IPFS_API_KEY` の secret 設定が必要。
- R2 と Filebase の配信ドメインは別々のリストと選択状態で管理する。
  - 投稿画面では各ストレージの保存ボタンに対応する配信ドメインを個別に選べる。
  - `☁️ クラウドストレージ接続設定` から、それぞれ追加・削除できる。
- ファイルの有効期限は Cloudflare KV のネイティブ TTL ではなくメタデータとして保持する。
  - 期限後の最初のアクセスで該当 URL だけを 404 にし、同じ CID の別名 URL が残る間は実体の pin を維持する。
  - 最後の URL が期限切れまたは削除された時だけ Kubo / Filebase の実体を解放する。Cron は使わない。
- 容量解放（FIFO）はストレージごとに独立している。
  - Filebase は既存の「実体を unpin して URL は維持」方式。
  - R2 は既定オフで、投稿前に上限の 85% を超えそうな時、古い R2 オブジェクトと対応する配信リンクを削除して 70% 以下へ戻す。
  - 旧「7日経過したファイルを自動削除」設定と R2 一覧の `devコピー` は廃止した。

## Pages URL を追加したい場合

Worker の `https://<worker>.<subdomain>.workers.dev` は、KV Worker の接続完了後にそのまま配信先として使える。Pages は必須ではない。

任意で `https://my-content-cache.pages.dev` のような URL を追加する場合は、`cividge` リポジトリのルートで以下を実行する。

```bash
npx wrangler login
npm install
npm run build
npx wrangler pages deploy dist --project-name=my-content-cache
```

`functions/` を含めて配備するため、Wrangler をリポジトリのルートで実行すること。出力された Pages URL をクラウドストレージ設定の「画像の公開・配信 URL」に追加する。

## 他者へ配布する場合の注意

- `cividge`（フロントエンド / Pages Functions）と `cividge-kv-worker`（KV 台帳・配信 Worker）の2リポジトリが必要。
- 利用者ごとに自分の Cloudflare KV Namespace、Worker、R2 / Filebase 認証情報を使う前提。
- 両リポジトリの `wrangler.toml` にある `IPFS_KV` binding は、利用者自身の KV Namespace ID に変更する必要がある。
- `ADMIN_API_TOKEN` は `npx wrangler secret put ADMIN_API_TOKEN` で Worker の秘密情報として設定する。Git にコミットしない。
- Admin API Token はブラウザから KV 台帳を管理する権限を持つ。共通 Worker と共通トークンを他人へ配布しない。共有サービス化するなら、別途ユーザー認証とテナント分離が必要。

## 検証

- `node --check app.js`
- `git diff --check`
- `npm run build`

はいずれも今回の変更後に成功している。
