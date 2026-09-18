# Cividge インフラ・セキュリティ設定運用手順書 (Cloudflare Runbook)

このドキュメントは、Cividge の配信ドメイン（Worker カスタムドメインおよび静的 Pages リレー）において、**DoS 攻撃（キャッシュバスター攻撃）を防止し、エッジキャッシュと Worker の整合性を維持するための必須インフラ設定** をまとめた標準運用手順書（SOP）です。

新規ドメインの追加や、Cloudflare ゾーン再構築の際は、必ずこの手順に従って設定を行ってください。

---

## 1. 脅威モデル：なぜ「クエリ無視（Ignore Query String）」が必須なのか？

### キャッシュバスター DoS 攻撃 (Cache-Busting DoS Attack)
* **攻撃手法**:  
  攻撃者が `https://misskey-media.okpn.f5.si/image.webp?rand=12345` のように、末尾にランダムなクエリパラメータ（キャッシュバスター）を付与して大量リクエストを送りつける攻撃。
* **デフォルト設定（Standard）の脆弱性**:  
  Cloudflare の初期設定では「クエリ文字列ごとに別のキャッシュ」を作成しようとします。そのため、クエリが変わるたびにエッジキャッシュが **MISS** となり、**すべてのリクエストが Cloudflare Worker および上流ストレージ（Filebase / R2）へ直接貫通** してしまいます。
* **被害**:  
  - Cloudflare Worker の実行回数（無料枠・従量課金）が瞬時に枯渇。
  - 上流ストレージの転送帯域が圧迫され、正規ユーザーのアクセスが 503 / 504 障害で停止。
* **防衛策**:  
  Cloudflare の Cache Rules で **「すべてのクエリ文字列を無視 (Ignore query string)」** を強制し、URL にどんなデタラメなクエリがついていても、エッジキャッシュから同一メディアを即座に **HIT** 返却して上流を 100% 防護する。

---

## 2. Cloudflare Cache Rules の設定手順（ゾーン共通）

対象ゾーン（例: `okpn.f5.si`、`k7m.f5.si` 等）のダッシュボードを開き、以下の通り設定します。

### ステップ 1: ルールの新規作成
1. Cloudflare ダッシュボードで対象ドメイン（ゾーン）を選択。
2. 左メニュー **「キャッシュ (Caching)」** $\to$ **「キャッシュ ルール (Cache Rules)」** を開く。
3. **「+ ルールを作成 (Create rule)」** をクリック。

### ステップ 2: 条件の設定
* **ルール名**: `Ignore Query String and Media Cache`
* **受信リクエストが一致する場合**: 「カスタム フィルタ式」を選択
* **式 (Expression)**:
  「式を編集」をクリックし、Cividge の全対応拡張子をカバーする以下の式を貼り付けます：

```text
(http.request.uri.path.extension in {"jpg" "jpeg" "png" "webp" "gif" "avif" "jxl" "bmp" "ico" "mp4" "webm" "mov" "m4v" "avi" "ogv" "mp3" "wav" "ogg" "m4a" "flac" "aac" "zip" "7z" "rar" "tar" "gz" "pdf" "txt" "md" "json" "csv"})
```

### ステップ 3: キャッシュ動作の設定
* **キャッシュの対象 (Cache eligibility)**:
  - **「キャッシュの対象 (Eligible for cache)」** を選択。
* **エッジ TTL (Edge TTL)**:
  - **「キャッシュ制御ヘッダーが存在する場合は使用し、存在しない場合はキャッシュをバイパスします」** を選択。
  - *(理由: Worker の `Cache-Control` ヘッダーおよび登録直後 30秒 Grace Period の `no-store` を 100% 尊重させるため)*
* **ブラウザ TTL (Browser TTL)**:
  - **「オリジン TTL を尊重する」** を選択。

### ステップ 4: キャッシュ キー (Cache Key) の設定 ★最重要！
* **「キャッシュ キー (Cache Key)」** の設定欄を展開。
* **「クエリ文字列 (Query string)」**:
  - **「すべてのクエリ文字列を無視 (Ignore query string)」** または **「すべてのクエリパラメータを除外」** を選択。
  - *(理由: ランダムクエリ攻撃をエッジで一掃するため)*

### ステップ 5: 保存と展開
* 画面右下の **「デプロイ (Deploy)」** をクリック。
* *(※「DNS構成によりプロキシされていない可能性があります」という警告が出た場合は、「とにかくルールを無視して展開する」を選択して続行します)*

---

## 3. 動作検証チェックリスト (Verification)

設定完了後、ターミナルから以下の curl コマンドを実行し、防御状態を確認します。

```bash
# ランダムクエリを付与してリクエストを送信
curl -IL "https://<ドメイン>/<存在するファイル名>?random_test_12345=check"
```

* **期待される結果**:
  - レスポンスヘッダに **`CF-Cache-Status: HIT`** が返ってくること。
  - 初回から即座にエッジキャッシュで撃退されていれば合格。
