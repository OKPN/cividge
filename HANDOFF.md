# Cividge 引き継ぎメモ

更新日: 2026-09-17

## 今回の改修

- **S3削除用 墓標キュー（Tombstone Queue）による実体消し漏れの根絶**:
  - **背景・原因**: 有効期限が切れたURLに管理画面を開く前にアクセスがあると、WorkerがKV台帳からキーを即時削除して404化するが、WorkerはS3秘密鍵を持たないためS3実体を削除できず、さらにKVからメタデータ（`expiresAt`）が消えることでその後の管理画面でも期限切れと検知されずS3実体が取り残される問題があった。
  - **対策（Worker / Pages 配信層）**:
    - `cividge-kv-worker/delivery.js` および `functions/_middleware.js` において、最後のリンクが期限切れになった際、KV台帳に S3削除用墓標 `tombstone_s3_<s3Key>`（TTL: 30日）を自動登録するよう改修。
    - API（`functions/api/ipfs-kv.js` / `cividge-kv-worker/ipfs-kv.js`）に `?tombstones_s3=1`（一覧取得）および `?tombstone_s3=<s3Key>`（消去）を実装。
  - **対策（管理画面フロントエンド層）**:
    - `app.js` に `drainS3Tombstones(s3, bucketName)` を実装。一覧取得時（`fetchAndRenderR2Files`）に自動実行。
    - 墓標キューを検出し、ブラウザが保持する S3 クライアントで Filebase S3 から実体および動画サムネイルを `DeleteObjectCommand` / `DeleteObjectsCommand` で安全に完全消去した上で墓標をクリア。
    - これにより、論理削除の即時性（アクセス時即404）とローカルファーストの安全性（S3鍵のクライアント保持）を完全両立しつつ、S3実体も100%自動回収されるパイプラインを確立。

- **Filebase アンピン（実体削除）時の注意書き明記とツールチップ追加（案A対応）**:
  - **背景**: Filebase 実体を削除（アンピン）すると、ブラウザ側メモリにファイル実体がないため「再度ボタン一つでFilebaseに復元する」ことはできず、再度保管するには元ファイルの再アップロードが必要となる。Kuboが双方向トグル可能なのに対し、Filebaseは一方通行のため、誤解や誤操作を防止するUX改善を実施。
  - **確認ダイアログの親切化**: アンピン確認ダイアログに「⚠️ ※元ファイルを再度アップロードするまで、Filebase への再保管は行えません」の注記を追加（日英両対応）。
  - **ツールチップの追加**: アンピン後のグレーバッジ（`☁️ Filebase: 未保持`）にホバー時の説明ツールチップ（`title` 属性）を付与。

- **有効期限切れファイルのS3実体クリーンアップとゾンビ化（再登録）の根絶**:
  - **背景・原因**:
    - 期限切れで KV 台帳からキーが失効・非表示になっても、Filebase S3 側に実体オブジェクトが残っていた。
    - 2026年9月15日に追加された「未登録ファイルを救済する古いコード（`app.js:6877`）」が、S3 に実体があるのに KV がないファイルを迷子と誤認し、管理画面を開いた瞬間に現在選択中の初期ドメイン（`content-relay.pages.dev` 等）かつデフォルトTTL（1時間）で `registerKvCid` を勝手に呼び出して再登録（ゾンビ化）していた。
  - **修正内容① 期限切れ時のS3実体・サムネイル自動消去 (`cleanupExpiredStorageItems`)**:
    - 期限切れアイテムを検出した際、同一CIDの別名リンク（`hasSibling`）が残っていない「最後のリンク」であれば、KV台帳の削除だけでなく S3 実体および動画サムネイル（`DeleteObjectCommand` / `DeleteObjectsCommand`）も同時に安全に完全消去する処理を実装。
    - 一覧取得時（`fetchAndRenderR2Files`）に期限切れアイテムを検知した時点で、バックグラウンド非同期で `cleanupExpiredStorageItems` を自動実行。
  - **修正内容② 古い自動救済コードの完全撤去**:
    - カード生成時（`renderCurrentStoragePage`）に未登録S3アイテムを勝手にKV登録してしまう古い自動修復ブロックを完全に撤去。
    - S3からCIDを遅延解決する処理（`resolveCidInBackground` 付近）にも `&& item.rawKey`（既存KVレコードがある場合のみ更新）のガードを追加。
    - これにより、意図しない再登録や有効期限切れファイルのゾンビ化を完全に根絶。

- **Kubo Pin せっかち防止（離脱・リロードガード）と KV 台帳自己修復（Auto-Heal）機構の導入**:
  - **背景・原因**: Kubo への手動 Pin やアンピン時、バックグラウンドで P2P 同期（ダウンロード）中にユーザーが焦ってページを再読み込み（F5 等）すると、ブラウザの HTTP 接続切断やメモリ上のポーリングタイマー消滅により、Kubo 側で Pin が完了しても KV 台帳（`kuboStatus: pinned`）に反映されず「未保持」のまま取り残される問題があった。
  - **防止策① 離脱・リロードガード (`beforeunload`)**:
    - `activeKuboPins = new Set()` で実行中の Pin タスクを CID 単位で追跡。
    - Pin 同期中は `window.addEventListener("beforeunload", ...)` でブラウザの離脱・リロード確認ダイアログを表示し、不用意な切断を未然に防止。
    - 同期完了、エラー、または 3 分のタイムアウト時にガードを安全に自動解除。
    - 同期開始時のアラートにも「※ P2P同期中はページを更新（リロード）せずそのままお待ちください」の注記を追加。
  - **防止策② KV 台帳の自己修復機構 (`Auto-Heal / Reconciliation`)**:
    - たとえ警告を無視してリロードされたり通信切断が発生した場合でも、次回の一覧表示時に Kubo から最新の Pin 一覧（`getKuboPinnedCids`）を取得。
    - 「Kubo 側に Pin 実体が存在するが、KV 台帳の `kuboStatus` が `pinned` でないレコード」を自動検知し、非同期バックグラウンドで `registerKvCid(..., 'pinned')` を呼び出して KV 台帳を整合させる。
    - 画面描画はブロックせず即座に「🏠 Kubo: 保持中」バッジが復元されるため、UI の快適性を損なわず台帳を修復可能。

- **静的 Pages リレー（307 Relay）の複数ホスト共存対応**:
  - `STATIC_RELAY_PUBLIC_HOSTS` に複数ホスト（カンマ区切り）を登録した際、`delivery.js` の `length === 1` ハードコードにより全リレーが 404 になる不具合を修正。
  - `/r/` リクエスト受信時、登録された全許可 Pages ホストを自動探索して KV 台帳の `<host>:<filename>` を解決するロジックへ刷新。
  - 単体キー形式（`allowedHost` メタデータ保持）のファイルでも、アクセス元のリレーと安全に照合できるようフォールバックを修正。
  - これにより `content-relay.pages.dev` を維持したまま `testunko.pages.dev` など任意のアドレスを安全に並行運用・追加可能にした。

- Civitai Gallery のクリエイター選択では、内部状態の `__ALL__` / `__NEW__` を利用者名として保存・表示しない。
  - 上部の「すべて（新着順）」と「新着のみ」だけを特別項目として残す。
  - 旧 localStorage に混入した予約名は、次回読み込み時にクリエイター一覧から自動除去する。
  - `app.js` の `getCivitaiUserList()` がこの互換クリーニングの責務を持つ。

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
- パスワード付き配信の安全性を強化した。
  - KV 管理 API の読取・一覧は Admin API Token を必須にし、公開 URL からパスワード hash / salt / セッション情報を取得できないようにした。
  - 新規投稿では平文パスワードや固定 `sessionSecret` を KV に保存しない。
  - 成功した認証には、パスワード hash を鍵にした 1 時間の署名 Cookie（`HttpOnly; Secure; SameSite=Lax`）を使う。
  - 旧レコードの平文パスワードは互換認証だけ残るため、重要な既存ファイルはパスワードを再設定して新メタデータへ移行する。
  - IPFS/Filebase の CID 実体そのものは公開網から読めるため、これは配信 URL のゲートであり、秘匿が必要な用途には将来のクライアント暗号化モードが必要。
- Pages の旧外部投稿 API も、投稿 token 未設定時は拒否し、クエリ文字列 token を受理しない。Worker / Pages の投稿上限は 80 MiB。
- Civitai のリダイレクト解決 API は HTTPS の `*.civitai.com` のみに制限した。
- 接続設定画面は責務ごとに分離した。
  - `⚡ Cloudflare R2`: R2 接続情報、R2 専用配信ドメイン、CORS、FIFO。
  - `🪐 Filebase (IPFS) / 🏠 Kubo`: Filebase 接続情報・配信ドメイン・CORS と、任意の Kubo 保全ノード。
  - `📚 KV 配信・管理 Worker`: Worker URL / Admin API Token と、両ストレージ共通の配信台帳。
  - 既存の入力 ID と localStorage の保存形式は維持している。
- `README.md` を導入・運用ドキュメントとして整理し、構成図を `docs/assets/cividge-architecture.png` に追加した。
- 動画から生成する `.mp4/.webm/.mov.thumb.webp` は OGP 専用の派生データとして扱う。
  - 一覧・URL パレットには表示しないが、容量計算には含める。
  - 動画のリネーム、同一 CID の別名 URL、別配信ドメインの URL は、台帳の `thumbnailKey` を通じて元のサムネイルを参照する。
  - 動画実体を削除する時はサムネイルも同時に削除する。別名 URL だけを削除する場合は残る。
  - サムネイルには親動画と同じ有効期限を記録し、Filebase FIFO でも親動画と一緒にだけ回収する。

### 静的リレー（307 Relay / 推奨・無料無制限）を追加する場合

関数（Functions）を使わず、Wrangler で静的 `_redirects` のみを配備して公開アドレスを取得する場合：

1. 空フォルダに `_redirects` を作成（例: `/* https://ipfs-relay.k7m.f5.si/r/:splat 307`）。
2. `npx wrangler pages project create <プロジェクト名> --production-branch main` でプロジェクト作成。
3. `npx wrangler pages deploy <フォルダ> --project-name=<プロジェクト名>` でデプロイ。
4. `cividge-kv-worker/wrangler.toml` の `STATIC_RELAY_PUBLIC_HOSTS` にカンマ区切りで追加し、Worker を再デプロイ（`npx wrangler deploy`）。
   - 複数ホスト登録時も Worker 側で自動探索されるため、何個でも安全に追加可能。
5. Cividge 画面の「Filebase 配信ドメイン」に取得した `https://<プロジェクト名>.pages.dev` を登録・選択。

#### 💡 [次回改修メモ・改善案] オンボーディング画面（UI）の案内簡略化
現状、オンボーディング画面（`app.js: L5972` 付近）の「公開用 pages.dev リレーを作る」説明で `git clone https://github.com/OKPN/cividge.git` を案内しているが、リポジトリ全体の clone は不要（牛刀）。
利用者のハードルを下げるため、次回改修時に以下の「空フォルダ＋1行デプロイ」の案内にシンプル化すると良い：
- **手順1**: 適当な空フォルダを作り、`_redirects` ファイルを作成（Filebase: `/* https://<裏Worker>/r/:splat 307` / R2: `/* https://<裏R2>/:splat?r 307`）。
- **手順2**: ターミナルで `npx wrangler pages project create <名前> --production-branch main` ➔ `npx wrangler pages deploy <フォルダ> --project-name=<名前>` を実行。
- **手順3**: 生成された `https://<名前>.pages.dev` を入力欄に登録。
*(※ これにより、Git の知識がない一般ユーザーでも 1 分で迷わず看板アドレスを作成可能になる)*

#### 🚨 [要対応・次回改修メモ] 期限切れファイルの自動ゾンビ化（別ドメイン・新規TTLでの意図しない再登録）バグと改修方針
- **現象**:
  `misskey-media` や `okpn.f5.si` などの別ドメインで 24 時間期限付きでアップロードされた動画が、期限切れを迎えた後、現在の初期配信ドメイン（`content-relay.pages.dev`）に書き換わり、有効期限も 1 時間で新規再登録されて配信が続行されてしまう。
- **根本原因**:
  1. KV 台帳側では 24 時間経過により期限切れ判定となり、古いドメインの台帳レコードが正常に失効（非表示/削除）した。
  2. しかし、Filebase S3 バケット上には、FIFO 容量解放（85%上限）が発動するまでファイル実体がそのまま残っていた。
  3. 管理画面を開いた際、`app.js:6877` にある「未登録ファイルの自動自己修復機能（以前の Worker 設定不備ファイルを救済する古いコード）」が作動。S3 に実体があるのに KV 台帳が見当たらないため、「未登録の迷子ファイル」と誤認。
  4. 一覧描画時に裏で勝手に `registerKvCid` を呼び出し、現在選択されている初期ドメイン（`content-relay.pages.dev`）かつデフォルト TTL（1時間）で台帳に新規再登録（ゾンビ化）してしまっていた。
- **改修方針（直し方の目処）**:
  - **方針1（最善・確実）: S3 メタデータの `expires-at` を確認して自動登録を除外**
    `app.js:6903` の `HeadObject` で取得できる S3 メタデータ `expires-at` を参照し、過去の時刻（期限切れ）であれば「意図的な期限切れファイル」として自動再登録を絶対にスキップする（または S3 からも DeleteObject する）。
  - **方針2: `app.js:6877` の「勝手な自動修復」の廃止または明示化**
    一覧を開くだけで裏で勝手に `registerKvCid` を呼ぶおせっかい動作を停止し、ユーザーが意図して操作した時のみ登録できるように制限する。
  - **方針3: 配信 Worker（`delivery.js`）の `cleanupExpiredAlias` での実体消去**
    期限切れアクセス時に KV キーを削除する際、他に同一 CID の別名リンクがなければ、Filebase S3 からも `DeleteObjectCommand` を送って実体ごと完全に消去する（実体が残らないため迷子検出も起きない）。

### フロントエンド（Functions含む全体）を Pages に追加・再配備する場合

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
