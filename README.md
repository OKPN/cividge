# Cividge

ローカル変換、Cloudflare R2、Filebase/IPFS、Cloudflare Edge を組み合わせた、個人向けメディアアップローダー兼配信管理アプリです。画像変換はブラウザ内で完結し、R2 または Filebase へ直接アップロードします。

![Cividge architecture](docs/assets/cividge-architecture.png)

## できること

- ブラウザ内での画像変換（WebP / JPEG / JPEG XL）とメタデータ確認
- Cloudflare R2 または Filebase (IPFS) への S3 API 直接アップロード
- `配信ドメイン/ファイル名` 形式の共有 URL、別名 URL、配信ドメインごとの管理
- Cloudflare Edge / Workers KV による URL 解決、期限、パスワード保護、OGP、Range 配信
- Filebase の同一 CID を再アップロードせず、別名 URL として登録
- Filebase FIFO 容量解放と、任意の Kubo ノードへの Pin 保全
- Windows の「送る」および外部投稿 API（任意）

## 構成

| 層 | 役割 |
| --- | --- |
| Cividge Pages | ブラウザ UI、ローカル変換、R2 / Filebase への直接アップロード |
| KV 配信・管理 Worker | URL と実体キー/CIDの台帳、別名、期限、パスワード、配信処理 |
| Cloudflare Edge | キャッシュ、OGP 応答、配信時の負荷軽減 |
| Cloudflare R2 | 通常のオブジェクトストレージ |
| Filebase / IPFS | CID ベースの IPFS 保存 |
| Kubo（任意） | Filebase 解放前の CID を自 PC / サーバーにも Pin する保全ノード |

Kubo は CID 実体を保持する保全ノードです。Kubo RPC は Pin 操作用であり、単独で公開配信の第1オリジンになるものではありません。

## 導入の全体手順

このアプリは、フロントエンドの `cividge` と配信・台帳 Worker の `cividge-kv-worker` を組み合わせて使います。

1. Cloudflare で Workers KV Namespace を1つ作る
2. `cividge-kv-worker` にその Namespace を紐付け、秘密情報を設定してデプロイする
3. `cividge` に同じ Namespace を紐付け、Cloudflare Pages へデプロイする
4. Pages を開き、最初に KV Worker、次に R2 または Filebase を接続する
5. R2 を使う場合はバケット CORS を設定する

## 前提条件

- Node.js 18 以降
- Cloudflare アカウント
- Wrangler CLI（`npx wrangler` で利用可能）
- 利用する保存先: Cloudflare R2 または Filebase IPFS Bucket

## 1. KV 配信・管理 Worker をデプロイする

```bash
git clone https://github.com/OKPN/cividge-kv-worker.git
cd cividge-kv-worker
npx wrangler login
```

Cloudflare Dashboard または Wrangler で Workers KV Namespace を作成し、その ID を `wrangler.toml` の `IPFS_KV` binding に設定します。

```toml
[[kv_namespaces]]
binding = "IPFS_KV"
id = "<your-kv-namespace-id>"
```

次に管理用トークンを設定して Worker をデプロイします。トークンは十分に長いランダム値を使い、リポジトリへ保存しないでください。

```bash
npx wrangler secret put ADMIN_API_TOKEN
npx wrangler deploy
```

表示された `https://<worker>.<account>.workers.dev` を控えます。これが Cividge の KV 配信・管理 Worker URL です。

### 外部投稿 API を使う場合だけ

Windows の「送る」や curl 投稿を使う場合は、管理トークンとは別に投稿専用トークンを設定します。

```bash
npx wrangler secret put UPLOAD_TOKEN
```

Worker 経由で Filebase 投稿も行う場合のみ、Filebase の bucket-scoped IPFS RPC API key を追加します。

```bash
npx wrangler secret put FILEBASE_IPFS_API_KEY
```

`UPLOAD_TOKEN` は外部投稿クライアント専用です。`ADMIN_API_TOKEN` を BAT や curl に流用しないでください。

## 2. Cividge を Cloudflare Pages へデプロイする

```bash
git clone https://github.com/OKPN/cividge.git
cd cividge
npm install
npx wrangler login
```

Worker と**同じ** Workers KV Namespace ID を、このリポジトリの `wrangler.toml` に設定します。

```toml
[[kv_namespaces]]
binding = "IPFS_KV"
id = "<your-kv-namespace-id>"
```

ビルドして Pages へデプロイします。

```bash
npm run build
npx wrangler pages deploy dist --project-name=my-cividge
```

表示された `https://my-cividge.pages.dev` がフロントエンド URL です。以後、この URL を R2 CORS の許可 Origin に使います。

ローカル確認だけなら、ビルド後に次を使えます。

```bash
npm run preview
```

## 3. アプリで初期接続する

Pages を開くと、設定は次の順番で表示されます。

1. **KV 配信・管理 Worker**: Worker URL と `ADMIN_API_TOKEN` を入力して接続テスト
2. **Cloudflare R2** または **Filebase (IPFS)**: 保存先の認証情報を入力して接続
3. 各保存先に専用の配信ドメインを登録

初期配信先には Worker URL を使えます。任意で Pages URL や独自ドメインを追加できます。

> R2 と Filebase に同じ配信ドメインを登録しないでください。URL が `配信ドメイン/ファイル名` であるため、同名ファイルの保存先を区別できなくなります。

## Cloudflare R2 の設定

Cloudflare Dashboard で R2 Bucket と S3 API Token を作成し、以下を Cividge の **Cloudflare R2** 設定へ入力します。

- Cloudflare Account ID
- R2 Bucket Name
- Access Key ID
- Secret Access Key

### R2 CORS は必須

このアプリはブラウザから R2 S3 API を直接呼ぶため、R2 Bucket の CORS Policy にフロントエンド URL を許可する必要があります。

Cloudflare Dashboard → R2 → 対象 Bucket → **Settings** → **CORS Policy** → Edit で、アプリ内の「CORS 設定をコピー」から取得した内容を貼り付けます。

基本形は次のとおりです。`https://my-cividge.pages.dev` は実際にアプリを開く URL に置き換えてください。これは配信ドメインではありません。

```json
[
  {
    "AllowedOrigins": [
      "https://my-cividge.pages.dev",
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "HEAD", "PUT", "DELETE"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

## Filebase / IPFS の設定

Filebase で IPFS Bucket と S3 Access Key / Secret Key を作成し、**Filebase (IPFS) / Kubo** 設定へ入力します。

- Filebase Bucket Name
- Filebase Access Key
- Filebase Secret Key
- Filebase 専用配信ドメイン

接続後に **⚙️ CORS自動設定** を一度実行してください。ブラウザから CID を取得するための必要な CORS 設定を Bucket に適用します。

Filebase では同一 CID の再アップロードを避けます。同じ実体を別名で投稿した場合は、実体を増やさず、新しい名前の URL を既存 CID へ紐付けます。

## 任意: Kubo を保全ノードとして使う

Kubo をインストール・起動し、通常は `http://127.0.0.1:5001` を Cividge の Kubo RPC URL に設定します。接続テストに成功してから「Filebase容量解放時にKuboへ自動Pin留め」を有効にしてください。

- Filebase FIFO は、Kubo 自動 Pin が有効で Kubo に接続できない場合、安全のため実体を解放しません。
- Kubo の保存先と空き容量を確認してください。重要なデータは別バックアップや Pin サービスにも残してください。
- Kubo API を `0.0.0.0:5001`、ルーターのポート開放、一般公開リバースプロキシで公開しないでください。
- 外出先から操作する必要がある場合は、Tailscale Serve などで Tailnet 内だけに公開した HTTPS endpoint を使います。

## 配信・期限・削除の挙動

- 共有 URL は CID を含めず、`配信ドメイン/ファイル名` を使います。
- 動画の OGP 用 `.thumb.webp` は派生データとして保存され、一覧には出ません。動画実体を削除したときだけ一緒に削除されます。
- リネームや同一 CID の別名 URLでも、動画 OGP は元サムネイルを参照します。
- 有効期限は Cron で一括削除しません。期限後の最初のアクセス時にその URL を 404 化します。同じ CID の別名 URL が残る間は、実体の Pin を維持します。
- Filebase FIFO は実体を解放して URL を IPFS 配信へ移します。R2 FIFO は古い R2 オブジェクトと対応リンクを削除します。

## セキュリティ上の注意

- R2 / Filebase S3 認証情報はブラウザの localStorage に保存されます。自分で管理する端末・信頼できる Pages URL だけで使ってください。
- `ADMIN_API_TOKEN` は台帳を読み書きできる管理権限です。共有 Worker や共有トークンを他者へ配布しないでください。
- パスワード保護は Cividge の配信 URL を保護しますが、IPFS CID を知る相手の IPFS ゲートウェイ経由アクセスまでは秘匿しません。強い秘匿が必要なファイルには、将来のクライアント暗号化モードが必要です。
- 投稿用 `UPLOAD_TOKEN` は管理トークンと分け、BAT ファイルを他人へ渡さないでください。

## 開発

```bash
npm install
npm run build
npm run preview
```

## 関連リポジトリ

- [cividge-kv-worker](https://github.com/OKPN/cividge-kv-worker): 配信・台帳・キャッシュ管理 Worker

## License

MIT License © 2026 OKPN
