# Cividge 引き継ぎメモ

---

## 🔧 コードレビュー指摘の修正記録 (2026-11-12、実施済み・未デプロイ)

### 出典と検証結果
* 2026-11-12 に Muse が両リポジトリを通読レビューした指摘（詳細は Muse ワークスペースの `cividge-review/CODE_REVIEW.md`、P0 1件 / P1 5件 / P2 12件 / 観察 16件）への修正。優先順位は リスク × 外部露出 × 修正範囲の閉じ具合 で決定し、下記 1〜7 位と P2 群の大半を実施した。
* **本番未デプロイ**: 修正は両リポジトリともローカル commit 済み・未 push・未デプロイ。特に 1 位のプロキシ修正は Pages へデプロイするまで本番（cividge.pages.dev）では有効にならない。本番では修正前に `GET /i/<CID>` が `Content-Type: text/html` を inline・CSP 無しで返すことを実測確認した。
* 検証 (host01 実機): Frontend は `npm ci` 成功、テスト **118/118** 成功、production build 成功。Worker はテスト **109/109** 成功。

### `functions/i/[[path]].js` IPFS プロキシの無力化 — commit `13aef71`
* なぜ必要だったか: 無認証で任意 CID を中継するプロキシが、アプリ本体（localStorage に S3 シークレットキー・Admin Token・UPLOAD_TOKEN を保持）と同一 origin に同居し、上流 Content-Type を透過、SVG は inline、HTML は素通り、CSP 無しだった。悪意ある HTML/SVG を開かせるとアプリ origin のスクリプトとして実行され、秘密一式が読める XSS 経路になる。
* どう直したか: 全応答に `Content-Security-Policy: default-src 'none'; sandbox` を付与（スクリプト実行と同一オリジン権限を剥奪）。Content-Type は mimeMap のメディア種別と安全な image/video/audio 種別だけを許可し、それ以外は `application/octet-stream` + attachment に倒す（上流の text/html を透過しない）。エラー応答にも CSP を付与。恒久対応としての別 origin 分離は未実施（デプロイ構成の判断が要るため）。

### R2 配信の Range 対応 — Worker commit `a12828a`
* なぜ必要だったか: R2 分岐は Range を無視し常に 200 で全量を返していた（`Accept-Ranges` の宣言のみ）。R2 上の動画/音声がシークできず、README の 206 主張とも矛盾した。
* どう直したか: `delivery.js` に `parseBytesRange` を追加し、R2 `get` へ range を渡して 206 + `Content-Range` を返す。範囲外は head で実在確認のうえ 416。Range リクエストは全量キャッシュのヒット対象から外した（保存側は元々 200 のみ保存）。新規テスト `test/delivery-range.test.js` 5件で境界を固定。

### 拡張子ホワイトリストの一本化 — Worker commit `3cd66ca`
* なぜ必要だったか: アップロード側 ALLOWED_EXTS のアーカイブ系（zip/7z/rar/tar/gz）は配信側に無く「成功するが常時 404」のファイルが作れた。未知拡張子は黙って `.webp` に化けた。なお kv-worker README は「アーカイブ形式は origin defense のため設計としてブロック」と明記しており、配信側と README が正本、アップロード側が漂流していた。
* どう直したか: README の設計に合わせ、アップロード側からアーカイブ系を外して配信ホワイトリストと集合を一致させた。未知・未許可の拡張子は `.webp` 化せず HTTP 400 で明示的に拒否する。拒否テストを `test/upload-auth.test.js` に追加。

### Admin Token の監査・コード・テスト三者一致 — commit `9bc2343`
* なぜ必要だったか: 監査文書は「secret を value 属性へ埋め込まない」と主張する一方、`app.js` のオンボーディングは Admin Token を innerHTML の `value` 属性に埋め込み、境界テストがそれを仕様として固定化していた。
* どう直したか: `obAdminToken` 入力から value 属性を外し、他の秘密欄と同じく描画後の `.value` 復元のみに統一（復元ループには元々含まれていた）。境界テストを「属性に含まれないこと＋ `.value` で復元されること」の検証へ反転させた。これで監査文書の記述が実態と一致する。

### purge Plan B の決着 — Worker commit `f03a2d4`
* なぜ必要だったか: 配信バイトは `__cividge_projection=<指紋>` 付き内部キーで保存されるが、`purgeHybridCache` は指紋なしキーで delete していたため永遠に一致せず、purge できるという前提が崩れていた（ハーネスで実測再現済み）。
* どう直したか: 方式 (b) を採用し Plan B を撤去した。Worker Cache API のエントリは KV の現行射影を観測してからでなければ到達できず、削除・再登録はフィンガープリントの変化で構造的に無効化されるため、個別 delete は不要という設計をコード内コメントに明記。公開 URL の CDN 層は Zone REST purge が引き続き best-effort で担う。あわせて到達不能だった KV 直収納（backend="kv" / blob_）の配信分岐と、受け取るだけで保存されない `dataBase64` フィールドも撤去した。

### R2 FIFO の無言無効化への警告 — commit `52e56c1`
* なぜ必要だったか: `kuboAutoPinR2=false` の組合せでは解放候補があっても解放ループが全件 skip され、ログも出ず「FIFO が効かない理由が分からない」状態だった。
* どう直したか: 設計判断として「Kubo 保全なしでは解放しない」は維持し、この組合せで候補がある場合は保留した旨と有効化手順を明示的に警告ログへ出すようにした。テストを `test/capacity-execution.test.js` に追加。

### Windows 専用依存の optional 化 — commit `43a89d4`
* なぜ必要だったか: `@rollup/rollup-win32-x64-msvc` が通常の dependencies にあり、Linux では `npm ci` が EBADPLATFORM で失敗した（実測済み）。
* どう直したか: `optionalDependencies` へ移動。効果は両方向で実測: Linux で `--force` 無しの `npm ci` が成功しテスト 118/118、Windows (host01) でも `npm ci`・build が従来通り成功する。

### 実施分
* `app.js` の未定義変数 `addRes`（Kubo 成功アラート）: 実バイトから算出した `realCid`（無ければ検証済み `cid`）を表示するよう修正 — commit `9bc2343`（Admin Token 修正と同じ app.js のコミットに含む）。
* `putR2Upload` のバッファ経路の customMetadata 欠落（`contentCid` キー違い＋ `object-id` 欠落で同一性検証が必ず失敗）: 他経路と同じ形へ統一 — Worker commit `3cd66ca`。
* `upload.js` の死んだストリーミング経路（`uploadStreamToFilebase` / `createFilebaseMultipartStream` / `streamBufferedBytes`、常時 null の `fileStream`）と、計算だけして捨てていた PBKDF2 `passwordMeta` を撤去 — Worker commit `3cd66ca`。
* 到達不能な「スマートエイリアス」成功経路（`upload/upload-orchestrator.js`、管理者では managedPlan が必ず非 null、非管理者では重複検出後に例外終了のため到達不能を検証済み）: 検出と明示エラーだけを残し撤去 — commit `6f95dca`。
* 未使用依存 `hono` を Worker から除去 — Worker commit `2ca21cd`。`server.js` の永遠に false な条件（`startsWith("/api/upload?")` 等）を整理 — Worker commit `3cd66ca`。期限コメントの陳腐化（delivery が削除するという旧記述）を SPEC 不変条件 8 に合わせて修正 — Worker commit `f03a2d4`。

### 見送り分（理由付き）
* KV メタデータの read-modify-write 競合（syncLifecycleProjection × 登録 POST）: KV には CAS が無く根本対策には DO 側マージ設計が要る。射影は次回同期で自己回復し、正本は DO / LinkBinding にあるため、実害は一時的な投影ずれに限ると判断し見送り。
* IPFS ゲートウェイ failover の最悪レイテンシ（候補×GW×6秒の直列試行）: 全体デッドラインの導入は配信ホットパスの設計変更を伴うため別途検討。
* 管理 API 経由の「報告のみで Placement RELEASED 化」: admin 信頼境界内の誤操作リスクであり、actuator 実行証明の設計判断が要るため見送り。
* 動画プレビュー（?preview=1）の常時 no-store: 非保護 Link のプレビューをキャッシュするには射影フィンガープリント方式への統合が要るため見送り。

---
## 🌊 IPFS漂流・最後の保存先解放の現行仕様 (2026-11-03)

### 決定事項
* **最後の管理Placementの手動解放**: Linkが残るObjectの最後の`PRESENT` Placementは、通常の自動/FIFO解放では外さない。利用者が保存先バッジから手動で外す場合だけ、他に保管完了済み保存先がないことをWorker authorityが拒否理由として返し、配信保証を失う確認後にObjectLifecycleへ明示的な`manual-drift`認可を依頼する。
* **IPFS漂流中**: Linkは有効なまま、R2/Filebase/Kuboに管理Placementがない状態を許す。URLは残るが、IPFSノードやGatewayにblockが残る間だけ配信でき、Cividgeは保持・可用性を保証しない。
* **Refresh時のGateway観測**: 管理一覧の明示Refresh後、Workerの認証済みread-only endpointが各CIDについて最大4候補（設定Kubo gateway、Filebase gateway、設定public gatewayの優先順）をprobeする。全て404なら`NOT_FOUND_FROM_CHECKED_GATEWAYS`、いずれか2xxなら`AVAILABLE`、timeout/429/5xx等を含む場合は`UNAVAILABLE`。Worker subrequest数を抑えるための候補サンプルであり、IPFS全体からの消失を断定しない。
* **自動整理なし**: Gateway未発見が何回続いてもLinkを削除・退役しない。選択した`NOT_FOUND_FROM_CHECKED_GATEWAYS`行はローカル管理一覧から一括非表示にでき、同じブラウザから再表示できる。公開Link、URL、ObjectLifecycle、Placement、KVは変更しない。

### 変更対象と確認
* Worker: `requestPlacementRelease`に明示的なlast-placement drift optionを追加。Worker APIが`reason: "manual-drift"`と確認optionの両方を確認してから既存Lifecycle state machineに渡す。Gateway probe APIはAdmin token必須、read-only/no-store、1回最大5 CID、CIDごと最大4 gateway。
* Frontend: 過去の3回失敗によるlocal ledger退役を撤去。Refresh後のみGateway observationを更新し、管理一覧に「Gateway応答あり / 確認Gatewayで未発見 / 確認できず」を表示する。
* 旧HANDOFFの「3回失敗で自動整理を必ず維持する」という記録は履歴上の古い案で、上記2026-11-03決定により廃止。古いキー`cividge_drift_fail_counts`は読み出さず、起動時に削除する。
* 確認済み: Frontend `node --test` 117件成功、Worker `npm test` 103件成功、frontend production build成功。syntax checkも両側で成功。
* デプロイ済み: frontend commit `20678af` をPages `cividge`へ反映（deployment URL `https://63810561.cividge.pages.dev`、本番URL `https://cividge.pages.dev` はHTTP 200）。Worker commit `c8d64b4` を反映（Version ID `2f796066-4fb1-4049-b964-cf11e0c05744`）。認証なしの新endpointは401/no-storeを確認。
* live delivery確認: `test-up.pages.dev/vbt0bcb8.mp4` と `punipuni-media.pages.dev/evcrt2kc.webp` がそれぞれ307で `/r/<relay-id>/...` へ到達し、最終応答200。`/r/` namespaceを維持。
* 残る手動確認: 通常の別Placement解放、最後のPlacementで警告を承認した解放、Gateway refreshの3状態表示、一覧非表示/再表示を実ブラウザで確認する。

---

## 🎯 Civitai 直リン URL の最短実体化（Zero-Hop）と正本拡張子クエリ射影 (2026-10-22)

### 1. 決定された不変条件
* **`[INV-CIVITAI-CANONICAL-DIRECT-URL]`**:
  * **Zero-Hop 原則**: `image.civitai.com` による 301 リダイレクト（CDN 射影レイヤー）を経由せず、追跡後の実体ストレージ（`blobs-b2.civitai.com`）の正規識別子へ直結すること。
  * **Deterministic Extension Projection**: バイナリ先頭のマジックナンバー判定等で確定した真の拡張子を `?.<ext>` 形式で付与すること（例: `https://blobs-b2.civitai.com/file/blobs-managed-public/00SNPXBKJY5H8R7GN3K6J1TPT0?.png`）。
  * 35% の URL 短縮（115文字 ➔ 77文字）、301 リダイレクト消滅による表示高速化、Misskey/Discord 等の SNS での確実なインライン画像展開を同時に達成。

### 2. 変更内容
1. `ui/civitai-capability.js`: `projectCivitaiDirectUrl` に `blobs-b2.civitai.com` 用のクエリ射影ロジック（`?.<ext>`）を追加。
2. `app.js`: `checkCivitaiItemWf` 内で `fetch(item.url)` 追跡後の実体 URL（`res.url`）をベースに正本拡張子を付与し、キャッシュおよびカード/パレットに短縮直リン URL を即時反映。
3. `INVARIANTS.md`: 不変条件 `INV-CIVITAI-CANONICAL-DIRECT-URL` を追加。
4. `test/civitai-capability.test.js`: 実体 URL への拡張子クエリ射影テストを追加（全 113 テスト パス）。
5. ビルドおよび Cloudflare Pages 本番環境へデプロイ完了（Commit: `b3fe5d9`）。

---


## 🎯 Civitai 直リン URL における「拡張子の正本（Authority）」と射影の整合設計 (2026-10-21)

### 1. 背景と課題（3つの構造的問題）
1. **`/api/resolve-url`（B2 リダイレクト解決）による拡張子喪失と直リン崩壊**:
   * `image.civitai.com/.../original=true/<uuid>.jpeg` をリダイレクト解決すると、転送先の `blobs-b2.civitai.com/file/blobs-managed-public/<id>` には**拡張子が存在しない**。
   * 掲示板や専ブラ（ChMate / Siki 等）は URL 末尾の拡張子でインライン展開を判定するため、拡張子が消えると直リン表示が不可能になる。
   * さらに、コピー時の非同期 `fetch` により「解決中...」のままボタン表示が戻らないバグおよび Clipboard User Activation 切れを招いていた。
2. **Civitai リスト API (`/api/v1/images`) が返す `.jpeg` は「正本」ではなく仮ラベル（不正確な射影）**:
   * Civitai に WebP や PNG を投稿しても、リスト API の `item.url` は静止画に対して一律 `.jpeg` という文字列を機械的に付与して返す（中身は `Content-Type: image/webp` 等のまま）。
   * 一方、`image.civitai.com/<account>/<uuid>/original=true/<filename>.<ext>` のルーティングは `<uuid>` のみで実体を特定しており、末尾の拡張子を `.webp` や `.png` に変えても同一の実体バイナリへ到達する。
3. **「転送時にフロントエンドへ拡張子を記憶させる案」を却下した理由（権威境界の原則）**:
   * Cividge から Civitai への転送（`intent/post`）は別タブを開く一方通行であり、Civitai 側で採番される `imageId` や `UUID` を受け取る手段がない。
   * 仮にローカルに記憶させても、別端末・直接投稿・他クリエイターの投稿には適用できず、`localStorage` に不完全な「第2の偽の正本」を作ることになるため不採用とした。

### 2. 存在論的結論：拡張子の「正本（Single Source of Truth）」はどこにあるか？
* 拡張子の唯一の正本は、API の URL 文字列でも転送前の記憶でもなく、**「Civitai ストレージ上に現に存在する実体バイナリそのもの（先頭マジックナンバーおよび `Content-Type` ヘッダー）」** にある。

### 3. 実装仕様（`ui/civitai-capability.js` & `app.js`）
1. **CORS プリフライト 301 失敗の根絶（Simple Request + Stream Prefix 読み取り）**:
   * 従来の `checkCivitaiItemWf` は `{ headers: { Range: "bytes=0-131072" } }` を付与していたため、ブラウザが `OPTIONS` プリフライトを送信し、`image.civitai.com` が `301` を返して CORS エラーで失敗していた（WebP 投稿で `🧬 WF` バッジが消えていた原因）。
   * カスタムヘッダー無しの通常の `fetch(item.url)`（Simple Request）に変更し、`res.body.getReader()` で先頭 128KB だけを読み取って即座に `reader.cancel()` することで、プリフライトを発生させず最小通信量でバイナリ先頭を取得する。
2. **実体からの真の拡張子特定と URL 射影の更新**:
   * `detectCivitaiMediaExtension(bytes, contentType)`: 先頭バイトのマジックナンバー（`RIFF..WEBP`, `PNG`, `FF D8 FF`, `ftyp` 等）を第1優先、`Content-Type` を第2優先として真の拡張子（`webp`, `png`, `jpeg`, `gif`, `avif`, `mp4`, `webm`）を決定。
   * `projectCivitaiDirectUrl(rawUrl, ext)`: Civitai URL の末尾拡張子を実体の拡張子へ正す（例: `.../original=true/<uuid>.webp`）。
   * 判定結果 `{ wf, ext }` を `civitaiWfMap` にキャッシュし、カードおよびパレットの直リン URL に即時反映。コピーボタン押下時は通信待ちゼロ（0秒）で実体と一致した直リン URL をコピーする。

---

## 📡 外部連携・直リンアップロードAPI (`POST /api/upload`) の必要性と改修案の比較検討

### 1. なぜこの機能が論じられているのか（背景と必要性）
* **デスクトップ操作・直リン共有の圧倒的な需要**:
  * スクリーンショット撮影ツール（**ShareX**）や、Windowsエクスプローラーの右クリック「送る（Send To）」メニューから、**ブラウザ画面を都度開くことなく「0.5秒でファイルをアップロードし、クリップボードに直リンURLを自動コピーする」** ワークフローの実現。
  * Discordへの画像・動画のインライン即時展開、Markdownメモ（Obsidian/Notion）への画像埋め込み、AI画像生成ツールへの参照URL受け渡しなど、現代のWeb環境において「純粋な直リン（Direct Link）」は不可欠なインフラとなっている。
* **Cividgeにおける位置づけ**:
  * Cividge はブラウザ完結のメディアハブであるが、この外部受付口（`POST /api/upload`）により、デスクトップネイティブの快適な直リンアップローダーとしてもシームレスに機能させることができる。

---

### 2. 現在の設計と発生したチグハグ（課題の根本原因）
外部連携APIをテストした際、認証トークン設定後に `Filebase 投稿は未設定です。Worker に FILEBASE_IPFS_API_KEY を secret として設定してください` というエラーが発生した。
この原因は、**ブラウザ側とWorker側で採用しているFilebase連携方式が異なっていること**にある。

| 実行環境 | 通信経路 | 使用する認証情報 | メリット・特徴 |
|---|---|---|---|
| **ブラウザ UI** (`app.js`) | ブラウザ ➔ Filebase S3 API (`s3.filebase.com`) | **S3 Access Key / Secret Key / Bucket 名** | ブラウザがAWS SDKでS3に直接PUTし、レスポンスヘッダー `x-amz-meta-cid` からCIDを取得。 |
| **外部受付 Worker** (`upload.js`) | Worker ➔ Filebase IPFS RPC (`rpc.filebase.io`) | **IPFS RPC API Key** (`FILEBASE_IPFS_API_KEY`) | S3の強力なマスター権限をWorkerに渡さず、バケット限定の最小権限キーで標準 `fetch` を使って軽量・安全にCIDを取得。 |

* **ユーザーの疑問・違和感**:
  * 「Cividge はブラウザ側で S3 キーを使って動いているのに、なぜ Worker だけ別の『IPFS RPC API キー』を要求してくるのか？ 二重管理でおかしいのではないか」という極めて自然な疑問が生じた。

---

### 3. 【反省と教訓】却下されたアンチパターン（KV直保存案）
* **一時的に提案された愚案**:
  * 「Filebaseのキー設定を回避するため、Workerが持っているCloudflare KVに画像バイナリを直接保存する（`storage=filebase` を外す）」という案。
* **なぜ即時却下されたか（設計思想の破壊）**:
  1. Cividgeのアイデンティティである **「IPFSによる分散保存」「CIDによる同一ファイルの完全重複排除」「自宅Kuboノードとの自律同期・フォールバック保全」** を根底から破壊してしまう。
  2. Cloudflare KVは本来「短縮URL・有効期限・メタデータ台帳」として設計されており、大容量メディア実体を溜め込む場所ではない（KV容量制限・コスト・帯域の浪費）。
  3. **「手っ取り早く動くから」という理由でアーキテクチャの根幹を汚す泥縄な実装は絶対に採用してはならない** という強い教訓。

---

### 4. 正攻法としての改修・運用案の比較

Cividgeの「IPFS × CID台帳」という思想を完全に守りつつ、このチグハグをどう解決すべきかの検討案。

#### 【案 A】Filebase の「IPFS RPC API キー」を設定して運用（現状コード維持・推奨）
* **内容**:
  * Filebase コンソール（Buckets ➔ 該当バケット ➔ IPFS RPC API）からバケット専用のAPIキーを1つ取得し、WorkerのSecretに `FILEBASE_IPFS_API_KEY` として登録する。
* **メリット**:
  * **コード改修がゼロ**: 既存の `upload.js` を1行もいじらずに済む。
  * **コードが極めて綺麗・軽量**: 外部ライブラリなし、標準 `fetch` わずか15行で完結。
  * **最小権限の原則（セキュリティ）**: S3の全バケット操作・削除が可能なマスターキーをWorkerに置く必要がなく、該当バケットへのIPFS Pin権限のみを持つ安全な運用ができる。
* **デメリット**:
  * FilebaseのWeb画面でキーを1つ確認・登録する手間がある。

#### 【案 B】Worker 側もブラウザと同じ「S3 互換 API」に統一改修
* **内容**:
  * `upload.js` を改修し、Filebase S3（`s3.filebase.com`）へ直接 `PUT` してレスポンスの `x-amz-meta-cid` を取得するよう書き換える。
* **メリット**:
  * 認証情報がブラウザ側と同じ「S3 Access Key / Secret Key」に一本化され、概念的な統一感が出る。
* **デメリット**:
  * **コードの肥大化・複雑化**: Worker環境でAWS SigV4署名を計算するため、約80〜100行の暗号化ボイラープレートを追加するか、外部ライブラリ（`aws4fetch`等）を導入する必要があり、コードベースが重くなる。
  * **環境変数の増加**: Worker側に `FILEBASE_ACCESS_KEY`, `FILEBASE_SECRET_KEY`, `FILEBASE_BUCKET` の3つの変数を管理する必要が生じる。

#### 【案 C】フロントエンドのUX向上（ShareX `.sxcu` 設定ダウンロード）
* **内容**:
  * Cividge 管理画面の設定モーダル（Windows「送る」バッチダウンロードの隣）に、**「ShareX 設定ファイル（.sxcu）ダウンロード」ボタン** を追加する。
* **メリット**:
  * トークンやURL、ヘッダーを手動入力する手間や設定ミス（401 Unauthorizedなど）を根絶し、ファイルをダブルクリックするだけで誰でも一発でShareX登録を完了できる。

---

### 5. 総括・今後の指針
* 直リンアップロードAPIは、Cividgeをデスクトップ作業環境と完全統合する上で非常に強力な機能である。
* 実装の美しさ・軽量性・セキュリティを最優先するならば **「案A（IPFS RPC APIキー設定）」** が合理的であり、認証情報の一元化を最優先するならば **「案B（S3 PUT改修）」** を慎重に検討する。
* いずれの改修を行う場合でも、**「IPFSストレージとCID台帳というCividgeの純粋な設計を汚さない」** ことを絶対条件とする。

---

## 🛡️ ファイル名100文字制限・ハッシュ切り詰め＆エッジ門前払い防護の設計

### 1. なぜこの機能が必要なのか（背景と目的）
* **自由なファイル名とKV読み取り負荷のトレードオフ**:
  * Cividge はファイル名をランダム6文字に固定せず、自由な別名・ファイル名を許可している。
  * `delivery.js` には既に「拡張子ホワイトリスト（`.webp`, `.png` 等以外は即404）」が備わっているが、**「末尾に正規の拡張子をつけた架空の長大URL（例: `/[100文字超のランダム文字列].png`）」で絨毯爆撃された場合、毎回KVの存在確認（`kv.get`）が走ってしまう隙**が存在する。
* **実用的なファイル名長との調和**:
  * 現実世界で人間やツール（デジカメ、ShareX、CivitaiのAIプロンプト入り画像、YouTube風長文タイトル等）が使う実用的なファイル名は、**最大でも80〜100文字程度**に収まる（OS自体も最大255バイト制限）。
  * したがって、**「上限を100文字とし、これを超えるURLはKVを見ずに即座にエッジで叩き落とす」** というルールを敷くことで、悪意のある探索攻撃やボットからKV台帳を完全に保護できる。
* **エラーで拒絶せず「切り詰め（カット）」する理由**:
  * 100文字を超えた時にアップロードエラーで落とすと、ユーザーの手を止めてしまいUXが悪い。
  * 拡張子を保護し、意味のある先頭部分を残して短縮ハッシュを付与することで、**「ユーザーは気にせずアップロードでき、システム側は安全域（100文字以下）に収める」** というスマートな調和を実現する。

---

### 2. 切り詰め（サニタイズ）の厳格な仕様設計
ファイル名を正規化する共通関数 `sanitizeAndTruncateFilename(filename, 100)` の仕様：

1. **正常系（100文字以下）**:
   * ファイル名全体（拡張子含む）が100文字以下の場合は、一切加工せずそのまま使用する。
2. **切り詰めルール（100文字超）**:
   * **拡張子の保護**: 末尾の拡張子（例: `.webp`, `.mp4`）を必ず分離・維持する。
   * **衝突防止ハッシュ**: 先頭が同一の長文ファイル（AI生成画像の同一プロンプトなど）が上書き衝突するのを防ぐため、6文字の短縮ハッシュ/乱数（例: `_a1b2c3`）を付与する。
   * **文字化け防止スライス**: 日本語や絵文字（サロゲートペア）がバイト境界で壊れないよう、JavaScript のコードポイント単位（`Array.from(baseName)`）で安全に切り詰める。
   * **許容文字数の計算**:
     `残す本体長 = 100 - 拡張子長 - 区切り("_")1文字 - ハッシュ長6文字`
   * **結合結果**:
     `[切り詰めた本体]_[ハッシュ6文字].[拡張子]`（全体で合計 **100文字以下** を厳格に保証）。

---

### 3. 各コンポーネントでの改修方針

#### ① フロントエンド (`cividge/app.js`)
* ファイル選択時（`handleFiles`）、ドラッグ＆ドロップ時、および手動別名入力時に `sanitizeAndTruncateFilename` を通し、長すぎるファイル名を安全に切り詰めてからストレージおよびKVへ登録する。

#### ② 外部受付 Worker (`cividge-kv-worker/upload.js`)
* ShareX や Windows「送る」メニュー等から `X-Upload-Filename` や `filename` クエリで長大ファイル名が渡された場合、同様に切り詰め処理を実行して安全なキーでKV登録・保存する。

#### ③ 配信エッジ防護 (`cividge-kv-worker/delivery.js`)
* リクエストされた `filename` の長さが **100文字を超えている場合**、拡張子判定の直後、**KVデータベースを一切検索することなく即座に 404 Not Found を返却（24時間キャッシュ）** する。
* これにより、100文字を超える不正リクエスト・探索攻撃は 0ミリ秒でエッジ遮断され、KVの読み取り枠消費が完全にゼロになる。

## 今回の改修

- **統合メディア台帳の正式リネーム（`ipfs-kv` ➔ `cividge-kv`、完全互換移行）**:
  - **背景**: 当初はIPFS専用のCID名札として命名された `ipfs-kv` であったが、現在ではR2・Filebase双方の短縮URL・有効期限（TTL）・閲覧パスワード・配信ドメイン制限を司る「統合メディア台帳」に進化しており、実態に即した `cividge-kv`（Workerリポジトリ名 `cividge-kv-worker` と統一）へ正式改名を実施。
  - **バインディング（KV Namespace）**:
    - `cividge-kv-worker` および `cividge`（Pages Functions）双方の `wrangler.toml` において、`env.CIVIDGE_KV` と `env.IPFS_KV` の両バインディングを同一Namespace ID（`ff45707014424ab3afac57fda8c305de`）で並行サポート。
    - 各種コード（`delivery.js`, `_middleware.js` の `cleanupExpiredAlias`, `upload.js` の実体保存・ルーティング登録）内でも `env.CIVIDGE_KV || env.IPFS_KV` を徹底し、フォールバックを完備。
  - **API エンドポイント（両対応）**:
    - 新規に `/api/cividge-kv`（`cividge-kv.js`）を本線として配備し、旧 `/api/ipfs-kv` もエイリアス（re-export）として完全維持。
    - フロントエンド（`app.js`）の接続先判定、正規表現、オンボーディング新規作成手順を `/api/cividge-kv` / `CIVIDGE_KV` を第一推奨としつつ両対応に更新。
    - 既存設定・過去のブックマーク・外部スクリプトのいずれも壊さずダウンタイムゼロで安全に移行完了。

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

## 将来的な `ipfs-kv` の完全撤廃（廃止）に向けた壁とロードマップ

将来的に旧名称 `ipfs-kv`（バインディング名 `IPFS_KV` および エンドポイント `/api/ipfs-kv`）を完全に削除・整理したい場合の技術的な壁・影響範囲および推奨手順。

### 1. 完全撤廃における3つの「壁（ハードル）」
* **壁①: 利用者各自の Cloudflare バインディング設定（最大の影響箇所）**
  - **現状**: `wrangler.toml` には新旧両方を同一 Namespace で定義しているが、Cloudflare ダッシュボード上で手動設定を行っている場合、変数名が `IPFS_KV` のままの環境が存在しうる。
  - **影響**: コードから `env.IPFS_KV` のフォールバックを削除すると、ダッシュボード側で `CIVIDGE_KV` をバインドしていない環境で「KV binding not configured (500)」が発生する。
  - **対策**: コードから `env.IPFS_KV` を完全に消す前に、「Cloudflare 上で `CIVIDGE_KV` をバインドする」か「最新リポジトリから `wrangler deploy` を再実行する」よう周知・確認が必要。

* **壁②: ブラウザの localStorage に残る旧接続先 URL**
  - **現状**: 利用者ブラウザの `localStorage`（キー: `customKvWorkerUrl`）に、過去に保存された `https://<worker>/api/ipfs-kv` がそのまま残っているケースがある。
  - **影響**: Worker および Pages から `/api/ipfs-kv` を削除すると、その端末の管理画面から KV 台帳 API が 404 となり通信エラーになる。
  - **対策**: `app.js` の初期化時に `customUrl.replace(/\/api\/ipfs-kv\/?$/, "/api/cividge-kv")` と自動マイグレーションするコードを1行追加しておけば、利用者が意識することなく透過的に新エンドポイントへ移行完了する。

* **壁③: 外部スクリプト・過去の直リンク**
  - **現状**: Windows「送る（Send To）」バッチは `/api/upload` を叩くため影響を受けないが、curl や個人スクリプトで `/api/ipfs-kv` を直叩きしている連携がある場合。
  - **影響**: エイリアス（re-export）を削除すると 404 になる。
  - **対策**: 十分な周知期間を置く。

### 2. 結論と推奨アプローチ
* **技術的な壁は極めて低い（ほぼ無い）**:
  - 現在のコードはすでに `CIVIDGE_KV` / `/api/cividge-kv` が主系統（本線）として動作しており、内部のロジックはほぼ移行完了している。
* **エイリアス残存のコストはゼロ**:
  - 現在残している `ipfs-kv.js` は単なる1行の re-export（`export * from "./cividge-kv.js";`）であり、`env.CIVIDGE_KV || env.IPFS_KV` もオーバーヘッドは皆無（数文字のフォールバック）。
  - そのため、無理に完全撤廃を急ぐ実利（コードの数行削減）よりも、**「過去の環境や設定が絶対に壊れない」というメリットの方が運用上圧倒的に大きい**。
* **完全削除を実施する場合のチェックリスト**:
  1. `app.js` に `localStorage` の `/api/ipfs-kv` 自動書き換えコードを配備。
  2. 利用者の Cloudflare ダッシュボードで `CIVIDGE_KV` バインディングが存在することを確認。
  3. `functions/api/ipfs-kv.js` および `cividge-kv-worker/ipfs-kv.js` を削除。
  4. 各種コードから `|| env.IPFS_KV` を削除し、`wrangler.toml` から `binding = "IPFS_KV"` を削除して再デプロイ。

---

## 検証

- `node --check app.js`
- `git diff --check`
- `npm run build`

はいずれも今回の変更後に成功している。

---

## 🪐 Filebase FIFO × 🏠 自宅Kubo自動Pin（フォールバック保全）の改修メモ

### 1. 現状の挙動と課題

- **現状のコード（`app.js: ensureStorageCapacityFilebase`）**:
  1. アップロード前（`app.js:5494`）に `ensureStorageCapacityFilebase` が呼ばれる。
  2. 容量上限（85%）を超えている場合、`kuboAutoPin`（Kuboへの自動Pin留めチェック）がONなら `checkKuboOnline(1500)` を実行。
  3. **問題点①（ユーザー指摘の通り）**:
     - Kuboがオフライン（疎通NG）の時、単に `console.warn` を出して `return;` するだけになっている。
     - 呼び出し元のアップロード処理（`PutObjectCommand`）は何事もなかったかのように**そのまま続行されてしまう**。
     - その結果、Filebaseの容量上限に達している状態でアップロードが強行され、クォータ制限超過エラーになるか、古いファイルも消せずKuboにも残せない膠着状態になる。
  4. **問題点②（重大なデータロスト脆弱性）**:
     - Kubo疎通OKの場合、現在の実装は **「① Filebase S3 から DeleteObject」➔「② その後に Kubo へ pinToKubo」** という順序になっている。
     - もし Kubo 側のディスクフルやネットワーク瞬断で Pin 留めに失敗した場合、Filebase からは既に実体が削除されているため、**ファイル実体が完全消滅（デッドリンク化）する危険**がある。

### 2. 理想の条件分岐とエッジケース設計

#### 【条件分岐マトリクス】

| パターン | 容量状態 (新規合算) | FIFO設定 (`autoFifo`) | Kuboフォールバック (`kuboAutoPin`) | Kubo疎通状態 | 期待される正しい挙動 |
|---|---|---|---|---|---|
| **P1: 容量余裕** | 85%以下 | ON / OFF 問わず | ON / OFF 問わず | 判定不要 (チェック不要) | **通常アップロード実行**（Kubo疎通確認もスキップして高速動作） |
| **P2: 容量切迫・Kubo疎通OK** | 85%超 | **ON** | **ON** | **疎通OK** (自宅LAN / Tailnet) | **① 古いファイルのCIDをKuboへPin ➔ ② 成功確認後にFilebaseアンピン ➔ ③ 新規アップロード実行** |
| **P3: 容量切迫・Kubo疎通NG** | 85%超 | **ON** | **ON** | **疎通NG** (外出先 / 未起動) | **アップロードを安全に中断（停止）し、分かりやすいメッセージで通知** |
| **P4: 容量切迫・Kubo不要** | 85%超 | **ON** | **OFF** | 判定不要 | **Filebaseから古いファイルをアンピン（Kubo保存なし） ➔ 新規アップロード実行** |
| **P5: 容量切迫・FIFO無効** | 85%超 | **OFF** | 問わず | 判定不要 | FIFO無効のためアンピンせず。100%上限超過時はエラー停止 |

#### 【考慮すべき漏れ・エッジケース】
1. **安全な実行順序の徹底**:
   - P2において、「Kubo Pin成功」を確認してから「Filebase S3 Delete」を実行する。Pin失敗時はFilebase削除を行わずアップロードを中断する。
2. **分かりやすいユーザー通知（UX）**:
   - P3でアップロードを停止した際、「⚠️ Filebase容量上限（85%）に達しています。自宅Kuboノードに接続できないため、過去ファイルの消失を防ぐためにアップロードを中断しました。Tailscaleに接続するかKuboを起動してください」と明示的なメッセージを表示する。
3. **KuboフォールバックがOFFの場合の扱い**:
   - ユーザーが意図して「Kubo自動Pin」チェックをOFFにしている場合は、Kubo疎通NGであっても通常のFilebase FIFO（古いファイル削除）を実行してアップロードを継続する。

---

## 🐛 [バグ修正] CID遅延解決時の未定義変数による配信ドメイン意図しない上書きバグの根絶

### 1. 現象と再現条件
- **現象**: 動画ファイル等の期限切れ削除や一覧の再描画が行われた際、全く無関係のファイル（例: `https://testunko.pages.dev/x7hjsnoh.webp`）の配信アドレスが、画面上部で現在選択されている初期アップロードアドレス（`content-relay.pages.dev`）に勝手に書き換わってしまう。
- **根本原因**:
  1. `renderCurrentStoragePage` 内で、CID未解決アイテムをバックグラウンドで解決する処理（`app.js:7052`）において、存在しない未定義変数 `fileInitialDomain` を参照していた（`fileInitialDomain || baseDomain`）。
  2. 変数が `undefined` のため、常にフォールバックの `baseDomain`（現在プルダウンで選択されている初期アップロードアドレス）が採用された。
  3. その結果、カードのDOM上のURLが書き換わっただけでなく、`registerKvCid` によって中央KV台帳の `allowedHost` まで現在の初期アドレスで上書き保存されてしまっていた。
  4. 動画ファイル等が期限切れで削除された瞬間に一覧の再描画が走り、画面上にあった未キャッシュCIDファイルに対してこの非同期処理が直撃することで、無関係なファイルのドメインが書き換わる怪奇現象として観測された。

### 2. 修正内容
1. **カード固有ドメインの完全維持**:
   - バックグラウンド解決時の公開URL生成を、カード固有の固定ドメイン（`fileDomain` / `rawAllowedHost`）を優先して解決するように修正。
2. **中央KVの既存ドメイン死守**:
   - `registerKvCid` に渡すホスト名を `preserveAllowedHost = rawAllowedHost || keyHost || fileDomain` とし、既存の配信ドメイン（`testunko.pages.dev` 等）を厳格に保持。初期アドレスで上書きされる脆弱性を根絶。
3. **新DOMレイアウトへの追従**:
   - CID動的挿入処理を、最新のレスポンシブレイアウト（`.item-cid-group` / `.item-details-row2`）に正しくマウントするよう最適化。

---

## ⚡ [新機能] Filebase FIFO 時の「Kubo保管済みファイル優先解放」

### 1. 背景と開発の狙い
- **課題**:
  - Filebase の容量解放（FIFO）実行時、クラウドの容量を空けるために古いファイルを Kubo（自宅ノード）へ Pin 留めしてから Filebase からアンピン（削除）する保全フローが存在する。
  - しかし、容量不足時に複数ファイルを一度にまとめて Kubo へ新規 Pin しようとすると、ノードの負荷や IPFS ネットワークの探索待ちによりアップロード全体の待機時間が長期化したり、通信タイムアウト等でアップロードが中断されるリスクがあった。
- **解決策**:
  - 既にユーザー自身や過去の処理によって「自宅 Kubo ノードに Pin 留め完了しているファイル」が Filebase 上に存在する場合、そのファイルは自宅バックアップが 100% 確定している。
  - したがって、**「既に Kubo に Pin 留めされているファイル」を最優先で Filebase のアンピン対象として選出**する。
  - これにより、Kubo への新規 Pin 通信を完全にスキップできるため、**容量解放がミリ秒単位で爆速完了**し、データ消失リスクもゼロでクラウド容量を安全に明け渡すことが可能になる。

### 2. UI および設定仕様
- **配置場所**:
  - `index.html` の `#kuboAutoPin`（Filebase容量解放時にKuboへ自動Pin留め）チェックボックスの直下。
- **表記（ユーザー指定: 🏠マーク・「推奨」なし）**:
  - 日本語: `Kubo保管済みのファイルを優先して容量解放`
  - 英語: `Prioritize releasing files already pinned to Kubo`
- **動作**:
  - チェックボックス ID: `#kuboPrioritizePinned`
  - デフォルト値: `true` (ON)
  - `localStorage` キー: `kuboPrioritizePinned` で設定を永続化。

### 3. アルゴリズム・処理フロー (`ensureStorageCapacityFilebase`)
1. **Kubo Pin済みリストの一括取得**:
   - Kubo がオンラインかつ `kuboPrioritizePinned` が有効な場合、`await getKuboPinnedCids(1500)` を1回だけ呼び出し、Kubo 側の Pin 済み CID を `Set` として保持。
2. **優先ソート**:
   - アンピン候補ファイル（`eligibleFiles`）を以下の優先順位でソート：
     - **第1キー**: そのファイルの CID（`getStoredIpfsCid`）が Kubo に Pin 済みかどうか（Pin 済みが先頭）
     - **第2キー**: 最終更新日時（`LastModified`）の古い順
3. **無駄な Pin 通信のスキップ**:
   - ソート後、容量が目標値に達するまでファイルを走査。
   - 既に Kubo Pin 済みのファイルは `pinToKubo` を呼ばずに即座にアンピン対象リストへ投入。


---

## 📸 [新機能] 外部投稿アコーディオンにおける ShareX 設定ファイル (.sxcu) ダウンロード機能

### 1. 背景と狙い
- **課題**:
  - `cividge-kv-worker/upload.js` による外部投稿API（マルチパートPOST受付）は完成していたが、ShareX にカスタムアップローダーとして手動登録する場合、JSON構文の作成やヘッダー・URLの指定で打ち間違いが発生しやすく、ハードルが高かった。
  - スクリーンショット撮影時、個人名や元ファイル名が漏洩するのを防ぐため、ファイル名を「元の名前」「完全ランダム」「日付＋ランダム」から選んでアップロードしたい需要があった。
- **解決策**:
  - `index.html` の「🚀 外部投稿 / Windows「送る」連携」アコーディオン内に、**ファイル名命名ルール選択UI** と **「📥 ShareX 設定ファイル (.sxcu)」ダウンロードボタン** を追加。
  - アコーディオン内で選択された「ストレージ（Filebase/R2）」「配信ドメイン」「トークン」「ファイル名ルール」を動的に埋め込んだ `.sxcu` ファイルをブラウザ上で即座に生成・ダウンロード可能にする。
  - ユーザーはダウンロードしたファイルをダブルクリックするだけで、ShareX への登録が完了する。

### 2. 仕様
- **UI要素**:
  - `#uploadNamingRuleSelect`: ファイル名命名規則
    - `original`: 元の名前を維持（100文字自動切り詰め） ➔ `X-Upload-Filename: {filename}`
    - `random`: 完全ランダム英数字 ➔ `X-Upload-Filename: {rand:8}.{ext}`
    - `date_random`: 日付＋ランダム ➔ `X-Upload-Filename: {year}{month}{day}_{rand:6}.{ext}`
  - `#downloadSharexBtn`: `📥 ShareX 設定ファイル (.sxcu)`
- **生成される .sxcu の構造**:
  - `DestinationType`: `ImageUploader, TextUploader, FileUploader`
  - `RequestMethod`: `POST`
  - `RequestURL`: `https://<Worker>/api/upload?storage=<filebase|r2>&domain=<配信ドメイン>`
  - `Headers`: `Authorization: Bearer <UPLOAD_TOKEN>`, `X-Upload-Filename: <ルールに応じた構文>`
  - `Body`: `MultipartFormData`
  - `FileFormName`: `file`
  - `URL`: `{json:url}`
  - `ErrorMessage`: `{json:error}`

---

## 🔒 [安全対策] 投稿専用 API トークンのリアルタイム一致検証＆不一致時ダウンロードロック

### 1. 背景と目的
- **課題**:
  - 従来のUIでは、投稿専用APIトークン欄が「空欄ではない（何か1文字でも入力されている）」ことしか判定しておらず、間違ったトークンが入力されていてもダウンロードボタンが押せてしまっていた。
  - その結果、間違ったトークンが入った `.sxcu` や `.bat` が作成され、利用時に初めて「401 Unauthorized」で失敗する事故の原因となっていた。
- **解決策**:
  - Worker 側（`cividge-kv-worker/upload.js`）に `GET /api/upload` のトークン検証エンドポイントを新設。
  - フロントエンド側でトークン入力時（デバウンス400ms）および初期ロード時に、自動で Worker へテストリクエストを送信。
  - **Worker側の正解トークンと一致（200 OK）した場合のみ**、ステータスを `🟢 トークン認証成功` に更新し、ダウンロードボタン（Windows「送る」バッチ / ShareX設定）および URL/curlコピーを有効化する。
  - 不一致（401）またはエラー時は、`🔴 トークン不一致` と赤字警告を表示し、**ダウンロードボタンを完全に無効化（disabled）してロック**する。
- **ダウンロード時のセキュリティ警告ダイアログ**:
  - Windows「送る」バッチと同様に、ShareX 設定ファイル（`.sxcu`）ダウンロード時にも `showCustomConfirm` モーダルを表示。
  - 「この .sxcu ファイルには投稿専用トークンが平文で含まれます。第三者に絶対に共有・公開しないでください」という警告にユーザーが同意（理解してダウンロード）した場合のみ、ファイル生成・ダウンロードを実行する安全防護を追加。

---

## 🛠️ [バグ修正] ShareX 構文エラー（Invalid function name: rand）の解消と Worker 命名ルール処理

### 1. 発生した不具合
- **エラー現象**: 生成された `.sxcu` ファイルを ShareX にインポート（またはダブルクリック登録）した際、`System.Exception: Invalid function name: rand` エラーが発生して登録に失敗する。
- **原因**:
  - ShareX の構文解析器（`ShareXCustomUploaderSyntaxParser`）には `{rand:8}` や `{ext}` といったマクロ関数が存在しない。
  - `Headers` 内に `{rand:8}` を含めていたため、パース時に未定義関数として例外がスローされていた。

### 2. 解決策
- **命名ルールの処理を Worker（サーバー側）に集約**:
  - クライアント側（ShareX）の構文マクロに頼るのを廃止し、Worker のアップロードエンドポイント URL クエリに `?naming=<random|original|date_random>` を付与する設計に変更。
  - `Headers` から `X-Upload-Filename` を削除し、`Authorization: Bearer <UPLOAD_TOKEN>` のみに簡素化。
  - これにより ShareX のパースエラーが 100% 解消し、標準的なダブルクリック登録・インポートが可能になった。
- **Worker 側の対応 (`cividge-kv-worker/upload.js`)**:
  - `url.searchParams.get("naming")`（またはヘッダー `X-Upload-Naming`）を判定し、`random`（デフォルト・6文字英数）、`original`（元ファイル名ベース・特殊文字サニタイズ）、`date_random`（`YYYYMMDD_xxxxxx.ext`）を確実にサーバー側で振り分けて短縮キー（`shortKey`）を生成。
- **他機能との統一**:
  - URLコピー、curl例、Windows「送る」バッチでも同様に `?naming=<rule>` を連動させ、全機能で統一された命名挙動を実現。

---

## 🔍 [課題と改善案] アップロード直後の「404エッジキャッシュ焼き付け」事故と最小構成での解決策

### 1. 発生した課題・現象
- **現象**: 動画ファイルを互換レイヤ（静的Pages経由や配信エッジ）へアップロードした直後にアクセスすると、女の子の画像が見えない独自404画面が表示され、約1分間アクセス不能になった後、自然回復する。
- **メカニズム分析**:
  1. **動画特有の初期遅延**: Filebase/IPFS は動画（容量大）のアップロード直後、ゲートウェイ側でブロックがインデックスされるまでに数秒〜十数秒のタイムラグがある。
  2. **フロントの自動空撃ち**: アップロード直後にフロントエンドの一覧描画で `<video src="...#t=0.5" preload="metadata">` が走り、ブラウザがサムネイル取得のために未成熟な公開URLへ自動アクセスした。
  3. **404の60秒エッジキャッシュ（致命傷）**: Worker（`delivery.js`）は、上流IPFSゲートウェイから404が返った際、デフォルトで `Cache-Control: public, max-age=60`（60秒キャッシュ）および `cf.cacheTtlByStatus: { 404: 60 }` を返却・保存してしまう設計になっていた。
  4. **結果**: Filebase側の準備が数秒で整っても、エッジに焼き付いた404キャッシュのせいで「キッチリ1分間アクセス不能の牢獄」に閉じ込められた。

### 2. 「通信で完了確認」ではなく「最低限何があれば目的を達成できるか」の設計
ポーリング通信や複雑な監視処理を入れず、**「エッジを焼き付けない（そっとしておく）」という極小の2手**だけで、目的（アップロード直後から404を出さず安定アクセス可能にする）を100%達成できる。

#### ① 【Worker側・最重要】KV台帳に存在する正規ファイルの404キャッシュを完全撤廃
- **改修内容**:
  - `delivery.js` の上流フェッチ失敗時（行896付近）において、`targetCid`（台帳レコード）が存在する場合は `renderNotFoundResponse(request, 0)`（`Cache-Control: no-store`）とする。
  - 上流フェッチの `cf.cacheTtlByStatus` でも 404 のキャッシュを `0` にする。
  - ※台帳に最初から存在しない「完全な不正URL/攻撃」に対する 60秒キャッシュ（行673）はそのまま維持し、セキュリティを担保。
- **効果**:
  - たとえアップロード直後にアクセスしても、404 がエッジに焼き付くことが物理的になくなる。
  - Filebase の準備ができ次第、再アクセス（リロード）するだけで即座に 200 OK で表示される。

##### ② 【フロントエンド側】動画サムネイルの自動空撃ちを抑制（静観）
- **改修内容**:
  - `app.js`（行6971）の動画サムネイルで、一時的に `preload="none"` に設定したが、ブラウザが動画フレームを取得できずサムネイルが真っ黒になる問題が発生。
  - Worker 側で 30秒自動リトライ＆404キャッシュ0秒が稼働したため、`preload="metadata"` に戻しても 404 事故は発生しないことを確認。サムネイル正常表示のため `preload="metadata"` を維持。
- **効果**:
  - 動画サムネイルが正常に表示され、かつ Worker の Grace Period により 404 ロックも発生しない両立を実現。

---

## 🛡️ [台帳安全性改修] 1,000件超えでの誤アンピン防止・全件一覧取得・投稿API日時化け修正

### 1. 課題とリスク
1. **手動削除時の誤アンピン（実体削除）リスク**: `cividge-kv.js` の `onRequestDelete` において、CID 共有判定が最初の 1,000 件しか走査しておらず、ファイル数が 1,000 件を超える場合にエイリアスが残っている実体を誤ってアンピン（消去予約）してしまう危険があった。
2. **管理画面一覧の 1,000 件頭打ち**: `onRequestGet` が `list({ limit: 1000 })` 固定で、1,001 件目以降が表示されなかった。
3. **投稿用 API の更新日時化け**: `upload.js` で `lastModified` や `t`（秒）が保存されておらず、一覧取得時に毎回 `Date.now()`（現在時刻）に化けていた。

### 2. 解決策
1. `cividge-kv.js` の `onRequestDelete` で `cursor` ループによる全件走査を実装。同一 CID を参照するキーが全件中に 1 つでも残っていれば墓標を発行しないよう安全化。
2. `cividge-kv.js` の `onRequestGet` で `cursor` ループによる全件取得を実装し、1,000 件超のファイルも完全網羅。
3. `upload.js` の KV メタデータに `lastModified: Date.now()`, `t: Math.floor(Date.now() / 1000)`, `s: uploadedSize` を追加し、日時が不変に保たれるよう修正。
4. `app.js` の動画サムネイルを `preload="metadata"` に戻し、正常にサムネイルを描画。

---

## 🚀 [容量拡張・メタルール整備] 単一ファイル上限 128MB 引き上げ ＆ INVARIANTS.md 導入

### 1. 単一ファイルアップロード上限の引き上げ (100MB → 128MB未満)
- **背景**: 100MB 制限では、102〜108MB などのわずかに 100MB をオーバーするスマートフォン撮影動画やゲーム画面録画が弾かれてしまう課題があった。
- **改修内容**:
  - `app.js`（行5486）の `MAX_SINGLE_FILE_BYTES` を `100 * 1024 * 1024` から `128 * 1024 * 1024`（128MB）へ引き上げ。
- **効果と安全性**:
  - スマホのブラウザメモリ制限（iOS Safari Jetsam 上限など）を考慮し、瞬間消費メモリを約 300〜380MB の安全圏に抑制（OOM クラッシュを物理的に回避）。
  - Cloudflare の単一ファイルキャッシュ上限（512MB）に対しても十分な余裕（約1/4）を保ち、エッジキャッシュが 100% 確実に効く状態を維持。

### 2. システム不変条件（INVARIANTS.md）の体系化
- 両リポジトリに `INVARIANTS.md` を配置し、システムが絶対に満たすべきルール（台帳存在時の 404 キャッシュ禁止、参照残存時のアンピン禁止、全件走査必須、サムネイル preload、128MB 上限）を成文化。
- コード内の該当箇所に `See: [INV-xxx]` コメントを付与し、将来の改修による誤破壊を永久防止。

---

## 🛡️ [転送枠保護・ルーティング最適化] Filebase Egress 温存 ＆ IPFS ゲートウェイ動的優先制御

### 1. 課題と背景
- **Filebase のダウンロード帯域（Egress）制限**:
  - Filebase は保管（Pin）には非常に寛容だが、ダウンロード帯域（Egress）枠に上限が存在する。
  - 調査の結果、以下の2つの帯域浪費要因が特定された：
    1. **アップロード直後の無条件全量フェッチ（ウォームアップ）**: アップロード完了 300ms 後にブラウザが `fetch(proxyUrl)` を発行し、まだ誰も閲覧していないファイルの全量を Filebase IPFS からダウンロードしていた（1ファイルあたり100%消費）。
    2. **上流ゲートウェイの固定順序**: ピン状態に関係なく `ipfs.filebase.io` が最優先されていたため、自宅 Kubo にデータが保全されている場合でも常に Filebase の帯域を消費していた。

### 2. 改修内容と設計

#### ① フロントエンド側: アップロード直後の全量ウォームアップフェッチを完全停止
- **改修内容 (`app.js`)**:
  - アップロード完了直後に走っていた `fetch(result.proxyUrl)` を撤廃。
  - 初回アクセス者（SNS共有やMisskeyでの閲覧時）がアクセスした際にオンデマンドでエッジキャッシュに載せる方式に統一。
- **効果**:
  - アップロードしただけで誰も見ないファイルの Filebase ダウンロード帯域消費が **ゼロ** に。

#### ② Worker側: Kubo / Filebase のピン状態に応じた動的優先ルーティング (`delivery.js` / `[INV-DELIVERY-003]`)
- **改修内容 (`delivery.js`)**:
  - KV 台帳のフラグ（`flags & 2`: `kuboStatus:pinned`、`flags & 1`: `unpinned`）を判定し、上流ゲートウェイの問い合わせ順序を動的に制御：
    1. **自宅 Kubo 保全済み (`kuboStatus === "pinned"`)**:
       - 優先順: 公共GW（`dweb.link`, `ipfs.io`, `gateway.pinata.cloud`, `4everland.io`） ➔ 末尾に `ipfs.filebase.io`（保険）
       - **効果**: 公共GWが DHT 経由で自宅 Kubo からブロックを取り寄せるため、**Filebase のダウンロード帯域消費はゼロ**。
    2. **Filebase 解放済み（アンピン / `unpinned: true`）**:
       - 優先順: 公共GWのみ（ランダム分散）
       - **効果**: Filebase を候補から完全除外（無駄な 404 問い合わせを防止）。
    3. **初期アップロード状態（Filebase Pin のみ）**:
       - 優先順: `ipfs.filebase.io` ➔ 公共GW
       - **効果**: 実体が確実に存在する Filebase から高速に初回取得。
    4. **専用ゲートウェイ連携**:
       - 環境変数 `KUBO_GATEWAY_URL`（自宅 Cloudflare Tunnel 等）が指定されている場合は最優先で直叩き。

### 3. メリット
- **追加インフラ・スキーマ変更ゼロ**: 既存の KV 台帳ビットフラグをそのまま利用。
- **Filebase Egress の恒久的大幅削減**: 自宅 Kubo に同期される運用において、Filebase 転送枠の消費が劇的に抑制される。

---

## ⚡ [ストレージ統合・一元配信] Cloudflare R2 の pages.dev / relay 経由ハイブリッド配信

### 1. 課題と背景
- 従来は R2 と Filebase で配信リレー（Pages / Worker）が物理的に分かれており、`r2-relay` や `ipfs-relay` と別々のドメイン管理を強いられていた。
- また、R2 のアップロード時に条件によって KV 台帳登録がスキップされ、統合 Worker 側で「CID がない」として 404 遮断される潜在的な制限があった。

### 2. 改修内容と設計
1. **フロントエンド側 (`app.js`)**:
   - R2 アップロード時に、画像・動画・パスワード・TTLの有無に関わらず、**常に KV 台帳へ "r2" マーカーと allowedHost を登録**。
   - これにより、R2 のファイルに対しても時限消去（TTL）やドメイン制限が 100% 確実に適用される。
2. **Worker 側 (`delivery.js` / `[INV-DELIVERY-004]`)**:
   - **台帳に存在しないランダム URL は即座に 404 返却**（R2 / IPFS どちらにもアクセスさせず DoS 防護）。
   - **相互排他ルーティング**:
     - 台帳が R2 レコード ➔ **R2 バケットのみを検索・即時返却**（IPFS 上流フェッチは 0 回）。
     - 台帳が IPFS レコード ➔ **IPFS ルーティングへ直行**（R2 バケット検索は 0 回）。
3. **インフラ側 (`wrangler.toml`)**:
   - `cividge-kv-worker` に `env.R2_BUCKET = "cividge"` をバインド。
   - 統一カスタムドメイン `relay.k7m.f5.si` をプロビジョニングし、各静的 Pages（`content-relay`, `testunko`, `punipuni-media`）の転送先を一元化。

### 3. 効果
- ユーザーは **ブラウザから R2 を設定し、配信ドメインに `https://content-relay.pages.dev`（または `testunko`）を選ぶだけ** で、完全無料・Egress ゼロ・爆速で R2 から配信可能に。
- R2 のファイルに対しても、`k7m.f5.si` の「クエリ無視 Cache Rule（キャッシュバスター DoS 防御）」が 100% 適用される。

---

## 🧬 [擬似IPFS構造の確立] Cloudflare R2 のドメインエイリアス・リネーム・SHA-256重複排除

### 1. 改修の背景と設計思想
Cloudflare R2（一般的な S3 互換オブジェクトストレージ）は、本来 IPFS のような「CID（コンテンツ指向ハッシュ）」や「同一実体に対する別名・複数ドメインの柔軟な紐付け」の概念を持たない。
通常、S3 で別ドメイン向けにファイルを配信したりファイル名を変更しようとすると、**「ギガバイト級の実体ファイルを別名でバケット内にコピーして二重保存する」** ことになり、保存容量（無料枠10GB）の激しい浪費や通信コストを招く。

本改修では、**Cloudflare KV 台帳を「実体（`s3Key`）と公開 URL（`key`）の完全な分離レイヤー（擬似IPFS互換層）」として昇華**させ、R2 においても Filebase と同等の柔軟性と容量効率を実現した。

---

### 2. 主な改修項目と技術仕様

#### ① R2 一覧画面でのドメインエイリアス（＋ボタン）の実現
- **従来の課題**: Filebase は KV 台帳主導でカードを描画していたが、R2 は物理バケット（`response.Contents`）のみを描画していたため、KV に別ドメインのエイリアスを作っても画面に反映されなかった。
- **改修後 (`app.js`)**:
  - KV 台帳上の R2 レコード（`targetCid === "r2"` 等）を走査し、物理 S3 オブジェクトと結合して各ドメインカードを生成。
  - 「＋」ボタン押下時、現在表示中のドメインを除外した候補一覧を表示し、選択した新ドメイン用に `hostname:filename` の KV レコードを追加。
  - **効果**: R2 バケットの保存容量を 1 バイトも消費せず、同一実体に対する別ドメイン URL カードを無制限に増設可能。
  - ※ ユーザー要望に基づき、R2 と Filebase の配信ドメイン登録リストは一本化せず独立した設定を維持。

#### ② エイリアスカードの安全な削除フロー（単体・一括・FIFO）
- **従来の課題**: エイリアスが存在する状態で削除を押すと、KV レコードだけ残るか、他ドメインで共有中の実体が道連れで消去されてしまう危険があった。
- **改修後 (`app.js`)**:
  - **単体削除**: 同じ `s3Key` を共有する兄弟リンクが存在する場合、確認モーダルで「**リンクのみ削除（推奨）**」または「**すべて完全削除**」を選択可能に。リンクのみ削除時は KV レコードのみ削除（即404化）し、R2 実体は安全に保護。
  - **一括削除**: 選択されなかったカードの中に同一実体を参照するエイリアスが残っている場合、実体は R2 から削除せず、対象リンクのみを安全に消去。
  - **FIFO 自動容量解放**: 古い実体を削除する際、関連するすべての KV エイリアスリンクを連動して自動回収。

#### ③ 容量集計バーの重複排除（ユニーク化）
- **従来の課題**: 画面上のカード配列（`contents`）を単純合計していたため、エイリアスでカードが増えると同一実体のサイズが二重・三重に合算され、容量バーが倍増して見えていた（例: 457.9 KB × 2 = 915.9 KB）。
- **改修後 (`app.js`)**:
  - `state.r2TotalSize` およびパッシブ FIFO 判定において、実体一意キー（R2: `s3Key` / Filebase: `cid` または `s3Key`）を `Set` で追跡。
  - エイリアスカードが何枚あっても、実体のサイズを **1 度だけ合算**するように統一。実際のバケット使用量と 100% 一致させた。

#### ④ 擬似IPFSファイル名変更（パターンB: 旧名維持・新名追加）
- **改修後 (`app.js`)**:
  - R2 カードにも ✏️（リネーム）ボタンを有効化。
  - 配信 Worker（`delivery.js`）の `const r2Key = meta.s3Key || meta.k_s3 || filename;` ルーティングを活用。
  - バケット内の物理ファイルを動かさず、既存実体（`originalS3Key`）を参照する新名レコードを KV に登録。
  - **旧ファイル名のリンクも削除せず維持（パターンB）**。大容量ファイルでも 0.1 秒・通信ゼロで完了し、過去に共有した古い URL も引き続きアクセス可能。

#### ⑤ 疑似ハッシュ識別（SHA-256擬似CID）によるアップロード重複排除
- **従来の課題**: R2 は CID がないため、中身が同じ別名ファイルをアップロードすると毎回新規実体が保存され、10GB 枠を浪費していた。
- **改修後 (`app.js`)**:
  1. **高速ハッシュ計算**: Web Crypto API (`crypto.subtle.digest("SHA-256")`) により、アップロード前にブラウザ側で数ミリ秒で SHA-256 ハッシュを算出。
  2. **実在優先探索 (`findR2ObjectByHash`)**:
     - 削除済みキャッシュによるゴースト参照を防ぐため、**「現在 R2 バケットに実在するオブジェクト（ListObjectsV2）」の中からのみ探索**。
     - ローカルキャッシュ（`r2HashMap`）や KV メタデータを活用し、未解決かつサイズ完全一致のオブジェクトのみ HEAD 確認して S3 API 負荷を最小化。
  3. **スマートエイリアス化**:
     - 同一中身の既存実体が見つかった場合、**R2 への実体アップロード（`PutObject`）を完全スキップ**。
     - 既存実体を参照する新名カードを KV に即時登録（通信量ゼロ・容量消費ゼロ・待ち時間ゼロ）。
  4. **キャッシュ連動破棄**:
     - 単体削除・一括削除・FIFO 削除のすべてにおいて、実体消去時に `deleteR2Hash(key)` を呼び出し、ローカルのハッシュキャッシュを即座に破棄。

---

### 3. 総合アーキテクチャの完成形
以上の改修により、**「Filebase（真の IPFS）と Cloudflare R2（擬似 IPFS）が、共通の KV 台帳レイヤーの上で完全に対等・安全に両立するハイブリッド・メディアインフラ」** が完成した。

---

## 🌐 [IPFS/Kubo 統合＆ストレージ移行] R2 への UnixFS CID 統一・Kubo 実体注入 ＆ 選択的ゲートウェイルーティング

### 1. 改修の背景と目的
- **現状の課題**:
  - R2 は SHA-256 ハッシュで重複排除を行っていたため、Filebase（IPFS UnixFS CID）とハッシュ体系が分裂していた。
  - R2 で保管しているファイルを自宅 Kubo（IPFS ノード）へ移したい場合、ブラウザから実体を Kubo へ流し込む手段（`/api/v0/add`）が未連携だった。
  - 将来「数年後に R2 の容量を空けるため実体を消し、自宅 Kubo のみに残す」運用へ移行した際、Worker が Filebase ゲートウェイに無駄な問い合わせを行い、Filebase 帯域消費や 404 待ち遅延が発生する恐れがあった。
- **改修の目的**:
  1. **CID の一本化**: R2 アップロード時も Filebase と全く同じ IPFS UnixFS CID（`calculateFilebaseCid`）を事前計算して台帳に記録。
  2. **自宅 Kubo への実体注入**: R2 カードの `[📌 KuboにPin]` を押すと、Kubo RPC（`/api/v0/add`）へ直接 Blob を POST して即座にローカル保全＆DHT告知。
  3. **安全な R2 実体消去（ライフサイクルガード）**: 自宅 Kubo に Pin 留めされている時だけ `[⚡ R2保管中]` バッジをクリック可能にし、安全に R2 実体を消去してバケット容量を解放。
  4. **配信レイヤの相互排他＆Filebase完全除外ルーティング**: R2 起源のファイル（`meta.backend === "r2"`）が R2 から消去されて Kubo 保持になった場合、Filebase ゲートウェイを完全にスキップし、公共 IPFS / 自宅 Kubo ゲートウェイのみを探索して配信。

---

### 2. コンポーネント別の詳細設計と改修仕様

#### ① フロントエンド (`cividge/app.js` / `cividge/kubo-client.js`)
1. **UnixFS CID 計算の一本化**:
   - R2 アップロード前に `calculateFilebaseCid(file)` を実行し、CID（`bafy...`）を算出。
   - KV メタデータに `meta.contentCid = cid`、`meta.backend = "r2"`（短縮 `meta.b = "r2"`）、`targetCid = "r2"` を記録。
   - 重複判定も CID をキーとして行い、同一ファイルのアップロードを通信ゼロで即時エイリアス化。
2. **Kubo 実体注入 API の追加 (`kubo-client.js`)**:
   - `addFileToKubo(blob, filename)` を新設。
   - 現在の RPC 設定（標準 `http://127.0.0.1:5001`）へ `POST /api/v0/add?pin=true` を送信（追加のポート開放や CORS 設定は不要、既存設定のまま動作）。
3. **R2 カードのバッジ UI と安全ライフサイクルガード**:
   - **`[📦 CID 📋]`**: 計算された UnixFS CID をクリップボードにコピー。
   - **`[🟣 Kubo保持中]` / `[📌 KuboにPin]`**:
     - 既存の同一 CID がすでに Kubo に Pin されていれば、アップロード直後から即座に `[🟣 Kubo保持中]` を表示。
     - 未保持の場合、`[📌 KuboにPin]` を押すと R2 から Blob を取得して Kubo の `/api/v0/add` に注入・Pin 留め。
   - **`[⚡ R2保管中]` (安全ライフサイクルガード)**:
     - Kubo 未保持時はクリック不可（誤って実体を消して消失する事故を物理防止）。
     - Kubo 保持中（自宅に実体がある）時のみクリック可能になり、確認ダイアログを経て R2 バケットから実体を削除。
     - 削除後は `[⚡ R2: 未保持 (Kubo保全中)]` に切り替わり、バケット容量を安全に回収。

#### ② 配信レイヤ (`cividge-kv-worker/delivery.js`)
1. **R2 ➔ Kubo フォールバック ＆ Filebase 完全除外ルーティング**:
   - 台帳の `meta.backend === "r2"` または `meta.b === "r2"` を判定。
   - **Step 1: R2 バケット確認**:
     - `env.R2_BUCKET.get(r2Key)` で実体が存在すれば、最速・Egress ゼロで即時 200 配信（従来通り）。
   - **Step 2: R2 実体消去時の Kubo / IPFS フォールバック**:
     - R2 バケットに実体が存在せず、かつ `meta.contentCid`（または `targetCid`）が存在する場合：
     - **`filebaseGateway`（`https://ipfs.filebase.io/ipfs`）をゲートウェイ探索候補から 100% 完全に除外**。
     - 自宅 Kubo ゲートウェイ（`KUBO_GATEWAY_URL`）および公共 IPFS ゲートウェイ（`dweb.link`, `ipfs.io`, `gateway.pinata.cloud`, `4everland.io`）のみを探索。
     - DHT 経由で自宅 Kubo からブロックを取り寄せて配信。
   - **効果**:
     - Filebase の転送枠・リクエスト枠を 1 ミリも消費しない。
      - Filebase の 404 待ちタイムアウトによる無駄な遅延（数秒）を完全に根絶。

---

## 🌊 [改修案] IPFS漂流中（Drifting）判定ロジックの改善と安全ガード

### 1. 現状の漂流判定ロジックとその問題点

#### 現在のコード（`app.js` Filebase一覧カード描画部分）
```javascript
const isFromS3 = item.isFromS3;         // Filebase S3 に実体が存在するか
const hasKuboRecord = isKuboPinned || item.metadata?.kuboStatus === "pinned";
// 漂流バッジ表示条件:
if (!isFromS3 && !hasKuboRecord) {
  // 🌊 IPFS漂流中 バッジを表示
}
```

#### 問題点

| # | 問題 | 詳細 |
|---|------|------|
| **P1** | **IPFSネットワーク実在確認をしていない** | `!isFromS3 && !hasKuboRecord` はあくまで「Filebaseにもない・Kuboにもない」という消極的な判定であり、**実際にIPFSネットワーク上に漂っているかどうかは未検証**。ブラウザからDHTルックアップ（10〜30秒/CID）を全ファイルに実行するのは非現実的であり、厳密判定は実装困難。 |
| **P2** | **ゾンビKVレコード問題** | Filebase実体をアンピン（FIFO容量解放）した後、Kuboにも保全されていないファイルは「漂流中」と表示されるが、**実際にはIPFSネットワーク上にも存在しない完全消滅ファイル**である可能性が高い。にもかかわらず、KV台帳にレコードが残り続けるため、一覧から永遠に消えない「ゾンビレコード」となる。 |
| **P3** | **Filebaseセクションでしか表示されない** | 漂流バッジはFilebase一覧のカード描画時にしか判定されておらず、**R2セクションには漂流バッジが存在しない**。R2起源ファイルでもKubo導入により漂流状態が発生しうる（後述）。 |
| **P4** | **サムネイル取得の実現性** | 漂流中ファイルのサムネイルはIPFSゲートウェイ経由で取得を試みるが、DHT上の他ノードが持っていない場合は取得不可能。また、サムネイル自体が画像・動画にしか適用されないため、その他ファイル形式では判断材料にならない。 |

---

### 2. R2起源ファイルにおける漂流シナリオ（Kubo導入により新たに発生）

Kubo統合の導入により、R2ファイルについても以下の「漂流」シナリオが発生しうる:

#### シナリオ1: R2実体削除 → Kuboアンピン → 完全消滅
```
R2にファイル実体あり → [⚡R2保管中] バッジクリックでR2実体削除 
→ Kuboのみに保全 → [🟣 Kubo保持中] からアンピン 
→ R2にもKuboにもFilebaseにもない → 💀 完全消滅
```
- **危険度: 極高** — ユーザーが「Kuboにあるから大丈夫」と思ってR2を消した後、うっかりKuboもアンピンすると取り返しがつかない。

#### シナリオ2: R2実体削除 → Kuboのみ保持（擬似漂流）
```
R2にファイル実体あり → R2実体削除 → Kuboのみに保全中
→ 自宅Kuboノードがオフライン → 公共ゲートウェイからアクセス不能
```
- **危険度: 中** — 自宅KuboノードのDHT拡散力が低い場合（NAT越し、Tailscaleのみ等）、公共IPFSゲートウェイがブロックを発見できず、事実上アクセス不能な「擬似漂流」状態になる。Kuboが起動中でもDHTへの告知が不十分なら同様。

#### シナリオ3: R2 FIFO容量解放 → Kubo自動Pin → Kuboオフライン
```
R2容量85%超 → FIFO発動 → kuboAutoPinR2=ON → Kuboへ自動Pin 
→ R2実体削除 → 後日Kuboノード停止 → 擬似漂流状態
```

---

### 3. 改修案

#### 【案A】KVレコード自動削除（ゾンビ根絶）— 推奨
- **内容**: 一覧取得・カード描画時に、以下の条件をすべて満たすKVレコードを自動的に削除する:
  - Filebase S3に実体がない（`!isFromS3`）
  - R2バケットに実体がない（`!isFromR2` — R2起源ファイルの場合）
  - Kuboにピン留めされていない（`!hasKuboRecord`）
  - → **3ストレージすべてに実体がないレコードは、KV台帳から自動消去**
- **実装イメージ**:
  ```javascript
  // カード描画時（Filebase一覧 / R2一覧 共通）
  const isOrphan = !isFromS3 && !isFromR2 && !hasKuboRecord;
  if (isOrphan) {
    // KV台帳からレコードを非同期で削除（画面からも即時除去）
    await deleteKvRecord(item.rawKey);
    console.log(`🧹 ゾンビレコード削除: ${item.rawKey}`);
    return; // カード描画をスキップ
  }
  ```
- **メリット**: ゾンビレコードが永久に蓄積する問題を根絶。一覧がクリーンに保たれる。
- **注意点**: IPFSネットワーク上に漂っている可能性のあるファイルも消えるが、自宅Kuboの拡散力が低い環境では事実上アクセス不能なため、実害は極小。

#### 【案B】一括クリーンアップボタン
- **内容**: 設定画面またはFilebase一覧のヘッダーに「🧹 漂流リンクを一括整理」ボタンを設置。押下すると、案Aと同じ判定で該当レコードを一括削除する。
- **メリット**: ユーザーが意図したタイミングでのみ削除されるため、案Aより安全。
- **デメリット**: ボタンを押さなければゾンビは永遠に残る。存在に気づかないユーザーが多い。

#### 【案C】表示フィルタトグル
- **内容**: Filebase一覧に「漂流中アイテムを表示/非表示」のトグルスイッチを追加。デフォルトは非表示。
- **メリット**: データは残すが見えなくする。将来IPFSゲートウェイが改善して取得可能になった場合に再表示できる。
- **デメリット**: KV台帳の肥大化は止まらない。根本解決ではない。

#### 推奨: 案A + 案Bのハイブリッド
- 通常は案Aの自動削除で静かにゾンビを除去。
- 設定画面に案Bのボタンも設置し、「現在の漂流レコード数」を表示して手動一括清掃も可能にする。

---

### 4. 安全ガード（データ完全消滅の防止）

#### ガード①: R2起源ファイルにも漂流バッジを表示
- **現状**: Filebase一覧にしか漂流バッジがない。
- **改修**: R2一覧カードにも、R2実体なし＆Kubo未保持の場合に `🌊 IPFS漂流中` バッジを表示。
- **効果**: R2ユーザーにも「このファイルはどこにも安全に保管されていない」ことを視覚的に警告。

#### ガード②: Kuboアンピン時の「最後の砦」ロック
- **条件**: R2に実体がなく（R2から既に削除済み）、かつFilebaseにも実体がないファイルに対して、Kuboアンピンを試みた場合。
- **動作**: 確認ダイアログを強化し、「⚠️ このファイルは自宅Kuboが唯一の保管場所です。アンピンするとファイルが完全に消滅します。本当にアンピンしますか？」と最終警告を表示。
- **追加オプション**: `block`モード（アンピン自体を物理的に禁止）を設定チェックボックスで選択可能にする。

#### ガード③: R2実体削除時のKubo保全確認
- **条件**: R2実体を削除する `[⚡ R2保管中]` バッジクリック時。
- **動作（既存）**: Kubo未保持時はクリック不可（既に実装済み）。
- **追加確認**: Kubo保持中でも、「自宅Kuboノードのみに保管されます。ノード停止時はアクセスできなくなる場合があります」の注記を確認ダイアログに追加。

---

### 5. 自宅KuboノードDHT拡散力の弱点と緩和策

#### 問題
- 自宅Kuboノード（特にNAT越し・Tailscaleのみ接続）は、IPFSのDHTへのブロック告知力が弱い。
- 公共IPFSゲートウェイ（`dweb.link`, `ipfs.io` 等）がDHTルックアップしても、自宅ノードを発見できない場合がある。
- 結果として、Kuboに確実にPinされているにもかかわらず、配信URLからアクセス不能になる。

#### 緩和策: 直接Kuboゲートウェイルーティング（`delivery.js`）
- **既存の仕組み**: `delivery.js` は環境変数 `KUBO_GATEWAY_URL`（例: `https://host01.koala-halibut.ts.net:8443`）を最優先ゲートウェイとして使用する機構を既に持っている。
- **改善案**:
  1. **Cloudflare Tunnel経由の直結**: Tailscale内部URLではなく、Cloudflare Tunnel（`cloudflared`）で自宅KuboのゲートウェイをパブリックURLとして公開し、`KUBO_GATEWAY_URL` に設定。これによりWorkerから直接自宅Kuboへアクセス可能になる（DHTバイパス）。
  2. **台帳フラグ活用**: `kuboStatus === "pinned"` かつ R2/Filebase実体なしのファイルは、公共GWより先に `KUBO_GATEWAY_URL` を試行し、DHT探索の遅延・失敗を回避。
  3. **ヘルスチェック**: Worker起動時またはリクエスト時に `KUBO_GATEWAY_URL` の疎通を簡易チェックし、オフライン時は公共GWにフォールバック。

---

### 6. サムネイル取得の実現性と限界

| ファイル種別 | サムネイル取得方法 | 漂流中の取得可否 |
|---|---|---|
| **画像** (`.webp`, `.png`, `.jpg`) | IPFSゲートウェイ経由で実体を取得 → ブラウザが描画 | ❌ DHTで発見できなければ不可。Kuboオフラインなら確実に失敗 |
| **動画** (`.mp4`, `.webm`) | `<video>` の `preload="metadata"` でフレーム取得、または `.thumb.webp` サムネイル | ❌ 同上。`.thumb.webp` もFilebase/R2に依存 |
| **その他** (`.pdf`, `.zip` 等) | サムネイル機構なし | N/A |

     - 既存実体を参照する新名カードを KV に即時登録（通信量ゼロ・容量消費ゼロ・待ち時間ゼロ）。
  4. **キャッシュ連動破棄**:
     - 単体削除・一括削除・FIFO 削除のすべてにおいて、実体消去時に `deleteR2Hash(key)` を呼び出し、ローカルのハッシュキャッシュを即座に破棄。

---

### 3. 総合アーキテクチャの完成形
以上の改修により、**「Filebase（真の IPFS）と Cloudflare R2（擬似 IPFS）が、共通の KV 台帳レイヤーの上で完全に対等・安全に両立するハイブリッド・メディアインフラ」** が完成した。

---

## 🌐 [IPFS/Kubo 統合＆ストレージ移行] R2 への UnixFS CID 統一・Kubo 実体注入 ＆ 選択的ゲートウェイルーティング

### 1. 改修の背景と目的
- **現状の課題**:
  - R2 は SHA-256 ハッシュで重複排除を行っていたため、Filebase（IPFS UnixFS CID）とハッシュ体系が分裂していた。
  - R2 で保管しているファイルを自宅 Kubo（IPFS ノード）へ移したい場合、ブラウザから実体を Kubo へ流し込む手段（`/api/v0/add`）が未連携だった。
  - 将来「数年後に R2 の容量を空けるため実体を消し、自宅 Kubo のみに残す」運用へ移行した際、Worker が Filebase ゲートウェイに無駄な問い合わせを行い、Filebase 帯域消費や 404 待ち遅延が発生する恐れがあった。
- **改修の目的**:
  1. **CID の一本化**: R2 アップロード時も Filebase と全く同じ IPFS UnixFS CID（`calculateFilebaseCid`）を事前計算して台帳に記録。
  2. **自宅 Kubo への実体注入**: R2 カードの `[📌 KuboにPin]` を押すと、Kubo RPC（`/api/v0/add`）へ直接 Blob を POST して即座にローカル保全＆DHT告知。
  3. **安全な R2 実体消去（ライフサイクルガード）**: 自宅 Kubo に Pin 留めされている時だけ `[⚡ R2保管中]` バッジをクリック可能にし、安全に R2 実体を消去してバケット容量を解放。
  4. **配信レイヤの相互排他＆Filebase完全除外ルーティング**: R2 起源のファイル（`meta.backend === "r2"`）が R2 から消去されて Kubo 保持になった場合、Filebase ゲートウェイを完全にスキップし、公共 IPFS / 自宅 Kubo ゲートウェイのみを探索して配信。

---

### 2. コンポーネント別の詳細設計と改修仕様

#### ① フロントエンド (`cividge/app.js` / `cividge/kubo-client.js`)
1. **UnixFS CID 計算の一本化**:
   - R2 アップロード前に `calculateFilebaseCid(file)` を実行し、CID（`bafy...`）を算出。
   - KV メタデータに `meta.contentCid = cid`、`meta.backend = "r2"`（短縮 `meta.b = "r2"`）、`targetCid = "r2"` を記録。
   - 重複判定も CID をキーとして行い、同一ファイルのアップロードを通信ゼロで即時エイリアス化。
2. **Kubo 実体注入 API の追加 (`kubo-client.js`)**:
   - `addFileToKubo(blob, filename)` を新設。
   - 現在の RPC 設定（標準 `http://127.0.0.1:5001`）へ `POST /api/v0/add?pin=true` を送信（追加のポート開放や CORS 設定は不要、既存設定のまま動作）。
3. **R2 カードのバッジ UI と安全ライフサイクルガード**:
   - **`[📦 CID 📋]`**: 計算された UnixFS CID をクリップボードにコピー。
   - **`[🟣 Kubo保持中]` / `[📌 KuboにPin]`**:
     - 既存の同一 CID がすでに Kubo に Pin されていれば、アップロード直後から即座に `[🟣 Kubo保持中]` を表示。
     - 未保持の場合、`[📌 KuboにPin]` を押すと R2 から Blob を取得して Kubo の `/api/v0/add` に注入・Pin 留め。
   - **`[⚡ R2保管中]` (安全ライフサイクルガード)**:
     - Kubo 未保持時はクリック不可（誤って実体を消して消失する事故を物理防止）。
     - Kubo 保持中（自宅に実体がある）時のみクリック可能になり、確認ダイアログを経て R2 バケットから実体を削除。
     - 削除後は `[⚡ R2: 未保持 (Kubo保全中)]` に切り替わり、バケット容量を安全に回収。

#### ② 配信レイヤ (`cividge-kv-worker/delivery.js`)
1. **R2 ➔ Kubo フォールバック ＆ Filebase 完全除外ルーティング**:
   - 台帳の `meta.backend === "r2"` または `meta.b === "r2"` を判定。
   - **Step 1: R2 バケット確認**:
     - `env.R2_BUCKET.get(r2Key)` で実体が存在すれば、最速・Egress ゼロで即時 200 配信（従来通り）。
   - **Step 2: R2 実体消去時の Kubo / IPFS フォールバック**:
     - R2 バケットに実体が存在せず、かつ `meta.contentCid`（または `targetCid`）が存在する場合：
     - **`filebaseGateway`（`https://ipfs.filebase.io/ipfs`）をゲートウェイ探索候補から 100% 完全に除外**。
     - 自宅 Kubo ゲートウェイ（`KUBO_GATEWAY_URL`）および公共 IPFS ゲートウェイ（`dweb.link`, `ipfs.io`, `gateway.pinata.cloud`, `4everland.io`）のみを探索。
     - DHT 経由で自宅 Kubo からブロックを取り寄せて配信。
   - **効果**:
     - Filebase の転送枠・リクエスト枠を 1 ミリも消費しない。
      - Filebase の 404 待ちタイムアウトによる無駄な遅延（数秒）を完全に根絶。

---

## 🌊 [改修案] IPFS漂流中（Drifting）判定ロジックの改善と安全ガード

### 1. 現状の漂流判定ロジックとその問題点

#### 現在のコード（`app.js` Filebase一覧カード描画部分）
```javascript
const isFromS3 = item.isFromS3;         // Filebase S3 に実体が存在するか
const hasKuboRecord = isKuboPinned || item.metadata?.kuboStatus === "pinned";
// 漂流バッジ表示条件:
if (!isFromS3 && !hasKuboRecord) {
  // 🌊 IPFS漂流中 バッジを表示
}
```

#### 問題点

| # | 問題 | 詳細 |
|---|------|------|
| **P1** | **IPFSネットワーク実在確認をしていない** | `!isFromS3 && !hasKuboRecord` はあくまで「Filebaseにもない・Kuboにもない」という消極的な判定であり、**実際にIPFSネットワーク上に漂っているかどうかは未検証**。ブラウザからDHTルックアップ（10〜30秒/CID）を全ファイルに実行するのは非現実的であり、厳密判定は実装困難。 |
| **P2** | **ゾンビKVレコード問題** | Filebase実体をアンピン（FIFO容量解放）した後、Kuboにも保全されていないファイルは「漂流中」と表示されるが、**実際にはIPFSネットワーク上にも存在しない完全消滅ファイル**である可能性が高い。にもかかわらず、KV台帳にレコードが残り続けるため、一覧から永遠に消えない「ゾンビレコード」となる。 |
| **P3** | **Filebaseセクションでしか表示されない** | 漂流バッジはFilebase一覧のカード描画時にしか判定されておらず、**R2セクションには漂流バッジが存在しない**。R2起源ファイルでもKubo導入により漂流状態が発生しうる（後述）。 |
| **P4** | **サムネイル取得の実現性** | 漂流中ファイルのサムネイルはIPFSゲートウェイ経由で取得を試みるが、DHT上の他ノードが持っていない場合は取得不可能。また、サムネイル自体が画像・動画にしか適用されないため、その他ファイル形式では判断材料にならない。 |

---

### 2. R2起源ファイルにおける漂流シナリオ（Kubo導入により新たに発生）

Kubo統合の導入により、R2ファイルについても以下の「漂流」シナリオが発生しうる:

#### シナリオ1: R2実体削除 → Kuboアンピン → 完全消滅
```
R2にファイル実体あり → [⚡R2保管中] バッジクリックでR2実体削除 
→ Kuboのみに保全 → [🟣 Kubo保持中] からアンピン 
→ R2にもKuboにもFilebaseにもない → 💀 完全消滅
```
- **危険度: 極高** — ユーザーが「Kuboにあるから大丈夫」と思ってR2を消した後、うっかりKuboもアンピンすると取り返しがつかない。

#### シナリオ2: R2実体削除 → Kuboのみ保持（擬似漂流）
```
R2にファイル実体あり → R2実体削除 → Kuboのみに保全中
→ 自宅Kuboノードがオフライン → 公共ゲートウェイからアクセス不能
```
- **危険度: 中** — 自宅KuboノードのDHT拡散力が低い場合（NAT越し、Tailscaleのみ等）、公共IPFSゲートウェイがブロックを発見できず、事実上アクセス不能な「擬似漂流」状態になる。Kuboが起動中でもDHTへの告知が不十分なら同様。

#### シナリオ3: R2 FIFO容量解放 → Kubo自動Pin → Kuboオフライン
```
R2容量85%超 → FIFO発動 → kuboAutoPinR2=ON → Kuboへ自動Pin 
→ R2実体削除 → 後日Kuboノード停止 → 擬似漂流状態
```

---

### 3. 改修案

#### 【案A】KVレコード自動削除（ゾンビ根絶）— 推奨
- **内容**: 一覧取得・カード描画時に、以下の条件をすべて満たすKVレコードを自動的に削除する:
  - Filebase S3に実体がない（`!isFromS3`）
  - R2バケットに実体がない（`!isFromR2` — R2起源ファイルの場合）
  - Kuboにピン留めされていない（`!hasKuboRecord`）
  - → **3ストレージすべてに実体がないレコードは、KV台帳から自動消去**
- **実装イメージ**:
  ```javascript
  // カード描画時（Filebase一覧 / R2一覧 共通）
  const isOrphan = !isFromS3 && !isFromR2 && !hasKuboRecord;
  if (isOrphan) {
    // KV台帳からレコードを非同期で削除（画面からも即時除去）
    await deleteKvRecord(item.rawKey);
    console.log(`🧹 ゾンビレコード削除: ${item.rawKey}`);
    return; // カード描画をスキップ
  }
  ```
- **メリット**: ゾンビレコードが永久に蓄積する問題を根絶。一覧がクリーンに保たれる。
- **注意点**: IPFSネットワーク上に漂っている可能性のあるファイルも消えるが、自宅Kuboの拡散力が低い環境では事実上アクセス不能なため、実害は極小。

#### 【案B】一括クリーンアップボタン
- **内容**: 設定画面またはFilebase一覧のヘッダーに「🧹 漂流リンクを一括整理」ボタンを設置。押下すると、案Aと同じ判定で該当レコードを一括削除する。
- **メリット**: ユーザーが意図したタイミングでしか削除されないため、案Aより安全。
- **デメリット**: ボタンを押さなければゾンビは永遠に残る。存在に気づかないユーザーが多い。

#### 【案C】表示フィルタトグル
- **内容**: Filebase一覧に「漂流中アイテムを表示/非表示」のトグルスイッチを追加。デフォルトは非表示。
- **メリット**: データは残すが見えなくする。将来IPFSゲートウェイが改善して取得可能になった場合に再表示できる。
- **デメリット**: KV台帳の肥大化は止まらない。根本解決ではない。

#### 推奨: 案A + 案Bのハイブリッド
- 通常は案Aの自動削除で静かにゾンビを除去。
- 設定画面に案Bのボタンも設置し、「現在の漂流レコード数」を表示して手動一括清掃も可能にする。

---

### 4. 安全ガード（データ完全消滅の防止）

#### ガード①: R2起源ファイルにも漂流バッジを表示
- **現状**: Filebase一覧にしか漂流バッジがない。
- **改修**: R2一覧カードにも、R2実体なし＆Kubo未保持の場合に `🌊 IPFS漂流中` バッジを表示。
- **効果**: R2ユーザーにも「このファイルはどこにも安全に保管されていない」ことを視覚的に警告。

#### ガード②: Kuboアンピン時の「最後の砦」ロック
- **条件**: R2に実体がなく（R2から既に削除済み）、かつFilebaseにも実体がないファイルに対して、Kuboアンピンを試みた場合。
- **動作**: 確認ダイアログを強化し、「⚠️ このファイルは自宅Kuboが唯一の保管場所です。アンピンするとファイルが完全に消滅します。本当にアンピンしますか？」と最終警告を表示。
- **追加オプション**: `block`モード（アンピン自体を物理的に禁止）を設定チェックボックスで選択可能にする。

#### ガード③: R2実体削除時のKubo保全確認
- **条件**: R2実体を削除する `[⚡ R2保管中]` バッジクリック時。
- **動作（既存）**: Kubo未保持時はクリック不可（既に実装済み）。
- **追加確認**: Kubo保持中でも、「自宅Kuboノードのみに保管されます。ノード停止時はアクセスできなくなる場合があります」の注記を確認ダイアログに追加。

---

### 5. 自宅KuboノードDHT拡散力の弱点と緩和策

#### 問題
- 自宅Kuboノード（特にNAT越し・Tailscaleのみ接続）は、IPFSのDHTへのブロック告知力が弱い。
- 公共IPFSゲートウェイ（`dweb.link`, `ipfs.io` 等）がDHTルックアップしても、自宅ノードを発見できない場合がある。
- 結果として、Kuboに確実にPinされているにもかかわらず、配信URLからアクセス不能になる。

#### 緩和策: 直接Kuboゲートウェイルーティング（`delivery.js`）
- **既存の仕組み**: `delivery.js` は環境変数 `KUBO_GATEWAY_URL`（例: `https://host01.koala-halibut.ts.net:8443`）を最優先ゲートウェイとして使用する機構を既に持っている。
- **改善案**:
  1. **Cloudflare Tunnel経由の直結**: Tailscale内部URLではなく、Cloudflare Tunnel（`cloudflared`）で自宅KuboのゲートウェイをパブリックURLとして公開し、`KUBO_GATEWAY_URL` に設定。これによりWorkerから直接自宅Kuboへアクセス可能になる（DHTバイパス）。
  2. **台帳フラグ活用**: `kuboStatus === "pinned"` かつ R2/Filebase実体なしのファイルは、公共GWより先に `KUBO_GATEWAY_URL` を試行し、DHT探索の遅延・失敗を回避。
  3. **ヘルスチェック**: Worker起動時またはリクエスト時に `KUBO_GATEWAY_URL` の疎通を簡易チェックし、オフライン時は公共GWにフォールバック。

---

### 6. サムネイル取得の実現性と限界

| ファイル種別 | サムネイル取得方法 | 漂流中の取得可否 |
|---|---|---|
| **画像** (`.webp`, `.png`, `.jpg`) | IPFSゲートウェイ経由で実体を取得 → ブラウザが描画 | ❌ DHTで発見できなければ不可。Kuboオフラインなら確実に失敗 |
| **動画** (`.mp4`, `.webm`) | `<video>` の `preload="metadata"` でフレーム取得、または `.thumb.webp` サムネイル | ❌ 同上。`.thumb.webp` もFilebase/R2に依存 |
| **その他** (`.pdf`, `.zip` 等) | サムネイル機構なし | N/A |

- **結論**: 漂流中ファイルのサムネイル取得は実質的に不可能。漂流バッジの判定にサムネイル取得可否を使うことは非現実的。
- **代替案**: 漂流中ファイルのカードは専用のプレースホルダー画像（`🌊` アイコン等）を表示し、実体アクセスを試みない。

---

### 7. 実装優先度

| 優先度 | 項目 | 工数目安 |
|---|------|---------|
| **🔴 高** | 案A: ゾンビKVレコード自動削除 | 小（判定条件追加 + deleteKvRecord呼び出し） |
| **🔴 高** | ガード②: Kuboアンピン最終警告 | 小（confirmダイアログの条件分岐追加） |
| **🟡 中** | R2セクションへの漂流バッジ追加 | 中（R2カード描画にFilebase同等のバッジロジック移植） |
| **🟡 中** | 案B: 一括クリーンアップボタン | 小（ボタンUI + 案Aのロジック一括実行） |
| **🟢 低** | 直接Kuboゲートウェイ（Tunnel）設定ガイド | ドキュメント整備のみ |
| **🟢 低** | 案C: 表示フィルタトグル | 小（CSS/state切り替え） |

---

## 🌊 [実装完了] 全ファイル形式一律HEAD ＆ 3ストライク・ファジー判定によるゾンビKV自動整理

### 1. 設計思想とアーキテクチャ
- **背景**:
  - Filebase・R2・自宅Kuboのいずれにも実体が存在しない（全アンピン）ファイルが、KV台帳に残り続けて一覧から永遠に消えない「ゾンビレコード」問題を解決。
  - 「たまたま1回のタイムアウトで誤削除（ロスト）する」事故を根絶しつつ、KV書き込み枠（無料枠1,000回/日）を1回も消費しない完全な安全設計を確立。
- **採用方針: 全ファイル一律 HEAD ＋ 3ストライク・ファジー判定**:
  - **関心の分離**: 画像サムネイル描画イベント（見た目）に死活監視を混ぜ込まず、専用の軽量 `HEAD` リクエストに完全統一。
  - **死んだ実体に対する負荷軽減**: 消滅した大容量動画・画像を `<img src>` で丸ごとGETしにいく重いコネクションを抑止し、数百バイトの HEAD だけで迅速・軽量に判定。
  - **localStorage によるファジー管理**:
    - 前回の失敗から「1時間以上」経過している場合のみ失敗カウントを加算（F5連打防止ガード）。
    - 途中でエッジキャッシュやIPFSから1回でも拾えたらカウントを即座にゼロ（完全復帰）リセット。
    - 別々のタイミングで「3回連続失敗」した時点で初めてKV台帳から安全に自動抹消（成仏）。

### 2. コンポーネント別の実装内容 (`app.js`)
1. **i18nラベル拡張 (`getStorageListLabels`)**:
   - `ipfsDriftingAlive`: `🌊 漂流中 (生存確認)` / `🌊 Drifting (Alive)`
   - `ipfsDriftingMiss`: `⚠️ 漂流中 (応答なし {n}/3)` / `⚠️ Drifting (Miss {n}/3)`
2. **ローカルストレージ管理 (`cividge_drift_fail_counts`)**:
   - `getDriftFailCounts()`: 辞書オブジェクトを読み出し。
   - `recordDriftCheckResult(rawKey, isAlive)`: 成功時リセット、1時間クールダウン判定、3回判定。
3. **軽量 HEAD 死活確認 (`checkDriftSurvival(url)`)**:
   - 4秒タイムアウト（`AbortController`）、`cache: "no-store"`、データ転送 0 バイト。
4. **非同期オーケストレーター (`auditDriftingFiles(contents)`)**:
   - 一覧描画直後にバックグラウンドで非同期実行（画面ブロックなし）。
   - Filebase / R2 双方の全アンピンファイル（`!isFromS3 && !hasKuboRecord`）を抽出して巡回。
   - 3回失敗確定時は `deleteKvCid(rawKey)` を実行し、DOMカードをフェードアウト消去。
5. **カード初期描画バッジ (`renderCurrentStoragePage`)**:
   - FilebaseおよびR2カード生成時に、localStorageの現在カウントを反映したバッジを描画。

---

## 🛡️ [不変条件確立] エイリアス作成時のストレージ境界完全分離 ([INV-FRONT-005])

### 1. 発生した問題とメカニズム
- **現象**: Filebase 側のカードから別ドメイン（`kv.k7m.f5.si`）のエイリアスを追加した際、Filebase 一覧に表示されず、なぜか Cloudflare R2 一覧にカードが追加されてしまった。
- **原因**:
  1. 同一ファイルが Filebase と R2 の両方に保存されていた。
  2. エイリアス作成時（`app.js`）、`registerKvCid` に所属ストレージ情報（`backend: "filebase"`）が渡されておらず、KVメタデータ上の帰属が未設定だった。
  3. R2 一覧の構築ロジックが、「R2 バケット内に同名ファイルが存在するか」だけで判定していたため、R2 の同名オブジェクトにエイリアスが吸着され、R2 カードとして誤認・誤表示された。

### 2. 修正内容と不変条件の適用
1. **エイリアス作成時の帰属固定 (`app.js`)**:
   - 元カードの属性（`article.dataset.provider`）を参照し、`registerKvCid` に `backend: isFilebase ? "filebase" : "r2"` を100%確実に書き込むよう修正。
   - 元カードやローカルキャッシュから UnixFS CID を確実に解決・継承し、CID 空文字での登録を防止。
2. **一覧振り分け時の絶対優先判定 (`app.js`)**:
   - `backend === "filebase"` のレコードは、R2 バケット内に同名ファイルが存在していても **絶対に R2 一覧から除外**。
   - `backend === "r2"` のレコードは、**絶対に Filebase 一覧から除外**。
3. **不変条件ドキュメント成文化 (`INVARIANTS.md`)**:
   - `[INV-FRONT-005] ストレージ境界の完全分離（エイリアス・カード帰属の不変条件）` を追加し、二重保存時のストレージ間吸着バグの再発を永久防止。

---

## 🔒 [実装完了] 配信ドメインの互換レイヤ検証・ストレージ排他ガード・宗派替え事故防止 ([INV-FRONT-006])

### 1. 背景と課題意識
- **直結独自ドメイン（非リレー環境）の特性**:
  - 静的 Pages リレー（`_redirects` 307）を使わず、`kv.k7m.f5.si` などの独自ドメインを Worker に直結して配信する場合、リダイレクトを挟まないため「アクセス時の動的なストレージ振り分け」は原理的に不可能（リクエストされた URL 自体が一意でなければならない）。
- **潜在的な事故リスク**:
  1. **互換レイヤ未接続（素のストレージ）ドメインの二重登録事故**:
     - 互換レイヤ（Worker）を通していない素の R2 バケット公開ドメインや素の IPFS ゲートウェイを、ユーザーが誤って「R2 と Filebase の両方の配信ドメイン」に登録して同名ファイルをアップロードすると、ファイルの上書き破壊消滅や 404 が発生する。
  2. **ドメインの「宗派替え（乗り換え）」による過去URLすり替わり事故**:
     - ユーザーが R2 配信ドメインとして使っていたドメインを一旦設定から削除し、その後に Filebase 配信ドメインとして再登録して同名ファイルをアップロードした場合、過去に共有した R2 ファイルの URL が突然 Filebase の別ファイルにすり替わってしまう。

---

### 2. 補強案の全体アーキテクチャ

#### ① 配信ドメインの「互換レイヤ接続テスト」＆フラグ管理
設定画面の各配信ドメインの横に `[🔍 接続テスト]` ボタンを設置し、そのドメインが Cividge の互換レイヤ（Worker）に正しく繋がっているかを検証する。

- **検証プローブ通信**:
  ブラウザから対象ドメインに対して軽量プローブを送信：
  `fetch("https://<登録ドメイン>/404-character.webp", { method: "HEAD", cache: "no-store" })`
  または
  `fetch("https://<登録ドメイン>/api/cividge-kv?probe=1", { method: "HEAD", cache: "no-store" })`
- **判定結果と localStorage 永続化**:
  ```json
  // localStorage: "cividge_domain_compat_flags"
  {
    "https://kv.k7m.f5.si": { "hasCompatLayer": true, "testedAt": 1726735000000 },
    "https://pub-xxx.r2.dev": { "hasCompatLayer": false, "testedAt": 1726735000000 }
  }
  ```
- **UI 表示**:
  - 合格: `🟢 互換レイヤ接続済（両ストレージ併用可能）`
  - 未合格: `⚠️ 直結・未接続モード（ストレージ排他設定）`

#### ② 互換レイヤ未接続ドメインの「ストレージ排反（排他）ルール」
- **ルール**:
  - `hasCompatLayer === true` のドメイン:
    - Worker が `allowedHost` と `backend` メタデータにより安全に個別ルーティングできるため、**R2 と Filebase の両方の配信ドメインに登録・併用することを許可**。
  - `hasCompatLayer === false`（未テスト含む）のドメイン:
    - 衝突事故を防ぐため、**R2 と Filebase の両方に同一ドメインを登録することを厳格に禁止（必ず排反・排他）**。
    - 片方に登録されている状態で他方にも追加しようとした場合、「🚫 このドメインは互換レイヤの接続テストに合格していません。事故防止のため、両ストレージで同じドメインを設定することはできません。[接続テスト] を実行して合格するか、別々のドメインを指定してください」と警告を出してブロック。

---

### 3. ドメイン宗派替え（乗り換え）事故の完全防護（2重ロック）

ユーザーが設定画面からドメインを消して別ストレージへ鞍替えしようとした際の事故を、**KV台帳の「唯一の真実」に基づいて 100% 水際で叩き落とす**。

#### ロック1: 【台帳実体チェック】別ストレージ登録時の残存ファイル走査
ユーザーが新しいドメイン（例: `https://media.com`）を Filebase に登録しようとした瞬間、フロントエンドが KV 台帳（`fetchKvFiles()`）を走査する。
- **条件**:
  そのドメイン（`media.com:*`）に紐づくレコードで、かつ他方ストレージ（`backend === "r2"`）のファイルが **1 件でも台帳に残っている場合**。
- **挙動**:
  即座に登録を拒否し、以下の警告を表示してブロックする。
  `🚫 登録拒否: このドメイン（media.com）には、過去に R2 で登録されたファイルがまだ X 件残っています。過去の共有URLとの衝突やすり替わり事故を防ぐため、該当ファイルを全削除しない限り、別のストレージ（Filebase）へ登録することはできません。`

#### ロック2: 【消し忘れ防止】ドメイン設定削除時の残存ファイル警告
設定画面で配信ドメインのゴミ箱アイコン（削除）を押した際：
- そのドメインに紐づくファイルカード（エイリアス）が残っている場合、
  `⚠️ このドメインで配信中のファイルが X 件存在します。ドメインを削除するとこれらはアクセス不能になります。ファイルを削除してからドメインを削除してください。`
  と警告し、ドメイン設定の安易な削除自体をブロックする。

---

### 4. 却下されたアンチパターン（教訓）

1. **× コード側でリレー有無を嗅ぎ分けて勝手に `_r2` / `_fb` サフィックスをつける案**:
   - リレー経由か直結かをコードで判定してファイル名を変えるのは、判定ロジックが極めて壊れやすく、ユーザー体験（UX）もチグハグになるため却下。ファイル名は常に元の綺麗な名前を維持し、ドメインの分離と排他ガードで解決するのが正攻法。
2. **× localStorage にドメインの過去所属を永久固定する案（Tainted記録）**:
   - 過去のファイルを全削除して綺麗に整理した後の「正当なドメイン再利用」まで永久に阻害する「不必要な呪い」になってしまうため却下。端末ローカルではなく「KV台帳の残存ファイル有無（唯一の真実）」を基準にする設計が最も美しく安全。

---

### 5. 互換レイヤ検証済みドメインのミラー登録（連動チェックボックス）

互換レイヤ検証に合格したドメインは R2 / Filebase の両ストレージで安全に共有できるため、設定画面に連動登録チェックボックスを実装。

- **UI表示条件**:
  - `hasCompatLayer === true`（互換レイヤ接続済）の場合のみ表示。
  - 直結・未検証モードでは排他ルールの原則に基づき非表示。
- **表示文言**:
  - R2 側: `Filebase の配信ドメインにも登録`
  - Filebase 側: `R2 の配信ドメインにも登録`
- **動作**:
  - **チェック ON**: 他方ストレージのドメインリストへ現在のドメインを自動追加し、セレクトボックスを即時同期。
  - **チェック OFF**: 他方ストレージのドメインリストから解除。
    - **安全ガード**: 他方ストレージ側にこのドメインで配信中のファイルが残っている場合は、`[INV-FRONT-006]` の残存ファイル保護ロックが作動し、解除をブロックして警告を表示（チェック状態も元に戻す）。

---

### 6. R2 一括削除エラー（Failed to fetch）の原因と恒久対策

#### 原因
S3 API 仕様上、単一ファイル削除（`DeleteObjectCommand`）は HTTP `DELETE` メソッドを使用するが、複数一括削除（`DeleteObjectsCommand`）は XML ペイロードを伴う **HTTP `POST /?delete`** メソッドを使用する。
従来の R2 CORS ポリシー案内では `AllowedMethods` が `["GET", "HEAD", "PUT", "DELETE"]` と定義されており、**`POST` が欠落していた**。
このため、ブラウザから R2 に対して一括削除を実行した瞬間、CORS 違反によりブラウザがリクエストを遮断し、`Failed to fetch` が発生していた。

#### 対策
1. **アプリコード側の安全フォールバック (`safeDeleteS3Objects`)**:
   - `DeleteObjectsCommand`（POST）を実行し、もし CORS やネットワーク起因でエラーとなった場合は、**自動的に `DeleteObjectCommand`（DELETE）の並行ループへフォールバックして削除を完了**させる。
   - これにより、ユーザーが R2 側の CORS ポリシーを手動更新していなくても、即座に一括削除が成功する。
2. **CORS 設定テンプレートの更新**:
   - 設定画面のプレビュー、オンボーディング案内、README.md のすべての R2 CORS テンプレートに `"POST"` を追加。

---

### 7. Cloudflare KV `list()` 1日1,000回上限枯渇問題とアーキテクチャ検討

#### 概要
2026-09-20未明、Worker（`cividge-kv-worker`）の台帳API（`/api/cividge-kv`）が HTTP 500 (`KV list() limit exceeded for the day.`) を返し、フロントエンド側でファイル一覧が取得できなくなる事象が発生。

#### 原因の客観的分析
1. **構造的要因（1回の一覧取得で3倍消費）**:
   - フロントエンド（`app.js`）の `fetchAndRenderR2Files()` が走るたびに、以下の3つの `list()` が毎回同時に Worker へ送信されていた：
     1. `fetchKvFiles()` ➜ `(env.CIVIDGE_KV).list()` （全キー走査）
     2. `drainKuboTombstones()` ➜ `(env.CIVIDGE_KV).list({ prefix: "tombstone_" })` （墓標走査）
     3. `drainS3Tombstones()` ➜ `(env.CIVIDGE_KV).list({ prefix: "tombstone_s3_" })` （S3墓標走査）
   - 実質約 330 回の画面更新アクションで 1,000 回の上限に達する構造になっていた。
2. **トリガー要因（開発・動作確認時のイベント連打）**:
   - トークンや設定値の入力時、400ms debounce で `fetchAndRenderR2Files()` が自動発火。
   - アコーディオン移動、QRコード同期、タブ切替（R2 ⇔ Filebase）等の動作確認に伴うリロード・入力イベントの累積。
   - Cloudflare KV の無料枠カウントは UTC 0:00（日本時間 午前9:00）リセットのため、前日からの累積呼び出しが上限に達した。
3. **フロント側のガード不備**:
   - S3認証情報（R2/Filebase秘密鍵）が未設定の場合、KV台帳にデータがあってもオンボーディングカードを表示して一覧を非表示にする仕様になっていた。
   - `saveR2SettingsAuto` で未フォーカスの空欄が既存の localStorage を巻き添え削除（`removeItem`）するバグがあった。

#### 設計上の検討課題（list vs get / インデックスキャッシュ）
- **`kv.list()`（全件走査）**:
  - 実態との整合性が 100% 保たれ、外部投稿API（ShareX等）からの直接追加も即時反映される。
  - しかし無料枠が 1日 1,000 回と厳しく、画面操作やリロードで容易に枯渇する。
- **`kv.get()`（インデックス方式）**:
  - 1日 100,000 回（100倍）利用可能で超高速（5〜20ms）。
  - ただし「ファイル登録・削除時にインデックスを確実に更新・維持する」責務が生じ、外部投稿時の反映漏れや並行書き込み競合（レースコンディション）のリスクがある。
- **今後の設計検討**:
  - 墓標回収（tombstones）の切り離し（ファイル一覧取得ごとの無駄打ちを廃止、削除時のみまたは間隔制限）。
  - 通常アクセス時のキャッシュ活用（1,000回枠の温存）と、明示的リフレッシュ時の `list()` 実行による自己修復機構のバランス。

---

### 8. Cloudflare KV 消費削減・墓標ライフサイクル・台帳圧縮の恒久対策完了 (2026-09-20)

#### 実施した対策一覧
1. **墓標走査（Tombstone）の一覧取得からの完全分離と24時間ガード化**:
   - `fetchAndRenderR2Files()` 内から `drainKuboTombstones()` および `drainS3Tombstones()` を完全撤去。
   - `maybeDrainTombstonesDaily` を導入し、アプリ起動5秒後または手動リロード時、前回から24時間以上経過している場合のみ低優先度で1回だけ走査するよう変更。
   - 一覧表示1回あたりの消費が **3回 ➔ 1回（66%削減）**、墓標消費は **1日2回固定（95%削減）** に激減。
2. **墓標メモの30日TTL（消滅期限）撤廃**:
   - `_middleware.js`, `delivery.js`, `cividge-kv.js` の `expirationTtl: 86400 * 30` を削除。
   - わずか数十バイトの伝言メモが30日で消えて数MB〜数GBのS3実体が永久孤児化する本末転倒な設計を根絶し、回収完了まで確実に残る無期限保持へ変更。
3. **台帳型タプル圧縮ローカルキャッシュの導入**:
   - 一覧データを `[name, cid, size, unixSec, s3Key, backend, isFromS3, isKuboPinned]` の固定順タプル配列として localStorage に保存（`saveLedgerToLocalStorage` / `loadLedgerFromLocalStorage`）。
   - キー名の重複を完全排除し、データサイズを1件あたり **約110バイト（50〜60%削減）** に圧縮。ブラウザの5MB枠内で45,000件超まで安全に収容可能にした。
4. **タブ切り替え・ドメイン変更時の再フェッチ抑制**:
   - R2 ⇔ Filebase のストレージタブ切り替え時、およびドメイン選択変更時、KV通信を行わず手元のローカル台帳キャッシュから即座に画面再描画（`renderCurrentStoragePage()`）するよう最適化。
   - タブ切り替えやドメイン変更での KV 消費を **完全ゼロ（0回）** にした。
5. **一覧取得（GET）時の不要な `put()` 書き込み撤廃**:
   - `cividge-kv.js` の `onRequestGet` 内にあった `context.waitUntil(kv.put(INDEX_KEY, ...))` を削除。
   - ファイル一覧を閲覧するだけで書き込み枠（1日1,000回）を浪費していた二重消費を解消。
6. **ファイル削除時の Worker 側 `list()` 全件走査の完全撤廃**:
   - クライアント（ブラウザ）の手元台帳で「同一CIDの残存有無」を判定し、`make_tombstone=0/1` パラメータを Worker に伝達。
   - Worker 側の重い全件走査（`list()`）を完全スキップ。サムネイル削除時も `make_tombstone=0` を指定。
   - ファイル1件削除時の `list()` 消費が **2〜3回 ➔ 完全ゼロ（0回）** に激減。

---

### 9. 配信エッジにおける総当りKV探索の完全撤廃とDoS防御 [INV-DELIVERY-005] (2026-09-20)

#### 深刻な脆弱性の発見と原因
- **事象**: ファイル配信リクエストにおいて、存在しないURL（ランダム文字列等）を1回叩かれただけで、KVの `get()` が **5回〜10回も連打** される致命的な消費構造が存在していた。
- **原因**: 9月17日の改修（`b7ccacd`）において、静的リレー対応のために「登録された全Pagesホスト候補をループ走査するコード（`for (const host of candidateRelayHosts)`）」が安直に書かれていた。
  - 「山田太郎を探すのに鈴木太郎も佐藤太郎も全員呼び出す」状態になっており、存在しないURLの時に全ホスト分空振りしてKVを連打していた。
  - 悪意あるbotやクローラーから1秒に1回（1日約8.6万回）ランダムURLを叩かれた場合、**8.6万 × 5 ＝ 43万回** のKV読み込みが発生し、1日10万回の無料枠が午前中（わずか5時間）で即座に枯渇する脆弱性となっていた。

#### 恒久対策の実施
1. **[INV-DELIVERY-005] 不変条件の制定と総当りループの完全撤廃**:
   - リクエストされた単一ホスト（受信ホスト、またはリファラー/パラメータで特定されたリレーホスト）**1つだけ** を特定し、1回のみKVを照会する設計へ刷新。
   - 存在しないURL時のKV消費を **5〜10回 ➔ たったの1回** に正常化。
2. **エッジキャッシュ（Cache API）最前線ガードの配備**:
   - `delivery.js` の `onRequest` 先頭で `caches.default.match(request)` を照会。
   - 404 レスポンスをエッジキャッシュ（300秒間）に格納。
   - 同一の存在しないURLやランダムURLを反復連打されても、2回目以降のKV消費は **完全ゼロ（0回）** でエッジから即時門前払いする構成を確立。

---

### 10. アーキテクチャの根本原則と倫理憲章の明文化 [INV-CORE-001 / INV-CORE-002] (2026-09-20)

`INVARIANTS.md`（cividge および cividge-kv-worker 両リポジトリ）の最上位セクションとして「0. アーキテクチャの根本原則と倫理憲章」を制定・明文化した。

1. **[INV-CORE-001] 無料枠徹底節約とサイバー攻撃バッファの維持原則**:
   - Cloudflare 無料枠（KV書き込み・リスト1,000回/日、読み込み100,000回/日）での完全自活を前提とする。
   - 1秒に1回（1日約8.6万回）のランダムURL DoS攻撃を受けても、残り1万数千回で正規サービスが破綻せず継続できるだけの圧倒的な節約アルゴリズムを設計の最優先事項とする。
2. **[INV-CORE-002] 完全BYOCと開発者非特権・秘密情報非ハードコード原則**:
   - フロントエンド（`cividge.pages.dev`）は全ユーザー共通の入口に過ぎず、バックエンドは各ユーザーが自己所有（BYOC）する。
   - 開発者自身も何ら特別ではない「ただの1ユーザー」であり、ソースコードやリポジトリ設定にトークン情報、アカウントID、シークレット、特定ユーザーの個人ドメイン等を絶対にハードコードしてはならない。すべての接続情報はクライアントのローカルストレージまたは各ユーザーの Worker Secret から動的に供給される。

---

### 11. 過剰な自動保護・おせっかい自己修復の完全撤去と憲章 [INV-CORE-003] 制定 (2026-09-20)

#### 背景と反省（AIによるYAGNI違反・過剰設計の是正）
- ユーザーから一切要求されていない「ダッシュボードから直接アップロードされたファイルの救済」などの架空のユースケースをAIが勝手に妄想し、「未同期ファイルの自動自己修復」コードを継ぎ足していた。
- その結果：
  1. 画面を開いただけで未同期ファイル全件に対して裏で `registerKvCid`（KV書き込み `put()`）が連打され、1日1,000回の書き込み枠が一瞬で自爆枯渇する障害を引き起こしていた。
  2. 期限切れで台帳から消えたファイルが「未同期ファイル」と誤認されて勝手に再登録（ゾンビ化）していた。
  3. 存在しないURLが叩かれた際も「R2にあるかも」と毎回R2の `get()` を叩いて [INV-DELIVERY-004] の防御壁を壊していた。
  4. 正常な通常配信でも毎回存在しない `blob_` を空振り `get()` してKV読み込み枠が倍速で減り、削除時にも存在しない `blob_` を `delete()` して書き込み枠を浪費していた。

#### 制定した憲章
- **[INV-CORE-003] 過剰な自動保護の禁止と根本原因の究明原則**:
  異常な状態遷移（台帳にないのに実体がある等）を想定して自動フォールバックを組み、無料枠を浪費することを厳格に禁止。異常が起きる根本原因（削除漏れ等のバグ）を疑い根治することを義務付け、未知のリクエストはエッジで即座に 404 門前払いする。

#### 実施した改修
1. **画面表示時の R2 自動同期 `registerKvCid` 連打を完全撤去** (`cividge/app.js:7580`):
   - 未同期ファイルは画面上に表示するのみに留め、裏で勝手に KV へ書き込みを行わないよう修正。書き込み枠枯渇とゾンビ化を根絶。
2. **カード描画時の CID 自動書き込みを完全撤去** (`cividge/app.js:8341`):
   - ローカル台帳/キャッシュの更新のみに留め、カード描画時の勝手な `registerKvCid` 連打を排除。
3. **配信時の R2 オンデマンド自己修復を完全撤去** (`cividge-kv-worker/delivery.js:682`):
   - 台帳に存在しないキーは R2 を検索せず即座に 404（86400秒キャッシュ）を返却。
4. **配信時の `blob_` 空振り `get()` の完全撤去** (`cividge-kv-worker/delivery.js:799`):
   - `meta.blobKey` または `backend === "kv"` の時のみに限定。通常配信での KV 読み込み倍速消費を解消。
5. **削除時の `blob_` 無条件 `delete()` の完全撤去** (`cividge-kv-worker/cividge-kv.js:544`):
   - `backend === "kv"` または `blobKey` 実在時のみに限定。削除時の書き込み消費を 2回 ➔ 1回に半減。
6. **一覧取得時の古い `INDEX_KEY` 空振り `get()` の撤去** (`cividge-kv-worker/cividge-kv.js:164`):
   - 更新されなくなったインデックスキーの無駄な照会を削除。
7. **`wrangler.toml.example` のプレースホルダー化** (`cividge-kv-worker/wrangler.toml.example:17`):
   - `testunko.pages.dev` を `your-public-relay.pages.dev` に是正。

---

### 12. Kubo自動修復・R2カードCID自動解決の撤去と漂流ファイル巡回適正化 (2026-09-20)

#### 実施した対策一覧
1. **Kubo接続時のKV書き込み連打 (`healKuboPinnedKvRecords`) の完全撤去** (`cividge/app.js:7715, 8769`):
   - 画面を開いただけで、Kuboにある全ファイルに対して裏で片っ端から `registerKvCid`（KV書き込み `put()`）を連打していた自爆ロジックを完全撤去。
   - 画面上のピン留めバッジは手元メモリ・ローカル台帳で正常に保持・反映。手動の同期ボタン（明示的操作）のみ維持し、画面表示時の書き込み枠浪費をゼロ化。
2. **R2カード描画時の全件実体ダウンロード・CID自動計算 (`resolveR2CardCidAuto`) の完全撤去** (`cividge/app.js:8337, 8378`):
   - R2ファイルカードを描画するたびに、裏でR2からファイル実体をまるごと全ダウンロードしてCIDを再計算し `registerKvCid` を叩いていた最悪の暴走コードを完全撤去。
   - R2カードの無駄な通信・帯域消費およびKV書き込み連打を完全根絶。
3. **漂流中ファイルの自動巡回 (`auditDriftingFiles` / `checkDriftSurvival`) のエッジキャッシュ適正化** (`cividge/app.js:8404, 8470`):
   - Filebase FIFO解放後の「エッジキャッシュに生きている間は配信可能、消えたら3ストライクで台帳整理」という設計思想に基づき適正化。
   - `cache: "no-store"` を撤去してエッジキャッシュを正しくヒットさせ、Worker/KVへの直撃を防止。
   - 通信の直前に「前回巡回から1時間以内ならスキップ」するクールダウン先行判定を配置し、毎回のHEADリクエスト無駄撃ちを防止。
4. **404エッジキャッシュ非同期完了の100%保証** (`cividge-kv-worker/delivery.js:527, 538, 545, 683, 715`):
   - すべての `renderNotFoundResponse` 呼び出しに `context` を伝達。
   - `context.waitUntil(cache.put(...))` により、存在しないURLに対する404キャッシュの完了をWorker生存期間にわたって100%保証。DoS防御壁の信頼性を強化。

---

### 13. 読み取り時副作用（受動FIFO・期限切れ自動削除連打）の根絶とR2墓標バグ修正 [INV-CORE-004] (2026-09-20)

#### 共通する重大なアンチパターンの抽出と [INV-CORE-004] 制定
これまでの異常消費調査において、「画面を開いた／一覧を見た／リンクを踏んだ」という本来完全に Read-Only であるべき読み取り・描画操作の裏で、暗黙的・自動的に書き込み（`put` / `delete`）を発火させる「副作用の密輸（Side-effect Smuggling）」が最大の元凶であることが判明。  
これを恒久的に根絶するため、不変条件憲章に **`[INV-CORE-004] 読み取り・描画時の書き込み（副作用）密輸および過剰自己修復の全面禁止`** を制定した。

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **一覧表示時の勝手な期限切れファイル削除連打の完全撤去** (`cividge/app.js:7567`):
   - **なぜダメだったのか**: ユーザーはただ「ファイル一覧を開いて見たい」だけなのに、期限切れファイルが存在すると、画面起動と同時に裏で `cleanupExpiredStorageItems` が走り、ファイル件数分片っ端から `deleteKvCid`（1日1,000回の書き込み枠）を連打していた。リロードを数回行うだけで1日の枠が消し飛ぶ自爆構造だった。
   - **どう直したか**: 画面表示時の裏での自動削除を完全撤去。画面上は単に手元メモリで期限切れファイルをフィルタリング（非表示化）するだけに限定した。実際の削除は、配信エッジ側（`delivery.js`）で「期限切れURLを踏まれた時に単発で後始末する（`cleanupExpiredAlias`）」か、ユーザーの明示的操作のみに委ねる。

2. **一覧表示時の勝手な Filebase FIFO 容量解放（Passive FIFO）の完全撤去** (`cividge/app.js:7580`):
   - **なぜダメだったのか**: 「Passive FIFO check」と称して、一覧を開いた時に現在容量が上限を超えていると、裏で勝手に `ensureStorageCapacityFilebase` を発火させ、古いファイルを勝手にアンピンして `registerKvCid`（KV書き込み）を連打していた。ユーザーが何も操作していないのに勝手に実体が消され、書き込み枠が食われる典型的な「副作用の密輸」だった。
   - **どう直したか**: 一覧表示時の Passive FIFO 自動発火を完全撤去。FIFO（容量解放）は「ユーザーが新規アップロードを行おうとして容量が不足する場合（`uploadFiles`）」のみに限定した。

3. **R2 ファイル削除時の無意味な墓標 `tombstone_r2` 発行バグの修正** (`cividge-kv-worker/cividge-kv.js:556`):
   - **なぜダメだったのか**: 墓標（Tombstone）は Kubo/IPFS ノードに「この CID をアンピンしてね」と伝えるための仕組みである。しかし、R2 ファイル（`cid === "r2"`）を削除した際も `isRealIpfsCid` の判定を通さずに `if (existingCid)` で処理していたため、`tombstone_r2` という無意味な墓標が毎回 KV に書き込まれ（`put`）、書き込み枠を1回ドブに捨てていた。
   - **どう直したか**: `isRealIpfsCid(existingCid)` ガードを追加し、`Qm...` や `baf...` で始まる本物の IPFS CID 以外（R2 や不正文字列）では墓標作成を完全スキップするよう修正した。

---

### 14. 配信エッジでの過剰GC・kv.list()全件走査の撤去と設定画面自動フェッチ根絶 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **期限切れURLアクセス時の配信エッジ `kv.list()` 全件走査の完全撤去** (`cividge-kv-worker/delivery.js:470`):
   - **なぜダメだったのか**: 時限ファイルが期限切れになった後、SNSやクローラーが古いURLを叩いた際、裏側の `cleanupExpiredAlias` で「同一CIDが他で使われているか？」を確かめるために `kv.list({ limit: 1000 })`（全件走査）を実行していた。
   - `kv.list()` は1日にたった1,000回しかない最も貴重な枠であり、クローラーが古いリンクを数百回巡回しただけで無料枠が尽き、ユーザーが管理画面の一覧すら開けなくなる自爆脆弱性となっていた。
   - さらに R2 ファイル（`cid === "r2"`）でも無駄に走った上、Worker自身が `env.R2_BUCKET.delete` で実体を即座に消去しているのに、無意味な `tombstone_s3_` 墓標を KV に書き込み（`put`）、後日ブラウザが回収して消す（`delete`）という2重の書き込み枠浪費を引き起こしていた。人間にとって何一つ嬉しくない、AIの机上のクリーンナップ完全性（お片付けごっこ）による大罪である。
   - **どう直したか**: `cleanupExpiredAlias` から `kv.list()` 全件走査および墓標 `put()` を完全撤去。該当キーの削除（`kv.delete`）とエッジキャッシュ削除のみを最小限（`delete` 1回）で迅速に行い、R2 実体は Worker が自ら即時消去するスリム設計へ刷新した。

2. **設定画面入力時の 400ms debounce 自動フェッチ連打の完全撤去** (`cividge/app.js:3000, 3061`):
   - **なぜダメだったのか**: Worker URLやトークン、バケット名など13箇所の入力欄で、1文字打つたびに 400ms の debounce タイマーで `fetchAndRenderR2Files()`（S3通信＋KV一覧取得）が自動発火していた。ユーザーが文字を入力・修正・ペーストしている間に裏で通信が連打され、枠を激しく浪費していた。
   - **どう直したか**: `saveR2SettingsAuto` 内の自動フェッチタイマーを完全撤去。設定値は `localStorage` に即時保存してUI表示を更新するだけに留め、一覧の取得は初回読み込み時および明示的な「更新」ボタン押下時のみに限定した。

---

### 15. アップロード時の二重・三重kv.list()連打の根絶とローカルキャッシュ最優先化 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **ファイル1件アップロードごとの `fetchKvFiles()`（`kv.list()`全件走査）連打の完全撤去** (`cividge/app.js:6181, 1650`):
   - **なぜダメだったのか**:
     - `uploadImage()` の冒頭で「同名ファイル衝突チェック」として `fetchKvFiles()` を1回呼び出し、その直後の「重複ファイル検出（`findR2ObjectByHash`）」の中でさらにもう1回 `fetchKvFiles()` を呼び出していた。
     - ファイル1枚ごとに `kv.list()` 全件走査が2回も走り、もし画像を5枚一括アップロードしたらそれだけで **10回以上**、10枚なら **20回以上** もリスト枠（1日1,000回）が連打消費される致命的な浪費構造となっていた。
     - ブラウザには既に `storageCachedContents`（メモリ上の一覧）や `loadLedgerFromLocalStorage`（圧縮ローカル台帳）が存在しているにもかかわらず、それを完全に無視して毎回サーバーに問い合わせていた。さらに Worker 側（`cividge-kv.js`）で既に単一キー照会による `409 CID_CONFLICT` ガードが完備されており、クライアントが全件走査を打つ理由は皆無だった。
   - **どう直したか**:
     - `uploadImage()` の同名衝突チェック、および `findR2ObjectByHash()` の台帳マップ構築において、サーバー通信（`fetchKvFiles()`）を完全撤去。
     - 手元のローカル台帳キャッシュ（`storageCachedContents` / `loadLedgerFromLocalStorage`）から直接検索する形に変更し、アップロード中の KV 通信を **完全ゼロ（0回）** にした。

2. **重複検査（`findFilebaseObjectByCid` / `findR2ObjectByHash`）のローカル最優先化** (`cividge/app.js:1554, 1656`):
   - **なぜダメだったのか**:
     - 重複検出のために、ファイル1件ごとに S3 / R2 バケットへ `ListObjectsV2Command` を投げ、未解決オブジェクトに対して 4 件ずつ `HeadObjectCommand` を連打していた。
   - **どう直したか**:
     - まず手元のローカル台帳キャッシュから該当 CID / ハッシュを検索し、一致する既存実体があれば S3 / R2 への通信を行わずに即座に返却してスマートエイリアス化するフローへ最適化。手元台帳にあるファイルの重複は **通信完全ゼロ（0回・0ミリ秒）** で即時解決されるようにした。

---

### 16. Local-First 台帳アーキテクチャの確立と削除・操作後全件走査の完全根絶 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **一括削除時の墓標判定フォールバックによる `kv.list()` 全件走査連打** (`cividge/app.js:9330, 9357`, `cividge-kv-worker/cividge-kv.js:567`):
   - **なぜダメだったのか**:
     - 単一削除では `{ makeTombstone: willDeleteAll }` を渡していたが、一括削除（チェックボックス削除）では `deleteKvCid(key)` と第2引数を省略していた。
     - その結果、Worker 側の互換フォールバック（`makeTombstoneParam` 未指定時の `kv.list()` 全件走査）が1件ごとに発火し、10件削除したら 10 回、20件削除したら 20 回も全件走査が連打され、1日1,000回しかない最も貴重なリスト枠が一瞬で激しく浪費されていた。
     - Worker 側に残されていた「旧クライアント救済のための全件走査フォールバック」自体が、無料枠保護の思想に反する過剰な自動保護（おせっかいコード・YAGNI違反）だった。
   - **どう直したか**:
     - Worker 側 (`cividge-kv.js`) の `onRequestDelete` から全件走査フォールバック（`kv.list()` ループ）を完全撤去。`make_tombstone === "1"` の時のみ墓標を発行する決定論的設計へ刷新した。
     - クライアント側の一括削除 (`deleteSelectedR2FilesButton`) では、手元台帳（`storageCachedContents`）を走査して「選択されていない残りのファイルの中に同一 CID を持つものがあるか」を瞬時に判定し、`makeTombstone: !isCidShared`（R2の場合は常に `false`）を明示的に指定して送信するように改修した。Worker 側の走査は **完全ゼロ（0回）** になった。

2. **操作（削除・アップロード・リネーム・エイリアス追加）後のサーバー再フェッチ連打と画面表示時通信** (`cividge/app.js:6687, 8648, 8804, 9227, 9289, 7307`):
   - **なぜダメだったのか**:
     - ファイルを削除した直後、アップロードした直後、リネームした直後、エイリアスを追加した直後に、毎回末尾で `await fetchAndRenderR2Files()` が呼ばれ、サーバーの全件一覧（S3 `ListObjectsV2` および KV `fetchKvFiles()`）を再取得していた。
     - ブラウザの `localStorage` は安価かつ大容量（タプル圧縮により数万件格納可能）で手元に存在しているにもかかわらず、「最新をサーバーから取り直す」という旧来の Web アプリ設計のままだったため、操作を行うたびに貴重なリスト枠をドブに捨てていた。
     - さらに、画面初回読み込み時やタブ切り替え時にも、手元にキャッシュがあるのに毎回サーバーへ問い合わせていた。
   - **どう直したか**:
     - 憲章 **`[INV-CORE-005] Local-First 原則と localStorage 最大活用原則`** を両リポジトリの `INVARIANTS.md` に制定。
     - **オプティミスティック手元更新の完全導入**:
       - 削除時（単一削除・一括削除）: サーバー再フェッチを撤去し、手元台帳（`storageCachedContents` & `localStorage`）から差分削除して `renderCurrentStoragePage()` でミリ秒即時描画。
       - アップロード完了時 (`handleBatchUpload`): アップロード成功アイテムを手元台帳に追加し、手元から即時描画。
       - リネーム・エイリアス追加・実体アンピン時: 手元台帳の該当アイテムを更新し、即座にUI反映。エイリアス作成ダイアログ内の `fetchKvFiles()` も手元台帳参照に置換。
     - **画面表示時の通信ゼロ化 (`fetchAndRenderR2Files`)**:
       - 手元キャッシュが存在する場合、明示的な「🔄 更新」ボタン押下（`forceRefresh: true`）以外はサーバー通信（S3/KV）を完全にスキップして即時描画。
       - これにより、日々の通常運用（閲覧・アップロード・削除・リネーム）において、Cloudflare KV のリスト枠消費を **完全ゼロ（0回）** に抑え込むことに成功した。

---

### 17. 隠れ kv.list() 走査・描画時 Range ダウンロード連打・空振り墓標走査の完全根絶 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **リネーム時の `kv.list()` 全件走査 2重連打** (`cividge/app.js:8538, 8603`):
   - **なぜダメだったのか**:
     - ファイルをリネーム（鉛筆アイコン）する際、手元に `storageCachedContents`（ローカル全台帳）があるにもかかわらず、リネーム前のメタデータ取得と同名衝突チェックで `fetchKvFiles()` を1回、さらに登録直前のメタデータフォールバックで再度 `fetchKvFiles()` を呼び出していた。
     - ファイルを1件リネームするだけで、1日1,000回しかない最も貴重なリスト枠が 2 回もドブに捨てられていた。
   - **どう直したか**:
     - 手元のローカル台帳キャッシュ（`storageCachedContents` / `loadLedgerFromLocalStorage`）からメタデータ取得および衝突チェックを行う形に完全移行。リネーム処理に伴うサーバーへの `kv.list()` 走査を **完全ゼロ（0回）** にした。

2. **ドメイン設定変更（追加・削除・ミラー解除）時の `kv.list()` 全件走査** (`cividge/app.js:3398, 3469, 3524`):
   - **なぜダメだったのか**:
     - 配信ドメインの新規追加、削除、ミラー解除を行うたびに、「該当ドメインに紐づくファイルが台帳に残っていないか？」を調べるためだけに、都度 `await fetchKvFiles()`（`kv.list()` 全件走査）を実行していた。
     - ドメイン設定を少し変更するだけでリスト枠が1回ずつ消費され、さらに変更後の `fetchAndRenderR2Files()` でもサーバーへ問い合わせていた。
   - **どう直したか**:
     - 手元のローカル台帳キャッシュから該当ドメインのファイルをフィルタ照合するように切り替え、設定変更時の `fetchKvFiles()` および変更後の全件再フェッチを完全撤去（`renderCurrentStoragePage()` に置換）。通信を **完全ゼロ（0回）** にした。

3. **R2 FIFO 容量解放時の `kv.list()` 全件走査** (`cividge/app.js:6138`):
   - **なぜダメだったのか**:
     - アップロード時に R2 容量上限（10GB）に達して容量解放（FIFO）が発火した際、Kubo に保存後のメタデータを更新する対象キーを照合するためだけに `await fetchKvFiles()`（`kv.list()` 全件走査）を実行していた。
   - **どう直したか**:
     - 手元キャッシュ（`storageCachedContents` / `loadLedgerFromLocalStorage("r2")`）から該当キーのメタデータを照合するように修正し、全件走査を完全撤去した。

4. **一覧カード描画時の先頭 128KB Range ダウンロード通信の全カード一斉連打** (`cividge/app.js:8182`, `checkRemoteFileWf`):
   - **なぜダメだったのか**:
     - ストレージ一覧でカードを描画するたびに（1ページあたり最大24件）、ローカルストレージ（`comfyWfMap`）に記録がないファイルに対して、`fetch(publicUrl, { headers: { Range: "bytes=0-131072" } })` を非同期で一斉連打していた。
     - 単に「🧬 WF」バッジを表示するためだけに、一覧を開くたびに最大24件のリモート画像・動画の先頭 128KB をダウンロードしに配信 Worker / エッジ / ストレージへ通信が飛んでおり、Worker リクエスト数、データ転送帯域、Class B 操作を激しく浪費していた（`[INV-CORE-004]` 違反）。
   - **どう直したか**:
     - アップロード時に判明したワークフロー情報はローカル（`comfyWfMap`）に記録されているため、未記録ファイルに対して一覧描画時に勝手にリモート Range ダウンロードするのを完全撤去。手元マップの同期チェックのみに切り替え、バックグラウンドのダウンロード通信を **完全ゼロ（0回）** に根絶した。

5. **誰も発行していない旧 `tombstone_s3_` の定期空振り走査の撤去と Kubo 未設定時スキップ** (`cividge/app.js:1282, 1421`, `cividge-kv-worker/cividge-kv.js:108`):
   - **なぜダメだったのか**:
     - Worker 側で既に `tombstone_s3_` の発行を撤去したためシステム上に 1 つも存在しないにもかかわらず、クライアントの `maybeDrainTombstonesDaily` が 24時間ごとに `tombstones_s3=1`（`kv.list({ prefix: "tombstone_s3_" })`）を叩いていた。
     - さらに、Kubo（自宅ノード）を設定していない一般ユーザーに対しても `drainKuboTombstones` で `tombstone_` を探索していた。
   - **どう直したか**:
     - クライアントの `drainS3Tombstones` および Worker 側の `tombstone_s3` 取得ハンドラを完全撤去。
     - `drainKuboTombstones` も、実際に Kubo RPC URL が設定されているユーザー（`isKuboConfigured` かつ `hasAdminAccess`）のみに限定し、一般ユーザー環境での空振り探索を完全にゼロ化した。

---

### 18. 異常消費ポイント5点の完全根絶と Pages Functions / ミドルウェアの安全同期 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **単体アップロードボタン4箇所の `fetchAndRenderR2Files()` 残存** (`cividge/app.js:5370, 5398, 5426, 5486`):
   - **なぜダメだったのか**:
     - 一括アップロード完了時は手元台帳の更新に切り替えていたが、個別カードの単体アップロードボタン（`upload-btn`, `upload-r2-btn`, `upload-filebase-btn`）および Civitai 転送準備ボタン（`civitai-post-btn`）の完了後に `await fetchAndRenderR2Files()`（サーバーへの全件フェッチ）が叩かれていた。
     - `uploadImage()` の内部ですでに `addOrUpdateLocalLedgerItem()` が実行されているにもかかわらず、呼び出し側で余計に全件再取得を走らせて S3 ListObjectsV2 / KV list を浪費していた。
   - **どう直したか**:
     - `await fetchAndRenderR2Files()` を `renderCurrentStoragePage()` に置換。手元台帳から即座にミリ秒再描画され、アップロード完了時のサーバー再問い合わせ通信を **完全ゼロ（0回）** にした。

2. **自宅 Kubo ノード Pin / アンピン操作時の不要な KV 単発照会 ＆ サーバー全件フェッチ** (`cividge/app.js:8797, 8823, 8919, 8946, 9004, 9022, 9096`):
   - **なぜダメだったのか**:
     - Kubo Pin 解除時、R2 から Kubo への実体注入時、P2P 同期完了検知時、Filebase アンピン時に、手元台帳（`storageCachedContents`）にすでに情報が存在するにもかかわらず、`const kvData = await fetchKvRecord(key);` でサーバー KV へ単発照会を叩いていた。
     - さらに操作完了後に `fetchAndRenderR2Files()` を呼び出して全件走査を連打していた。
   - **どう直したか**:
     - 手元のローカルキャッシュからメタデータを取得して `fetchKvRecord` のネットワークリクエストを完全撤去。
     - 操作完了後は手元台帳の `kuboStatus` を更新して `renderCurrentStoragePage()` で即時再描画。サーバー通信を **完全ゼロ（0回）** にした。

3. **Filebase FIFO 容量解放時のループ内 KV 単発照会連打** (`cividge/app.js:5947`):
   - **なぜダメだったのか**:
     - 容量解放時に候補となった全ファイル（`candidates`）に対し、手元キャッシュを参照せず `await fetchKvRecord(targetKey)` をループで1件ずつサーバー KV に問い合わせていた。
   - **どう直したか**:
     - 手元台帳（`storageCachedContents`）からメタデータを取得するように切り替え、通信を **完全ゼロ（0回）** にした。

4. **Pages Functions 側 `cividge-kv.js` の改修漏れ（重大）** (`cividge/functions/api/cividge-kv.js:524, 531`):
   - **なぜダメだったのか**:
     - `cividge-kv-worker` 側では安全化されていたが、Pages Functions 側（`/api/cividge-kv`）に「削除時に `kv.list({ limit: 1000 })` を走査するコード」と「存在しない `blob_` キーを無条件 `delete()` するコード」が残存していた。
   - **どう直したか**:
     - `cividge-kv-worker/cividge-kv.js` と完全に同じ最新の Local-First 仕様（手元から `make_tombstone=1` 指定時のみ墓標発行、`blob_` 存在時のみ削除、旧S3墓標ハンドラ撤去）へ完全同期した。

5. **Pages Functions ミドルウェア (`_middleware.js`) 内の期限切れ回収での `kv.list()` 全件走査ループ** (`cividge/functions/_middleware.js:426`):
   - **なぜダメだったのか**:
     - 配信 Worker（`delivery.js`）では既に撤去されていた「期限切れリンク踏み込み時の `kv.list()` 全件走査ループ」および「誰も回収しない `tombstone_s3_` 墓標の `put()` 発行」が、Pages Functions 側のミドルウェアに残存していた。bot やクローラーが期限切れリンクを踏むたびに最貴重な `list()` 枠を消費する脆弱性だった。
   - **どう直したか**:
     - `delivery.js` と同様に、`cleanupExpiredAlias` から `kv.list()` 全件走査ループと墓標発行を完全撤去し、単発の KV delete のみに安全化した。

---

### 19. 投稿トークン検証のキャッシュ化・入力連打防止と配信レイヤにおける Cache API（エッジキャッシュ）完全適用 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **投稿専用 API トークン検証 (`verifyUploadToken`) の起動時通信 ＆ 文字入力連打** (`cividge/app.js:10222, 10333, 10346, 10354`):
   - **なぜダメだったのか**:
     - 画面を開くたびに `setTimeout(..., 250)` で Worker（`/api/upload`）へ自動 GET リクエストが飛び、さらに設定画面で文字をタイプするたび 400ms debounce で通信が連打されていた（`[INV-CORE-004]` 違反）。
     - 検証結果が `localStorage` に保持されないため、リロードするたびに無駄な Worker リクエストを消費していた。
   - **どう直したか**:
     - 検証結果（`{ token, endpoint, verified }`）を `localStorage` の `uploadTokenVerifiedState` に保存。
     - 画面起動時は手元の検証結果を参照して即時バッジ反映し、サーバー通信を **完全スキップ（0回）**。
     - `input` イベント連打を撤去し、入力確定（`change`）または手動操作時のみの単発検証に限定した。

2. **配信レイヤにおける正常メディア（200 OK）の Cache API 保存漏れ** (`cividge-kv-worker/delivery.js`, `cividge/functions/_middleware.js`):
   - **なぜダメだったのか**:
     - 配信エッジの冒頭に `caches.default.match` ガードがあったにもかかわらず、正常メディア（200 OK）返却時に `caches.default.put` を呼んでいなかった（404 レスポンスのみ保存されていた）。
     - そのため、一度アクセスされた正常な画像であってもエッジキャッシュに保存されず、SNS でシェアされた際などに同一 URL を踏まれるたびに毎回 Worker が起動して KV の `getWithMetadata`（読み込み枠: 1日100,000回）を連打消費していた。
     - さらに Pages ミドルウェアには最前線ガード自体が存在しなかった。
   - **どう直したか**:
     - `delivery.js` および `_middleware.js` において、正常レスポンス返却時（200 OK、GET、パスワード保護なし）に `context.waitUntil(caches.default.put(request, res.clone()))` を確実に実行。
     - これにより、2回目以降のアクセスは最前線の Cache API で即座に返却され、**KV 読み取り回数 0 回、R2/IPFS 問い合わせ回数 0 回** の完全防衛を実現した。
     - `_middleware.js` にも `caches.default.match` 最前線ガードと 404 レスポンス保存を導入した。

### 20. 漂流ファイル安否確認の永久維持明記、平時墓標走査ゼロ化および Pages upload.js 同期 (2026-09-20)

#### なぜダメだったのか・どうダメだから消したのか（改修詳細）

1. **【意図された例外・必須仕様】漂流ファイル安否確認 (`auditDriftingFiles`) の永久維持と改修禁止** (`cividge/app.js:7752〜7757, 8348〜8370`, `cividge-kv-worker/INVARIANTS.md`):
   - **仕様の位置づけ**:
     - 一覧描画時の `auditDriftingFiles(contents)` による HEAD 安否確認、および 3回連続失敗時の自動 `deleteKvCid(rawKey)`（台帳自動整理）は、システムの意図された正規の仕様・必須の自動自己修復機能である。
     - 一時的に AI が「異常消費ポイント」として撤去しようとしたが、**ユーザーの絶対的指示によりコードを完全差し戻し・永久維持を決定**。
     - 不変条件 `[INV-CORE-004]` の第2項に「【意図された例外・必須仕様：漂流ファイル安否確認 (`auditDriftingFiles`)】この機能は絶対に修正・撤去・オプトイン化せず、そのまま永久に残すこと (MUST PRESERVE / DO NOT MODIFY)。AI エージェントおよび開発者は、これを異常消費ポイントとして提案したり、改修・撤去・変更を試みてはならない」と厳格に刻み込み、将来の誤変更を永久防止した。

2. **自宅 Kubo 未回収墓標の定期走査 (`maybeDrainTombstonesDaily`) による平時の `kv.list()` 浪費** (`cividge/app.js:10707〜10713, 1242〜1280, 1420〜1440`, `cividge-kv-worker/INVARIANTS.md`):
   - **なぜダメだったのか**:
     - 起動5秒後（および手動更新ボタン押下時）に `maybeDrainTombstonesDaily()` が走るが、自宅 Kubo RPC が設定されている場合、24時間ごとに `tombstones=1` を叩いていた。
     - Worker 側は `(env.CIVIDGE_KV || env.IPFS_KV).list({ prefix: "tombstone_", limit: 1000 })`（1日1,000回しかない KV list 走査枠）を実行していた。
     - 墓標が1件も存在しない平時（ファイルを削除していない通常運用時）であっても、毎日アプリを開くだけで貴重な `kv.list()` が1回消費されていた（`[INV-CORE-005] Local-First 原則` 違反）。
   - **どう直したか**:
     - `localStorage` に「未回収墓標保留フラグ（`cividge_pending_tombstones`）」を導入。
     - `deleteKvCid` で `makeTombstone: true` を実行した時のみ手元フラグを立て、墓標のない平時は `maybeDrainTombstonesDaily` および `drainKuboTombstones` の通信を **完全スキップ（0回通信）** にした。
     - 墓標の回収が完了した時点で手元フラグを削除。これにより平時の `kv.list()` 消費が **100% ゼロ回** になった。
     - 不変条件 `[INV-CORE-005]` の第4項として「未回収墓標の手元フラグ管理による平時 kv.list() 走査ゼロ化」を明記。

3. **Pages Functions 側 `upload.js` の `onRequestGet` 追加同期** (`cividge/functions/api/upload.js`):
   - **なぜダメだったのか**:
     - Worker 側には存在する投稿トークン検証用ハンドラ（`onRequestGet`）が Pages Functions 側で欠落しており、Pages 経由でテストされた場合に 405 Method Not Allowed が返る潜在リスクがあった。
   - **どう直したか**:
     - Worker 版と同様に `onRequestGet` を追加し、CORS（OPTIONS）でも `GET` を許可して両者を完全同期した。

---

### 21. [機能検討] IndexedDB 導入による巨大メタデータ（civitaiWfMap等）の退避とサムネイルBlobキャッシュのハイブリッド構成

#### 1. 背景と容量分析
- **localStorage の現状**:
  - ブラウザの `localStorage` 容量上限は約 5MB。
  - 通常のファイル台帳（CID、ファイル名、サイズ、タイムスタンプ等）は 1件あたり約 150〜300 バイトであり、約 15,000 件以上のメディアを収容可能。一般的な個人ギャラリー運用では 5MB でお釣りが来るほど十分である。
- **唯一の容量圧迫要因**:
  - Civitai の生成ワークフロー（ComfyUI ノードグラフ・詳細プロンプト生JSON: `civitaiWfMap`）は、1件で 10KB 〜 100KB 以上に達することがある。
  - これを数百〜数千件キャッシュすると、`localStorage` の 5MB 上限（`QuotaExceededError`）を引き起こす唯一のリスク要因となる。

#### 2. 検討するハイブリッド構成案

| データ種別 | 格納先 | 理由・動作設計 |
| :--- | :--- | :--- |
| **基本設定・認証情報**<br>(APIトークン、URL、言語、ドメイン等) | **`localStorage`** | アプリ起動時に同期的（0ミリ秒）に取得必須。非同期DB待ちによる画面チラつき（FOUC）を防止。 |
| **軽量メイン台帳**<br>(`cividge_ledger_*`, `ipfsCidMap` 等) | **`localStorage`** | 数百KB程度と軽量。同期復元により起動直後のグリッド即時描画を実現。 |
| **巨大生成ワークフロー**<br>(`civitaiWfMap` / ComfyUI ノードグラフ) | **`IndexedDB`** (推奨) | 一覧描画時には不要。詳細モーダルを開いた時のみ非同期（`await`）で取得。メイン台帳の `JSON.parse` 負荷を大幅削減し、容量制限を実質無制限（GB単位）へ解放。 |
| **サムネイル Blob キャッシュ**<br>(生成画像・プレビューサムネイル) | **`IndexedDB`** (発展系) | ネット切断時・完全オフラインでも過去の全メディア一覧が即時表示される PWA 的な高速体験を実現。 |

#### 3. 実施タイミング・判断基準
- **現状**: 通常の利用規模では 5MB で完全に事足りており、今すぐ改修が必要なほど逼迫はしていない。
- **着手トリガー**: ヘビーな ComfyUI 生成ワークフロー付き画像のインポート頻度が高まり、ローカル容量警告（またはクォータ逼迫）が予見された段階で、上記 `civitaiWfMap` の IndexedDB 分離を実装する。

---

### 22. 重複排除における「実体未保持レコード（isFromS3 === false）」の誤検知・アップロードスキップ防止 (2026-09-20)

#### なぜダメだったのか・どうダメだから直したのか（改修詳細）

1. **実体が解放・削除されたレコードの重複参照による 404 誘発** (`cividge/app.js:1599, 1706`):
   - **なぜダメだったのか**:
     - Cividge はマルチストレージ（R2, Filebase, 自宅Kubo）であり、R2 自動容量解放（FIFO）やアンピンにより「台帳にレコードは存在するが R2 / Filebase から実体が解放・削除済み（`isFromS3: false`）」という状態が正常・必然的に発生する。
     - しかし、アップロード時の重複検査（`findR2ObjectByHash` / `findFilebaseObjectByCid`）が、台帳の CID/ハッシュの一致だけを見て「台帳にあるなら実体もあるはずだ」と誤認。
     - 実体が存在しない空っぽのレコードを既存実体として参照し、R2/Filebase への PutObject（実体バイナリアップロード）を勝手にスキップして別名キーだけを登録していた。
     - その結果、実体がどこにも存在しないため、配信アクセス時やサムネイル描画時に **404（猫耳シルエット）** になる重大な不整合を引き起こしていた。
   - **どう直したか**:
     - `findR2ObjectByHash` および `findFilebaseObjectByCid` の手元台帳キャッシュ走査において、`item.isFromS3 === false`（物理ストレージに実体がないレコード）を重複排除の参照候補から **100% 除外（スキップ）**。
     - 実体が既に解放されているファイルと同一内容の画像を再度アップロードした際、サボらずに確実に物理ストレージ（R2 / Filebase）へ新規実体をアップロードするように恒久修正した。

---

### 23. アクティブ配信ドメイン最優先による 404 サムネ防止および漂流ファイル安否確認の URL 解決修復 (2026-09-20)

#### なぜダメだったのか・どうダメだから直したのか（改修詳細）

1. **`localStorage.fileDomainMap` の古いドメイン固着によるサムネイル 404 化** (`cividge/app.js:1817〜1833`):
   - **なぜダメだったのか**:
     - 単体ファイル（明示的ドメインプレフィックスのないカード）の配信ドメインを解決する `getFileStoredDomain` が、過去に設定した古いドメインのローカル記憶（`localStorage.fileDomainMap`）を、現在ヘッダーで選択している正常なアクティブドメイン（`getSelectedR2Domain()`）より優先して参照していた。
     - そのため、ファイル実体が生きていて `kv.k7m.f5.si` などでは正常に閲覧できるにもかかわらず、過去の死んだリレー（`content-relay.pages.dev` や `punipuni-media.pages.dev`）が強制的にサムネイル URL に割り当てられ、エッジで 404（猫耳 SVG）が返ってサムネイルが壊れる弊害が発生していた。
     - さらに、ブラウザの `<img>` は HTTP 404 であっても有効な SVG 画像が返されると `onerror` を発火させない仕様のため、S3 フォールバックも動かず猫耳 404 が居座っていた。
   - **どう直したか**:
     - `getFileStoredDomain` において、`rawKey`（`domain:file`）や `metadata.allowedHost` に明示的なドメイン指定がない限り、**現在ユーザーが選択しているアクティブ配信ドメイン（`getSelectedR2Domain()`）を最優先** に割り当てるように修正。
     - 過去の壊れたドメイン記憶によるサムネイル巻き添え事故を 100% 根絶した。

2. **`auditDriftingFiles` の未定義プロパティ参照による安否確認スリーアウト停止** (`cividge/app.js:8334〜8342`):
   - **なぜダメだったのか**:
     - 漂流ファイル安否確認（`auditDriftingFiles`）のループ冒頭で `const publicUrl = item.publicUrl || item.proxyUrl;` を参照していたが、台帳オブジェクトには元々 `publicUrl` プロパティが存在しなかった。
     - そのため、`!publicUrl` が常に true になり、すべての漂流ファイルが安否確認（HEAD チェック）の直前で 100% スキップ（空振り）されていた。
     - 結果として、完全にロストしてエッジからも消滅した漂流ファイルであっても、HEAD チェックが 1 回も走らず見失いカウントが加算されないため、スリーアウト自動削除が永久に発火しないバグとなっていた。
   - **どう直したか**:
     - ループ内で `getPublicDeliveryUrl(...)` を呼び出し、現在の正しい配信 URL を動的に完全解決するように修正。
     - これにより、死んだ漂流ファイルに対して正常に HEAD チェック（4秒タイムアウト、1時間クールダウン）が走り、3回連続失敗で安全かつ自動的に台帳からパージ（`deleteKvCid`）される正規の自律自己修復が完全に稼働するようになった。




---

### 24. [将来構想・重要議論] 自宅Kuboノードを特別視せず、純粋なIPFS分散ネットワーク（P2P/DHT）経由でCloudflareエッジへ自律集約・配信するアーキテクチャの課題とロードマップ (2026-09-20)

#### 1. ユーザーのコア思想と基本方針
- **「ノードの特別扱い・直通回線（Cloudflare Tunnel等）の完全排除」**:
  - 自宅 PC で稼働する Kubo ノードは、プライベートな専用オリジンではなく、世界中の IPFS ネットワークに参加する無数の一般ノード（ピア）の 1 つに過ぎない。
  - 特定のノードと Cloudflare をトンネルで直結して贔屓する構成は、IPFS の本質である「コンテンツ指向の自律分散（Content Addressing）」に反し、旧来のプライベート Web サーバーへの退行である。
- **目指すべき本来の姿**:
  - CID（コンテンツハッシュ）さえあれば、世界中のどこかのピア（今回はたまたま自宅ノード）にブロックが存在しているだけで、IPFS ネットワーク（DHT / Bitswap）を通じて自然にデータが発掘される。
  - 公共ゲートウェイを経由して Cloudflare Worker にブロックが届き、Cloudflare CDN のエッジキャッシュ（通常1年 / アンピン時7日）に載って世界中へ配信されるという、**IPFS 本来の完全な自律分散 P2P 配信メカニズム** を成立させること。

#### 2. 現状のボトルネック分析（なぜ現在「自然な発見と配信」が阻まれているのか）

実際に Cloudflare Worker の内部通信ログ（`wrangler tail`）を追跡・検証した結果、以下の **3 つの壁** が特定された：

1. **自宅ノードの「外部到達性（Inbound Reachability）」の欠如（NAT / ポート問題）**:
   - 自宅 Kubo は現在、外部ピアと約 30 台接続できているが、これは自宅 PC から外向きに出ていった接続（Outbound）である。
   - 外部の公共ゲートウェイ（海外の IPFS ノード群）が「この CID の保持者は Peer `12D3KooW...` だ」と突き止めても、自宅ルーター（NAT / ファイアウォール）の 4001 番ポートが閉じていると、外から自宅ノードに電話（Inbound Dial）をかけてブロック（Bitswap）を取り寄せることが物理的にできない。
   - **求められる要件**:
     - 特別なトンネルではなく、世界と対等に通信できる一般ノードとして、ルーターの **UPnP（自動ポート開放）** または **ポート 4001（TCP/UDP）の開放**。
     - または Kubo 標準の **Hole Punching（DCUtR / NAT越え機能）** および AutoRelay の正常動作確認。

2. **DHT（世界地図）への「所持告知（Provider Record）」の反映遅延**:
   - Kubo にファイルを Pin 留め（`ipfs pin add`）した直後は、自宅ノードが「自分はこのデータを持っています」と DHT（分散ハッシュテーブル）にアナウンスするまでにタイムラグがある。
   - `cid.contact`（IPFS インデクサー）を確認した際、Filebase のノードは記録されていたが、自宅ノードの Peer ID はまだ世界地図に反映されていなかった。
   - **求められる要件**:
     - 外部到達性（壁1）をクリアした上で、自宅ノードからの DHT 告知（`ipfs dht provide` または定期 Reprovider）が世界へ行き渡ること。

3. **Cloudflare Worker が利用している「公共ゲートウェイ窓口」の陳腐化**:
   - 自宅ノードが正常にブロックを差し出せる状態であっても、Cloudflare Worker は Web Worker であるため、IPFS ネットワークへ入るための「窓口（パブリックゲートウェイ）」を叩く必要がある。
   - しかし現在 `delivery.js` が参照している主要ゲートウェイ（`dweb.link`, `ipfs.io`, `gateway.pinata.cloud`）は、運営組織のポリシー変更により **無料の外部非認証アクセスを 429（Too Many Requests / 接続拒絶）** で遮断している。
   - **求められる要件**:
     - 特定ノードの特別扱いではなく、現在も公平に DHT 探索を行ってくれるオープンな生きたパブリック IPFS ゲートウェイ（Cloudflare 自身の `cloudflare-ipfs.com` や、Trustless Gateway 規格ノード群など）へ窓口を見直すこと。

#### 3. 将来的な実現に向けたアプローチまとめ
「自宅ノードを特別視しない」という美しい自律分散ポリシーを現実化するために必要な要件は、以下の 2 点に集約される：
- **① 自宅 Kubo 側**: 4001 番ポートの疎通または Hole Punching により、世界中のピアから「ブロックをちょうだい」と接続されたときに正常に渡せるパブリックノード化。
- **② Cloudflare Worker 側**: IPFS ネットワークへの入口となる公共ゲートウェイのリストを、429 拒絶のないオープンな現役ゲートウェイ群へ更新。

#### 4. 解決と開通の実証結果 (2026-09-20 解決完了)
1. **自宅 Kubo の設定改善と外部着信の確立**:
   - `ipfs config Routing.Type auto`、`Swarm.RelayClient.Enabled true`、`Experimental.OptimisticProvide true` を適用。
   - ルーターのポート開放不要で UPnP / AutoNAT により外部着信ポート `36167` が自動公開され、TCP 接続テストで `TcpTestSucceeded: True`（100% 疎通）を確認。
   - `Protocols` に `/ipfs/kad/1.0.0`（DHTフルノード）および `/libp2p/dcutr`（Hole Punching）が追加され、一人前のパブリックピア化に成功。
2. **生きた地域分散オープンゲートウェイ群への更新**:
   - Worker 側の問い合わせ先を、アジア太平洋（APAC: `apac.orbitor.dev`）、グローバル（`dget.top`）、北米（`ipfs.orbitor.dev`）、欧州（`eu.orbitor.dev`）、中南米（`latam.orbitor.dev`）の多重冗長フォールバックへ更新。
3. **自律分散配信の完全開通実証**:
   - 自宅 PC のみに存在するファイル（`yep59jt5.jpg`）に対し、Cloudflare 経由（`https://relay.k7m.f5.si/r/yep59jt5.jpg`）でアクセスした結果、**APAC ゲートウェイ経由で自宅ノードから自動吸い上げが行われ、HTTP 200 OK（207.8 KB、Cloudflare エッジキャッシュ 7日間）で完全配信されることを実証**。
   - 不変条件 `[INV-DELIVERY-003]` および `[INV-KUBO-001]` として両リポジトリに成文化し、将来の誤変更・劣化を恒久防止した。

#### 5. フォルダ構造による公平な静的リレー身元特定とクエリ除去耐性の確立 (2026-09-20)
1. **背景とボトルネック**:
   - リダイレクト時、ブラウザのセキュリティ（Referrer-Policy: strict-origin-when-cross-origin）や Cloudflare WAF / Transform Rules の「クエリ除去ルール（`[INV-INFRA-001]` キャッシュバスター防御）」により、`Referer` ヘッダーおよび `?__cividge_relay=...` クエリパラメータが Worker 到達前に削ぎ落とされる事象が発生。
   - 身元不明となった Worker は、フォールバックとして `STATIC_RELAY_PUBLIC_HOSTS` の先頭（`content-relay.pages.dev`）を暗黙のデフォルトとして採用してしまい、`punipuni-media.pages.dev` 等の別リレー配下のファイル（`yep59jt5.jpg`）が 404 に弾かれる不公平が生じていた。
2. **フォルダ構造（パス形式）の導入**:
   - 既存の Cloudflare WAF allowlist / レート制限ルール（`starts_with(http.request.uri.path, "/r/")`）を 1 文字も変更せずにそのまま生かすため、`/r/` の配下にリレー識別子を配置するフォルダ構造を採用：
     `https://relay.k7m.f5.si/r/<relay-identifier>/<filename>`
     例: `https://relay.k7m.f5.si/r/punipuni-media/yep59jt5.jpg`
   - 各静的リレー（`punipuni-media`, `testunko`, `content-relay`）の `_redirects` をこの形式に更新・再デプロイ。
3. **成果と不変条件の更新**:
   - クエリを一切使用しないため、WAF のクエリ除去ルールやトラッキング防止機能に 100% 影響されない。
   - 各リレーが公平に扱われ、特定ドメインの暗黙の優遇・特別扱いが完全根絶。
   - `cividge-kv.js` のキャッシュパージ（`purgeHybridCache`）にもフォルダ構造のパスを自動生成・追加し、整合性を完備。
   - 不変条件 `[INV-DELIVERY-005]` を改訂し、フォルダ構造による単一ホスト一発特定を正式規定。両リポジトリへ反映完了。

---

### 25. 【将来検討・改修案】Kubo設定アコーディオンへの「IPFS公開ノード/ゲートウェイ優先順位管理機能」の追加検討 (2026-09-20)

#### 1. 提案の概要と目的
- **ユーザー要望**:
  - Cividge 設定モーダル内の「🏠 自宅 Kubo」アコーディオン等に、IPFS 公開ノード（ゲートウェイ群）を初期格納したプルダウンを配置し、ユーザーが優先順位の変更（並べ替え）や新規ノードの追加を自由に行えるようにする構想。
- **技術的実現性**:
  - **フロントエンドとして完全に実現可能（無理ではない）**。
  - Local-First 原則（`[INV-CORE-005]`）に基づき、ユーザーのブラウザ（`localStorage`）に優先順位配列を永続化すれば、外部通信や KV 消費を一切発生させずに安全に運用できる。

#### 2. 想定される 3 つの活用シナリオ
1. **シナリオ A: 【フロントエンド完結・即戦力】プレビュー・ノード確認用ゲートウェイの制御**
   - **内容**: ファイルカードの「🌐 ノード確認 ↗」リンクや、将来的な実体プレビュー時に使用するオープンゲートウェイの優先順位をユーザーが設定可能にする。
   - **初期プリセット（初期格納リスト）**:
     1. `https://apac.orbitor.dev/ipfs/`（アジア太平洋最速・自宅ノード吸い上げ用）
     2. `https://dget.top/ipfs/`（グローバル高可用性オープンノード）
     3. `https://ipfs.orbitor.dev/ipfs/`（北米メインクラスタ）
     4. `https://eu.orbitor.dev/ipfs/`（欧州分散ノード）
     5. （任意で自宅ローカル `http://127.0.0.1:8080/ipfs/` も追加可能）
   - **メリット**: フロントエンド単体で完結し、即座に安全導入可能。

2. **シナリオ B: 【P2P安定化】自宅 Kubo の Swarm 接続先公開ピア（Peering）管理**
   - **内容**: 自宅 Kubo が世界から孤立しないよう、画面上のボタンから主要な公開ノード（Cloudflare, Pinata, Protocol Labs 等の Multiaddr）に対して Kubo RPC（`/api/v0/swarm/connect`）を発行・接続維持する。
   - **メリット**: 自宅ノードの外部到達性と DHT 告知の成功率をフロントエンドから補助可能。

3. **シナリオ C: 【配信Worker連動】Cloudflare Worker（delivery.js）の探索優先順位の動的変更**
   - **内容**: フロントエンドで設定した優先順位を管理者トークン経由で KV（`config:ipfs_gateways` 等）へ保存し、Worker が自宅 Kubo から吸い上げる際のゲートウェイ問い合わせ順序を動的に制御する。
   - **メリット**: Worker のコード再デプロイ不要で、死滅ゲートウェイの除外や新規ゲートウェイの投入をブラウザから一元管理可能。

#### 3. 推奨 UI デザイン構成案
- **配置場所**: `cividge/index.html` の `#kuboSettingsGroup`（自宅 Kubo アコーディオン）内。
- **UI コンポーネント**:
  - **プリセット選択プルダウン**: アジア、グローバル、北米、欧州などの実績あるオープンゲートウェイをワンクリックで追加。
  - **カスタム URL 入力欄**: 独自に運用する専用ゲートウェイや新興ゲートウェイを手動追加。
  - **優先度順リスト（並べ替え対応）**: `[▲]` / `[▼]` ボタンまたはドラッグ操作で優先順位を上下入れ替え、`[削除]` ボタンで除外。
  - **自動保存**: 入力・並べ替えの都度 `localStorage.setItem("cividge_ipfs_gateways", ...)` により即時反映。

#### 4. 次期実装時の注意点
- ゲートウェイの中には無料アクセスを 429（Too Many Requests）で遮断するもの（`ipfs.io`, `dweb.link` 等）があるため、プリセットには `[INV-DELIVERY-003]` で認定された「現役・オープン」なノードのみを初期値とすること。
- 将来シナリオ C（Worker連動）へ進める際は、KV のキャッシュ（Cache-Control / メモリキャッシュ）を設けて毎リクエストごとの KV 読み込み浪費を防止すること。


---

### 26. ドメイン独立性の確立とエイリアス非干渉・重複カード解消 (2026-09-20)

#### 1. 発生していた障害と根本原因
1. **画面プルダウン切り替えによる他カードのドメイン巻き添え化**:
   - 単体キー（eyeaofj.webp や x7hjsnoh.webp などコロンなしキー）のカード描画時、getFileStoredDomain が画面上部で現在選択中のアクティブ配信ドメイン（getSelectedR2Domain()）を返却してしまっていた。
   - その結果、ユーザーが画面で 	estunko を選ぶと、全く関係のない過去のカードまで 	estunko に化けてしまう不具合が発生していた。
2. **エイリアス作成時の元カード巻き込みと二重カード発生**:
   - 	estunko に化けて見えていたカードから本来の misskey-media エイリアスを作成した際、正規キー misskey-media.okpn.f5.si:feyeaofj.webp が生成される一方、手元台帳照合（ddOrUpdateLocalLedgerItem）がファイル名単体で既存をマッチさせて上書き・混同していた。
   - さらに、KV 内に旧単体キーと新プレフィックス付きキーが両立した結果、画面上に同一ドメイン（misskey-media）の同一ファイルカードが 2 枚重複表示されていた。
3. **静的リレー経由での単体キー 404 問題**:
   - delivery.js の単体キーフォールバック照会が 	argetHost === currentHost（直接アクセス時）に限定されていたため、リレー経由で単体キーファイル（x7hjsnoh.webp）にアクセスした際に 404 に弾かれていた。

#### 2. 実施した恒久改修
1. **カード単位のドメイン不可侵性の確立 (cividge/app.js)**:
   - getFileStoredDomain: 
awKey（ホスト名プレフィックス）および KV メタデータ（d / llowedHost）を絶対優先とし、アクティブ配信ドメインによる他カードの一括上書きを完全撤廃。
   - ileDomainMap でのファイル名単体キーによるドメイン記憶を排除し、他カードへの連動汚染を完全根絶。
2. **手元台帳照合の厳格化 (ddOrUpdateLocalLedgerItem)**:
   - ファイル名単体での照合を廃止し、必ず完全一意キー（
awKey / domain:filename）で一致判定を行うよう修正。エイリアス作成時も元カードは 1 ミリも影響を受けず、新ドメインのカードのみが独立して追加される。
3. **同一ドメイン重複カードの自然な統合排除 (etchAndRenderR2Files)**:
   - リスト構築時、ドメイン付き正規キーを優先ソートし、同一ドメイン・同一ファイル名の重複カードを自動スキップするフィルターを導入。画面上の重複を綺麗に 1 枚に解消。
4. **Worker のリレー経由単体キーフォールバック修復 (cividge-kv-worker/delivery.js)**:
   - リレー経由アクセス時でも、プレフィックス付きで見つからなかった場合は単体キーをフォールバック照会し、メタデータ d が一致していれば正常採用するよう改修。
   - ➔ 	estunko.pages.dev/x7hjsnoh.webp が 200 OK（30.6 KB）で完全開通！
5. **不変条件 [INV-FRONT-007] の制定**:
   - 「エイリアスを追加するときにもととなったファイルのドメインも釣られて変わること、他のファイルのドメインが連動して変わることは絶対にあってはならない（ドメイン独立性とエイリアス非干渉の原則）」を両リポジトリの INVARIANTS.md に明記・プッシュ完了。

---

### 27. R2 エイリアス削除後の「更新時カード増殖」および「連動消滅」バグの根絶 (2026-09-20)

#### 1. 発生していた障害と根本原因
1. **更新時のカード増殖（見せかけカードの二重出現）**:
   - **現象**: R2 で作成したエイリアス（例: `testunko.pages.dev:foo.jpg`）を「リンクのみ削除」した後、一見消えたように見えるが「🔄 更新」を押すと元ファイル（`misskey-media`）と同じドメインの見せかけカードが 2 枚に増殖する。
   - **根本原因**:
     - **原因A (ローカル台帳タプルの情報欠落)**: `saveLedgerToLocalStorage` で `item.s3Key || item.rawKey` と保存していたため、エイリアスカードのドメインプレフィックス（`rawKey`）が削ぎ落とされ、`s3Key`（単体ファイル名）として保存されていた。また、`metadata.allowedHost` を保存・復元していなかったため、キャッシュ復元時に現在選択中ドメイン（`misskey-media` 等）が適用されて同じドメインのカードが 2 枚出現していた。
     - **原因B (ステップ1 / ステップ2 の二重生成)**: `fetchAndRenderR2Files` のステップ1（KV台帳走査）において、`rawKey` にプロトコルが含まれるか否か、またメタデータ `d` の有無によって `seenR2DomainFiles` の判定キーが不一致となり重複排除をすり抜けていた。さらにステップ2（S3生ファイル追加）において、ステップ1で既にカード化された実体ファイル名の重複ガードが存在しなかったため、`consumedS3Keys` の判定漏れ時に S3 生ファイルが無条件に 2 枚目として push されていた。
2. **削除時の連動完全消滅（ファイル実体と全カードの同時蒸発）**:
   - **現象**: 増殖した 2 枚のカードのうち片方を削除すると、2 枚とも消滅し、S3 バケットの実体も消去されてしまう。
   - **根本原因**:
     - 画面上に同じ `dataset.key` を持つ見せかけカードが存在した場合、`el.dataset.key !== key` により `siblingLinks` が 0 件（単独ファイル）と誤認され、ユーザーが「リンクのみ削除」を選んでいても `deleteOriginAlso = true` となって `safeDeleteS3Objects`（S3 物理削除）が実行されていた。
     - さらに `removeItemsFromLocalLedger` のフィルターが `k3`（`s3Key`）までヒットさせていたため、手元台帳から同一実体のカードが全滅していた。

#### 2. 実施した恒久改修 (cividge/app.js)
1. **ローカル台帳タプルの拡張と完全復元 (`saveLedgerToLocalStorage` / `loadLedgerFromLocalStorage`)**:
   - タプルに `[8]: rawKey` と `[9]: allowedHost` を追加。
   - キャッシュ復元時にもエイリアスのドメイン・完全キー・固定配信ドメインを 100% 忠実に復元し、元ファイルと同じキー・ドメインに化ける現象を物理的に根絶。
2. **手元台帳のピンポイント差分削除 (`removeItemsFromLocalLedger`)**:
   - 通常削除（リンクのみ削除）時は `item.rawKey` が完全一致するもののみをピンポイントで削除。大本の実体キー（`s3Key`）で他カードまで巻き添え削除される脆弱性を排除。
3. **R2 ファイル一覧構築の二重消費・重複生成の完全防止 (`fetchAndRenderR2Files`)**:
   - ホスト名を `cleanHostFn` によりプロトコル・ポート除去で完全に正規化し、`seenR2DomainFiles` による同一ドメイン・同一ファイル名の重複を 100% 遮断。
   - `processedPhysicalKeys` Set を新設し、ステップ1で処理されたすべてのファイル実体名（`matchedS3.Key`, `recordedS3Key`, `displayName`）を記録。
   - ステップ2 で `processedPhysicalKeys.has(s3Item.Key)` をチェックし、S3 生ファイルの二重 push を物理的にブロック。
4. **エイリアス削除時における S3 実体消去の物理禁止 (`delete-r2-file-btn`)**:
   - 削除対象キーがエイリアス（`key.includes(":") || key !== resolvedS3Key`）の場合、**いかなる場合も S3 物理実体削除（`safeDeleteS3Objects`）を絶対に実行しない（`deleteOriginAlso = false` 固定）** ように安全ロックを導入。
   - 同一実体判定において `dataset.s3key` だけでなく `dataset.displayname` も含めて正確に兄弟リンクを検出。


---

### 28. 非対称なエイリアス主従関係の完全撤廃と「対称的ハードリンク（参照カウント）モデル」への移行 (2026-09-20)

#### 1. 存在していた問題と潜在リスク
- **問題の本質**:
  - `isAlias = key.includes(":")` のように、キー名の文字列（コロンの有無）に基づいて「コロンなし＝本物（親）」「コロンあり＝エイリアス（子）」という非対称な主従関係を定義していた。
- **引き起こされる破綻シナリオ**:
  1. **孤児化（ゴミデータ残存）リスク**:
     - 元カード（コロンなし）を先に削除し、別ドメインカード（コロンあり）が最後の 1 個として残った場合、現在のコードは `isAlias === true` と判定してしまう。
     - その結果、「最後の 1 個なのに、エイリアスだから実体は消さない」と判定され、S3 バケット内に誰からも参照されない実体ファイルが永遠にゴミ（孤児オブジェクト）として放置され、容量を圧迫し続ける。
  2. **親削除時の連動事故リスク**:
     - 元カード（コロンなし）の削除時だけ「親・本物」として扱われ、兄弟リンクが残っていても「すべて完全削除」のルートに入り込みやすくなっていた。

#### 2. 改修方針：対称的ハードリンク（参照カウント）モデルの確立
Linux ファイルシステムの `inode` / `hardlink`、および IPFS の `CID` / `名前` の関係に倣い、**コピー元・コピー先の役割・親子関係を完全撤廃し、実体への参照数（カード数）のみに基づいて状態遷移する対称モデル**へ移行する。

```
【参照数 2 以上の場合】:
  コピー元だろうが追加ドメインだろうが、すべてが対等な「参照リンク（エイリアス）」。
  どのカードを削除しても「リンクのみ削除（実体は残す）」をデフォルトとし、実体を保護。

【参照数 1（最後の 1 個）の場合】:
  キー名にコロンがあろうがなかろうが、実体と結びついた「最後の唯一の窓口（本物）」。
  これを削除することは実体そのものの抹消を意味するため、S3 実体も同時に安全消去（unlink）する。
```

#### 3. 具体的な改修内容 (`cividge/app.js:9324-9388`)
1. **名前依存判定（`isAlias`）の完全撤廃**:
   - `key.includes(":")` や `s3Key !== key` による主従分岐を全廃。
2. **参照数（兄弟リンク数）に基づく単一の対称判定**:
   - 同一実体（`resolvedS3Key`）を指すカードの存在数（`siblingLinks.length`）のみで判定。
   - `siblingLinks.length > 0` ➔ 兄弟が存在するため、どれを消しても実体は残す（`deleteOriginAlso = false`）。
   - `siblingLinks.length === 0` ➔ 最後の 1 個であるため、実体も一緒に消去（`deleteOriginAlso = true`）。
3. **Filebase モードとの挙動統一**:
   - Filebase 側も同様に対称な参照カウントモデルであることを確認・整合。

---

### 29. 【要改修】R2 タブに Filebase ファイルが混入表示されるバグ (2026-09-20)

#### 1. 現象
- R2 タブ（Cloudflare R2 モード）を表示すると、Filebase（IPFS）で管理されているファイル（`feyeaofj.webp`, `yep59jt5.jpg`, `8b1w9ncx.webp`, `atsoktiq.webp` 等）が混入して表示される。
- これらのファイルには IPFS CID バッジ（`Qm...`）や「IPFS: 漂流中」バッジが付いており、明らかに Filebase 所属のレコード。
- R2 へのアップロード自体は正常に動作する（`9euXZ2sV.jpg` は正しく R2 に表示）。
- INV-CORE-006（host:filename 均一キー移行）のデプロイ後に発生。

#### 2. 原因分析（3つの複合要因）

##### 原因 A: `fetchKvFiles()` がプロバイダ無差別に全 KV レコードを返す
- `fetchKvFiles()`（L7569-7574）は KV の全レコードを返し、R2/Filebase の区別はフィルタリングロジック（L7602-7622）に委ねている。
- フィルタリングは `metadata.backend` と `kvCid` の値に依存するが、**旧レコードで `backend` メタデータが未設定のもの**が存在する場合、`isExplicitFilebase === false` かつ `isExplicitR2 === false` となりフィルタをすり抜ける。

##### 原因 B: `hasIpfsCid` チェックの穴（L7608-7609）
```javascript
const hasIpfsCid = kvCid && kvCid !== "r2" && (kvCid.startsWith("Qm") || kvCid.startsWith("baf") || kvCid.length > 20);
if (hasIpfsCid && !isExplicitR2) continue;
```
- `kvCid` の値は L7601 で複数ソースからフォールバック取得される：
  ```javascript
  const kvCid = kvItem.metadata?.cid || kvItem.metadata?.c || kvItem.value || getStoredIpfsCid(rawKey) || getStoredIpfsCid(displayName) || "";
  ```
- 旧レコードで `metadata.cid` が圧縮されて `kvItem.value` にのみ CID が入っている場合、`kvItem.value` が正しく取得される。しかし INV-CORE-006 改修でキー名が `host:filename` に変わったため、`getStoredIpfsCid(rawKey)` のルックアップが旧キー名と不一致になり、CID が空で返るケースが生じる。
- `hasIpfsCid === false` → L7609 のフィルタをスキップ → L7622 へ到達。

##### 原因 C: ViewerMode フラグのオーバーキャッチ（L7622）
```javascript
const isR2Record = isExplicitR2 || Boolean(matchedS3) || (isViewerMode && !isExplicitFilebase);
```
- `isViewerMode` が `true`（R2 ストレージ未設定 + KV アクセスあり）の場合、`!isExplicitFilebase` であれば**なんでも通す**。
- 原因 A・B と合わせて、`backend` が未設定かつ CID 判定が効かない Filebase レコードが R2 一覧に混入する。

##### 原因 D: ローカル台帳のキャッシュ汚染
- `saveLedgerToLocalStorage("r2", contents)` で混入した Filebase ファイルを含む `contents` がローカルに保存されてしまう。
- 以降のタブ切り替えや再起動時にも `loadLedgerFromLocalStorage("r2")` で汚染済みキャッシュが読み込まれ、表示が固定化する。

#### 3. 改修方針（案）

1. **`fetchKvFiles` の段階でプロバイダフィルタリング**:
   - `fetchKvFiles(requestedProvider)` にプロバイダを渡し、KV レスポンスから `metadata.backend` でフィルタリングする。
   - または、R2 モードでは `metadata.backend !== "filebase"` 且つ `(kvCid === "r2" || !kvCid || metadata.backend === "r2")` の KV レコードのみ通す厳格なホワイトリスト方式に変更。

2. **ViewerMode のフィルタ強化**:
   - `isViewerMode` 時でも `hasIpfsCid` チェックは適用し、IPFS CID を持つレコードは R2 一覧から確実に除外する。
   - 修正案: `const isR2Record = isExplicitR2 || Boolean(matchedS3) || (isViewerMode && !isExplicitFilebase && !hasIpfsCid);`

3. **ローカル台帳のクリーンアップ**:
   - 汚染済みの `cividge_ledger_r2` を一度クリアする（`localStorage.removeItem("cividge_ledger_r2")`）、またはタブ切り替え時にプロバイダ整合チェックを入れる。

#### 4. 影響範囲
- 表示のみの問題。R2 へのアップロード・配信は正常。
- Filebase タブ側にも R2 ファイルが混入していないか要確認。
# Historical handoff archive (non-normative)

> **注意:** この文書は過去の作業記録であり、現在の仕様ではありません。
> `INVARIANTS.md`、`SPEC.md`、現行コードと回帰テストを正とします。
> 以下に残る bare key、`IPFS_KV`、tombstone、GET cleanup、localStorage
> last-reference 判定等の記述は、歴史的経緯の追跡専用です。

