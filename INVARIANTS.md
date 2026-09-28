# システム不変条件 (System Invariants) - Cividge Frontend

> **Lifecycle authority supersession.** Browser peer scans, tombstones,
> client-side last-reference decisions, and direct physical deletion described
> by older text are obsolete. `localStorage` is UI/cache only;
> `host:filename` is the only Link identity; LinkBinding is authoritative for
> Link-key uniqueness, generation, binding, and policy; ObjectLifecycle is
> authoritative for Object membership, Placement lifecycle, and release;
> delivery KV is a projection; and
> physical release requires an authority-issued task.

## Lifecycle authority

- A Link is canonical `host:filename`. An immutable Object has exactly one
  provider-independent `sha256:<lowercase digest>` ObjectId calculated from
  the exact final bytes. R2 keys, Filebase/Kubo CIDs and provider ownership
  belong to Placements, not Object identity.
- **[INV-OBJECT-IDENTITY-INDEPENDENT-OF-PLACEMENT]** Equal final bytes have
  one ObjectId across R2, Filebase and Kubo; different bytes have different
  ObjectIds. No provider, bucket, key, CID or delivery path participates in it.
- **[INV-ONE-LIFECYCLE-AUTHORITY-PER-OBJECT]** Every managed Link and
  Placement for one ObjectId converges on one ObjectLifecycle authority.
- **[INV-CID-MEANS-CID]** A field named CID contains a real content identifier
  or is absent; `cid="r2"` and unconditional CID lowercasing are forbidden.
- **[INV-SINGLE-PLACEMENT-AUTHORITY]** Physical release requires a current
  claim from the ObjectLifecycle for the exact ObjectId and its full Link set.
- S3 Placement authority records the exact `(bucket, key)`; a browser or Worker
  may actuate it only through the matching configured bucket.
- **[INV-DERIVED-ARTIFACT-NOT-LINK]** A generated video thumbnail has different
  bytes from its parent, but is a dependent preview, not a video Placement or
  an independently managed Object/Link. It receives no LinkBinding or public
  KV Link. A real user upload named `foo.thumb.webp` remains a normal Link.
- **[INV-DERIVED-ARTIFACT-FOLLOWS-PARENT]** The parent ObjectLifecycle owns the
  thumbnail's deterministic R2 key and claim state. Peer Links share one
  thumbnail; removing one peer keeps it. Only release of the final parent Link
  authorizes thumbnail cleanup, with retryable failure and no effect on video
  identity, LinkBinding, or delivery when preview generation fails.
- `createLink` and `removeLink` pass the lifecycle authority. Peer Links have
  no old/new or primary/secondary role.
- A GET does one canonical KV lookup, performs no storage fallback and causes
  no write, repair, delete, or release.
- Object release requires an authoritative empty Link set. FIFO, expiry,
  manual delete, and Civitai cleanup only request release.
- **[INV-FIFO-IS-POLICY-NOT-AUTHORITY]** FIFO may select cleanup candidates
  and request release, but it cannot authorize an Object or Placement
  transition. Physical actuation follows an ObjectLifecycle-issued claim.
- Public delivery distinguishes a successful canonical KV miss (404) from a
  KV read failure or a known Link whose origin cannot be fetched (503,
  `no-store`). The latter must never be cached as a missing Link.
- A managed-list refresh failure retains the last local snapshot and reports
  failure; it does not turn an unavailable observation into an empty list.
- Worker executes R2 work. Browser/local holders execute Filebase/Kubo only
  after an issued task and report success or retryable failure. Their
  credentials are an explicit boundary, not lifecycle authority.
- Re-uploading the same bytes to the same canonical Link is idempotent. A
  confirmed storage upload may re-acquire a previously `RELEASED` Placement in
  a new generation before recreating the Link; alias-only `createLink` cannot.

### [INV-KV-DISPOSABLE-PROJECTION]

KVは公開配信のLink projectionとGatewayConfig等のruntime設定を保持するが、
Object/Link/Placementのlifecycle authorityではない。旧schemaのKV recordに
互換性の権利はない。空のKV namespaceへの切替はsemantic cutoverの境界にできる。
ただしKVを破棄・再作成しても、Durable Objectの正本やR2/Filebase/Kuboの
物理実体は削除されない。KV missをObject解放の許可と解釈してはならない。

### [INV-FRESH-AUTHORITY-CUTOVER]

既存Linkをすべて破棄するclean cutoverでは、ObjectLifecycleとLinkBindingの
双方を空の新routing epochへ向け、配信KVとbrowser managed-list cacheも新世代に
する。同じCIDは新authorityで再利用可能であり、特定CIDを永久に排除しない。
R2/Filebase/Kuboの旧物理実体は自動削除しない。物理観測をLinkへ昇格させない。

### [INV-MANAGED-LIST-INDEPENDENT-FROM-PLACEMENT]

Managed Listの項目は `link` または `local` として明示する。R2 / Filebase /
Kuboの実体の出現・消失はObservationであり、一覧項目の作成・退場という
Mutationそのものではない。明示更新で実体が見えなくなっても、既存の
local項目は観測状態を更新するだけで残す。

### [INV-MANAGED-ENTRY-REMOVABLE]

現行schemaで表示できる全Managed List項目には決定的な退場操作がある。
`link` はcanonical `removeLink`、`local` はそのブラウザの
`retireManagedEntry`へ写像する。local退場は物理Object/Placementも
他のLinkも削除しない。Filebase/R2実体の直接削除を一覧削除のfallbackに
使ってはならない。

### [INV-GATEWAY-NOT-PLACEMENT]

Public IPFS GatewayはCIDからHTTPで取得するRetrieval Capabilityであり、
Object/Link/Placementではない。Gatewayの成功・失敗はObservationであって
Object/Link/Placementのlifecycleを変更しない。Filebase provider経由の
retrieval routeとpublic IPFS network gatewayは混同しない。

このドキュメントは、Cividge フロントエンド（UI / Pages）および関連システムが正常に動作するために、**いかなるコード改修やリファクタリングを行っても絶対に崩してはならない性質（不変条件）** を定義したものです。

配信 Worker 側の不変条件については `cividge-kv-worker/INVARIANTS.md` を参照してください。

---

## 0. アーキテクチャの根本原則と倫理憲章 (Core Architecture Principles)

### [PRINCIPLE-UI-IS-PROJECTION] UI は Domain の写像

* **設計原則**: Domain 内部では、identity・不変条件・状態遷移・権限・capability・failure semantics が同じ意味を表すなら、プリミティブを重複させず、可能な限り一つの canonical state へ正規化する。一方、UI は人間向けの Presentation / Projection であり、理解や操作のしやすさのためにラベル、グループ、説明、視覚的な区別、操作手順を増やしてよい。UI 構造は Domain 構造と一対一である必要はない。
* **境界**: UI 上の複数表現が同じ意味を持つ場合、保存・実行時には同じ canonical domain state へ正規化する。表示上だけの区別を独立した永続 state、authority、domain primitive に昇格させない。UI の利便性を理由に、Domain から除いた意味の重複を再導入しない。
* **画像変換の例**: UI は「変換しない / WebP / JPEG XL / JPEG」と表示してよい。canonical な `conversionMode` は `passthrough | webp | jxl | jpeg` の一つだけとし、MIME type は実際の変換を行う境界で導出する。変換の有無を別の永続 boolean として持たない。
* **ファイル名の例**: UI は「元のファイル名を維持」「名前を変更する」などの案内や選択肢を示してよい。保存・実行される `filenamePolicy` は `{original}` または具体的な pattern に正規化し、別の `renameEnabled` を永続化しない。空入力も `{original}` へ正規化する。

「意味空間を減らす」は「UI の選択肢や説明を最小限まで削る」ことではない。たとえば UI に checkbox と select の二段階操作が必要でも、それをそのまま `boolean + mode` という二重の永続意味にしてはならない。**Domain は圧縮する。UI は人間のために展開してよい。UI は Domain の写像であり、Domain そのものではない。**

### [INV-FILENAME-POLICY-CANONICAL]

空文字列は filename policy ではない。非リネームの唯一の canonical representation は `{original}` とする。UI 入力途中の空欄は許すが、保存・復元・実行時には `{original}` へ正規化し、別の rename boolean を保存しない。

### [INV-CORE-001] 無料枠の徹底節約とサイバー攻撃バッファの維持原則 (Zero-Waste & Attack Buffer Principle)
* **規則 (Rule)**:  
  本システムは、**Cloudflare の無料アカウント枠（KV 書き込み/リスト: 1日1,000回、KV 読み込み: 1日100,000回）の範囲内で完全に自活・運用されること** を絶対の前提とする。  
  通常運用におけるリソース消費を極限まで削ぎ落とし、**1日の大半の消費枠を「サイバー攻撃（悪意あるランダム URL DoS やクローリング）に対する防衛バッファ」として温存・維持しなければならない (MUST)**。

* **設計倫理 (Rationale & Philosophy)**:  
  Web 上で公開されている以上、存在しないランダムなパスを1秒に1回叩き続けるような DoS 攻撃（1日約 86,400 回）は日常的に発生し得る。  
  平時における無駄な KV 通信・書き込みを徹底的に排除し、「1秒に1回・1日8万回以上の攻撃が飛んできても、残りの1万数千回で平然と正規のサービスを維持できる」だけの圧倒的な節約アルゴリズム（無駄打ちゼロの単一キー探索、エッジキャッシュによる即時防衛、不要な書き込み・走査の徹底排除）を追求すること。**「動けばよい」「無料枠の内側だから多少無駄遣いしてもよい」という甘えは設計の敗北である。**

---

### [INV-CORE-002] 完全 BYOC と開発者非特権・秘密情報非ハードコード原則 (Pure BYOC & Zero-Privilege Principle)
* **規則 (Rule)**:  
  フロントエンド（`cividge.pages.dev`）は全ユーザー共通の単なる静的エントリポイントであり、バックエンド（Cloudflare Worker、KV、ストレージノード等）は**各ユーザーが自身の Cloudflare アカウントで自己調達・自己管理するもの（Bring Your Own Cloud: BYOC）** である。  
  **開発者自身も何ら特権を持たない「ただの1ユーザー」に過ぎない。**  
  したがって、ソースコードやリポジトリ設定に、開発者や特定個人の API トークン、アカウント ID、シークレット、個人所有ドメイン名、特定環境専用の固定値を**絶対にハードコードしてはならない (MUST NOT)**。

* **設計倫理 (Rationale & Philosophy)**:  
  すべての接続設定・認証情報は、クライアント側のローカル環境（`localStorage` 等）またはユーザー自身の Worker 環境変数（Secrets）から動的に供給されなければならない。  
  コード上に特定ユーザーの個人ドメインや秘密鍵をハードコードすることは、他ユーザーのポータビリティを奪い、情報漏洩事故を招く極めて危険なアンチパターンである。開発者は常に「自身の環境もただの1インスタンスに過ぎない」という意識でコードを書かなければならない。

---

### [INV-CORE-003] 過剰な自動保護の禁止と根本原因の究明原則 (Anti-Overprotection & Root Cause Principle)
* **規則 (Rule)**:  
  「台帳にないのに実体がある」「手動で直接バケットに置かれた」といった、通常運用ではあり得ない異常な状態遷移を想定して安易に自動フォールバック（自己修復）を組み、それによって Cloudflare の無料枠（KV や R2 のリクエスト回数）を平時や攻撃時に浪費することを厳格に禁止する (MUST NOT)。

* **設計倫理 (Rationale & Philosophy)**:  
  1. **過剰な自動保護（おせっかいコード・YAGNI違反）の排除**: ユーザーから明確に要求されていない架空のユースケース（ダッシュボードからの手動操作の救済など）を勝手に想定してコードを肥大化・複雑化させてはならない。
  2. **対症療法ではなく原因療法の徹底**: 異常な状態遷移（同期ズレや孤児ファイル）が観測された場合、自動フォールバックで誤魔化して取り繕うのではなく、まず「なぜそのような異常な状態遷移が起きたのか（削除漏れや期限切れ処理のバグ等）」という根本原因を疑い、根治しなければならない。
  3. **防御壁の維持**: 存在しないファイルや異常なリクエストに対しては、裏側のストレージを探しに行くような過保護な救済を一切行わず、エッジで即座に「404 Not Found」として門前払いしなければならない。

---

### [INV-CORE-004] 読み取り・描画時の書き込み（副作用）密輸および過剰自己修復の全面禁止 (Read-Safe & Anti-Side-Effect Principle)
* **規則 (Rule)**:  
  閲覧、一覧取得、描画、配信アクセス等の「読み取り系操作（GET / HEAD / RENDER）」において、暗黙的・自動的に KV の書き込み（`put` / `delete`）や外部通信の連打（副作用）を発火させることを厳格に禁止する (MUST NOT)。  
  あらゆる読み取り処理は完全な Read-Only でなければならず、書き込み枠（1日1,000回）を1回たりとも消費してはならない。

* **禁止される実装パターン（アンチパターン規律）**:  
  1. **副作用の密輸（Side-effect Smuggling）**:
     - 画面を開いた時、一覧を描画した時、カードを表示した時、または配信 URL を踏んだ時に、裏側で勝手に `registerKvCid` や `kv.put` / `kv.delete` を実行してはならない。
  2. **画面起動時バルク実行（Auto-Bulk On Mount）**:
     - アプリ起動やページ描画と同時に、全件走査して外部通信や KV 書き込みを連打してはならない。
     - 整合性の再同期や全件ステータス更新は、ユーザーが明示的に「同期ボタン」を押した時のみ（明示的オプトイン）実行を許可する。
  3. **妄想的フォールバックと空振り照会（Paranoid Fallback）**:
     - メタデータやリクエスト情報から「存在しない」ことが自明なキー（別バックエンドの `blob_` キー、非該当ホスト、廃止された旧インデックスキー等）を、「あるかもしれない」と憶測で KV に問い合わせてはならない。
  4. **ゾンビ自己修復（Zombie Self-Healing）**:
     - 台帳に存在しないキーや不整合を発見した際、裏で勝手に台帳へ再登録・自動修復してはならない（期限切れファイルのゾンビ復活・書き込み枠破壊の防止）。
     - 未知のキーはエッジキャッシュ付き 404 で即座に門前払いし、不整合は根本原因（作成・削除フロー）の改修で根治しなければならない。
  5. **キャッシュ無視と通信先行（Cache-Bypass Syndrome）**:
     - クライアントキャッシュ（localStorage / メモリ）やエッジキャッシュ（Cache API）を意図的にすり抜ける（`cache: "no-store"` の濫用など）実装を禁止する。
     - クールダウン判定やガードは通信の「前」に配置し、不要な通信を1回たりとも飛ばしてはならない。

---

### [INV-CORE-005] Local-First UI と server-authoritative lifecycle の分離
* **規則 (Rule)**:
  1. **手元キャッシュの差分更新 (Optimistic UI Cache)**:
     ファイルの追加・削除・リネーム・メタデータ変更等の通常操作完了後、サーバー（KV/R2）への全件再照会・再フェッチ（`fetchKvFiles` / `fetchAndRenderR2Files`）を行ってはならない (MUST NOT)。手元のキャッシュ（`localStorage` およびメモリ内データ構造）を差分更新し、即座に画面を再描画しなければならない。
     ただし localStorage は UI / recoverable cache であり、Link 関係、最終参照、Object release の authority ではない。
  2. **起動時・画面遷移時のサーバー通信ゼロ化 (Zero-Fetch on Mount / Transition)**:
     手元にローカル台帳（`localStorage`）が存在する場合、画面初期ロード時やタブ切り替え時にサーバーへ全件フェッチを飛ばしてはならない (MUST NOT)。手元台帳からミリ秒単位で即座に描画し、サーバー同期はユーザーが明示的に「🔄 更新」ボタンを押した時のみ（明示的オプトイン）に限定する。
  3. **表示上の解決と lifecycle authorization の分離**:
     並び替え、表示フィルター、同名警告等は手元キャッシュで解決してよい。一方、Link 作成・削除、最後の参照判定、Placement release は canonical ObjectRef から一意に決まる Durable Object を必ず通す。クライアントが `isCidShared`、墓標、手元件数等から物理削除を許可してはならない。公開 GET と通常 UI 操作のいずれにも KV 全件走査フォールバックを持たせてはならない。

* **設計倫理 (Rationale & Philosophy)**:  
  - ブラウザの `localStorage` は安価かつ大容量（通常5MB〜10MB。タプル圧縮台帳なら数万件格納可能）であり、高速に永続化できる。
  - 一方で Cloudflare KV の `list()` 枠は **1日たった 1,000回** しかなく、全リソースの中で最も貴重である。
  - 操作のたびに「念のため最新をサーバーから取り直す」という旧来の Web アプリ設計は、1回削除するごとに `list()` 枠を消費し、一瞬で無料枠を破綻させる。
  - 「表示は手元、状態遷移の許可はサーバー」という境界により、KV `list()` の浪費と stale localStorage による Object 誤削除を同時に防ぐ。

---

## 1. メディア表示とサムネイル描画 (Media & Thumbnail Invariants)

### [INV-FRONT-001] 動画プレビューは親 Link の表示写像
* **規則 (Rule)**:  
  ストレージ管理一覧では、親動画 Link の `?preview=1` から派生 WebP を表示する。取得できない場合は通常の動画プレースホルダーへ戻す。

* **理由 (Rationale)**:  
  一覧のプレビューのために動画本体をRange取得したり、派生画像へ独立した公開Linkを作ったりしない。プレビュー生成失敗は動画本体の公開を妨げない。

* **前提条件 (Dependency)**:  
  `?preview=1` は親Linkのcanonical KV lookup、expiry、password gateを通る。派生画像に独立した配信identityはない。

* **禁止事項 (Prohibited)**:  
  - ファイル名の `.thumb.webp` だけを根拠に管理一覧から行を隠すこと。

---

### [INV-FRONT-002] 透過的 S3 フォールバックの維持
* **規則 (Rule)**:  
  公開配信レイヤからの画像読み込みが一時的に失敗（または未伝播）した場合、`onerror` ハンドラから `loadFallbackImageFromS3` を通じて署名付き直接取得へ透過的にフォールバックしなければならない。

* **理由 (Rationale)**:  
  エッジキャッシュが準備中であっても、アップローダー本人は確実に自分のファイルを表示・確認できるようにするため。

---

## 2. リソース制限とクライアント安全性 (Resource & Client Safety)

### [INV-FRONT-003] 単一ファイルアップロード上限（十進80 MB以下）
* **規則 (Rule)**:  
  ブラウザ・Worker APIを含むすべての単一ファイルアップロードは、入力と実際に保存する最終バイト列の双方を**80,000,000バイト以下**に制限しなければならない。表示上の「80 MB」は十進単位とする。

* **理由 (Rationale)**:  
  1. **スマホ（iOS / Android）のメモリ保護（OOM クラッシュ防止）**:  
     Cividge はブラウザ内で CID（ハッシュ）計算や EXIF 処理を行うため、入力サイズ以上の JavaScript メモリを瞬間的に消費する。特に iOS Safari 等のモバイル環境でブラウザタブが強制クラッシュするリスクを抑えるため。
  2. **Cloudflare エッジキャッシュの適合性**:  
     Cloudflare の単一ファイルキャッシュ上限（512 MB）に対して十分な安全マージンを確保し、全ファイルが確実にエッジキャッシュされる状態を維持するため。

* **禁止事項 (Prohibited)**:  
  - メモリ枯渇によるクラッシュリスクを無視して、安易に 500 MB や 1 GB などの巨大ファイル制限へ引き上げること。

---

## 3. アーキテクチャ独立性と疎結合性 (Architecture Independence & Decoupling)

### [INV-FRONT-004] バックエンド非依存（スタンドアロン・BYOC）の完全保証
* **規則 (Rule)**:  
  Cividge は、KV Worker や静的リレー、Kubo 等の外部バックエンドが一切設定されていない「素の R2 / Filebase 単体（スタンダードモード）」であっても、**エラーや機能停止を一切起こさず、ローカルファーストの単体アップローダーとして 100% 独立動作しなければならない (MUST)**。

* **理由 (Rationale)**:  
  Cividge の本質は「BYOC（Bring Your Own Cloud）＆ローカルファースト」であり、中央サーバーや追加 Worker の構築を強制してはならない。Worker やリレーはあくまで高度な防護や一元化を求めるユーザーのための「オプショナルな追加装甲（疎結合）」である。

* **満たすべき性質 (Required Behavior)**:  
  1. Worker URL や Admin API Token が未設定（一般ユーザーモード）の場合、KV 台帳への登録や通信は例外を投げず、静かに安全にスキップ（素通り）すること (`hasAdminAccess() === false`)。
  2. アップロード処理は Worker を介さず、ブラウザ内の S3 API クライアントから R2 / Filebase へ直接 PUT されること。
  3. 発行される共有 URL は、ユーザーが選択したオリジン（`r2.dev`, 各自のカスタムドメイン, `ipfs.filebase.io` 等）を直接使用すること。

* **禁止事項 (Prohibited)**:  
  - Worker や特定の配信リレーの存在を前提としたコード（それらがないとアップロードやURL生成が失敗する密結合なコード）をフロントエンドに混入させること。

---

## 4. ストレージ境界とエイリアス帰属 (Storage Boundary & Alias Invariants)

### [INV-FRONT-005] ストレージ境界の完全分離（エイリアス・カード帰属の不変条件）
* **規則 (Rule)**:  
  Filebase のファイルカードから生成されたエイリアス（別ドメインURL）は、**いかなる場合も Filebase 一覧にのみ表示されなければならず、決して R2 一覧に混入・吸着されてはならない (MUST)**。同様に、R2 のファイルカードから生成されたエイリアスは、**R2 一覧にのみ表示され、Filebase 一覧に混入してはならない**。

* **理由 (Rationale)**:  
  同一のファイル（同一ファイル名・同一ハッシュ）が Filebase と R2 の両方のバケットに並行保存される運用が存在する。KV台帳上で所属ストレージ（`backend` メタデータ）が曖昧な場合、他方のバケット内の同名オブジェクトと誤って結合（吸着）され、Filebase で作ったエイリアスが R2 側に移動して見えてしまう重大な整合性破綻を防止するため。

* **満たすべき性質 (Required Behavior)**:  
  1. **エイリアス作成時の帰属固定**: エイリアス作成時（`registerKvCid`）には、元のカードの所属ストレージ（`item.storageProvider` / `article.dataset.provider`）を明示的に `backend: "filebase"`（または `"r2"`）としてKVメタデータに100%確実に書き込まなければならない。
  2. **一覧振り分け時の絶対優先**:
     - `backend === "filebase"` のレコードは、R2 バケット内に同名ファイルが存在していたとしても、**絶対に R2 一覧から除外（スキップ）しなければならない**。
     - `backend === "r2"` のレコードは、**絶対に Filebase 一覧から除外（スキップ）しなければならない**。
  3. **CIDの確実な継承**: Filebase 由来のエイリアスは、元のカードや台帳から解決された UnixFS CID を必ず引き継ぎ、CID 空文字での登録を防止しなければならない。

* **禁止事項 (Prohibited)**:  
  - カードの所属判定を「バケット内に同名ファイルが存在するか」だけに依存させること（両方に保存されている場合に他方のストレージに吸い取られるため）。
  - エイリアス作成時に `backend` 引数の指定を省略すること。

---

### [INV-FRONT-006] 互換レイヤ未接続ドメインのストレージ排反性と宗派替え防止
* **規則 (Rule)**:  
  Cividge 互換レイヤ（Worker）の接続テストに合格していないドメイン（直結モード）は、**決して R2 と Filebase の両方に同時に登録されてはならず、必ずストレージ間で排反（排他）でなければならない (MUST)**。また、過去に一方のストレージでファイルが配信されたドメインは、**該当ファイルが台帳から完全に抹消されない限り、他方のストレージで再利用（宗派替え）されてはならない (MUST)**。

* **理由 (Rationale)**:  
  1. **衝突上書きの防止**: 互換レイヤを介さない直結ドメインではリクエスト時の動的振り分け（リバースプロキシ）ができないため、同一ドメイン・同一ファイル名が登録されると KV レコードや物理ファイルが上書き消滅する。
  2. **すり替わり事故の防止**: ユーザーが設定からドメインを削除して他方ストレージで再利用した場合、過去に共有された公開 URL が別ストレージの同名ファイルにすり替わってしまう危険を物理的に排除するため。

* **満たすべき性質 (Required Behavior)**:  
  1. **排他ガード**: 互換レイヤ未合格（直結モード）のドメインを他方ストレージにも追加しようとした場合、UI は追加をブロックし、別ドメインの利用を要求すること。
  2. **宗派替えロック**: 新規ドメイン追加時、中央 KV 台帳内に他方ストレージのファイルが 1 件でも残っている場合は追加を即座に拒否すること。
  3. **残存ファイル保護ロック**: 設定画面で配信ドメインを削除しようとした際、台帳にファイルが残っている場合はドメイン削除をブロックすること。
  4. **ミラー登録連動と解除保護**: 互換レイヤ接続済みのドメインでのみ他方ストレージへのワンクリックミラー登録チェックボックスを表示し、解除（チェックOFF）時にも残存ファイル保護ロックを適用してファイルが残っている場合の解除をブロックすること。

---

### [INV-FRONT-007] ドメイン独立性とエイリアス非干渉の原則（ドメイン連動汚染の完全禁止）
* **規則 (Rule)**:  
  エイリアス（別ドメインURL）を追加する際、**元となったファイルのドメインが釣られて変わること、および他のファイルのドメインが連動して変わることは絶対にあってはならない (MUST NOT)**。また、画面上部の配信ドメインセレクタの切り替えや他ファイルの操作によって、既存カードの表示ドメインが巻き添えで変化してはならない。

* **理由 (Rationale)**:  
  Cividge において各ファイルカードは、特定のドメインで公開されている独立した配信リソース（「ホスト名:ファイル名」を主キーとする実体）である。あるカードの操作や新ドメイン追加、あるいはグローバルセレクタの変更が既存カードのドメインを書き換えてしまうと、公開リンクの誤認、重複カードの発生、意図しないドメインでのURL共有事故を引き起こすため。

* **満たすべき性質 (Required Behavior)**:  
  1. **カード単位のドメイン不可侵性**:
     - 各カードの配信ドメインは、awKey（ホスト名プレフィックス）および KV メタデータ（d / llowedHost）により決定論的に固定されなければならない。
     - 画面上部の配信ドメインプルダウン（getSelectedR2Domain()）は「これからアップロードする新規ファイルの宛先」の指定のみに使用し、既存カードの所属ドメインを上書きしてはならない。
  2. **エイリアス作成時の完全独立**:
     - エイリアス作成時、元のカードのレコードやローカルストレージ設定には一切触れず、新ドメインのレコードのみを独立して生成・台帳に追加すること。
     - 手元台帳更新（ddOrUpdateLocalLedgerItem）において、ファイル名単体（Key）による既存アイテムの一致判定を行ってはならず、必ずホスト名を含めた完全一意キー（awKey）で照合しなければならない。
  3. **ファイル名単体でのドメイン保存の禁止**:
     - ileDomainMap 等のブラウザストレージにおいて、ドメイン名を含まないファイル名単体をキーとしてドメインを記憶・上書きしてはならない。

* **禁止事項 (Prohibited)**:  
  - エイリアス作成時に元カードの llowedHost やローカルドメイン設定を書き換えること。
  - 画面上部のドメイン選択変更イベントで、既存カードの配信URLを一括変更すること。

---

## 4. 分散ストレージ・配信ゲートウェイ連携 (Distributed Storage & Gateway Federation)

### [INV-DELIVERY-003] ストレージ状態に応じたゲートウェイ動的優先ルーティング ＆ 地域分散オープンゲートウェイ選定
* **規則 (Rule)**:  
  上流 IPFS ゲートウェイへの問い合わせ順序は、KV 台帳のピン状態（`kuboStatus`、`unpinned` フラグ）に応じて動的に制御し、Filebase のダウンロード帯域（Egress）を保護しなければならない (MUST)。また、特定の私設回線（トンネル）に依存せず、公平でオープンな IPFS 分散ネットワークを通じてブロックを取得するため、429 で遮断する死滅したゲートウェイを排除し、地域分散された現役オープンゲートウェイ群を多重フォールバックとして維持しなければならない (MUST)。

* **満たすべき性質 (Required Behavior)**:  
  1. **地域分散・高可用性パブリックゲートウェイ群の選定 (Gateways Pool)**:
     - **アジア太平洋（APAC）**: `https://apac.orbitor.dev/ipfs`（日本・アジア近隣最速。自宅ノードとの物理距離が近く、ミリ秒単位で DHT ブロックを吸い上げ可能）
     - **グローバル / 高速オープン**: `https://dget.top/ipfs`（高可用性オープンノード）
     - **北米（North America）**: `https://ipfs.orbitor.dev/ipfs`（Orbitor メインクラスタ）
     - **欧州（Europe）**: `https://eu.orbitor.dev/ipfs`（欧州分散ノード）
     - **中南米（LATAM）**: `https://latam.orbitor.dev/ipfs`（中南米分散ノード）
     - ※`ipfs.io`, `dweb.link`, `gateway.pinata.cloud` 等の無料非認証アクセスを 429（Too Many Requests）で遮断するゲートウェイは候補から除外すること。
  2. **Kubo Pin 済み (`kuboStatus: "pinned"`)**: DHT 経由で自宅 Kubo からブロックを取り寄せる上記現役公共ゲートウェイ群を最優先にし、Filebase ゲートウェイは自宅オフライン時の最終フォールバックに配置すること（Filebase 帯域消費をゼロ化）。
  3. **Filebase Pin 留め中 または アンピン漂流中 (`unpinned: true`)**: 最もデータ実体およびエッジキャッシュが最後まで残存している Filebase ゲートウェイ（`ipfs.filebase.io`）を最優先で問い合わせ、ダメなら公共ゲートウェイへフォールバックすること。※漂流中ファイルはエッジに 7日間キャッシュされるため Filebase 帯域への影響も極小。
  4. 自宅 Kubo の専用ゲートウェイ（`KUBO_GATEWAY_URL`）が設定されている場合は、最優先で問い合わせること。

---

### [INV-KUBO-001] 自宅 Kubo ノードの対外疎通と自律分散配信の必須要件
* **規則 (Rule)**:  
  自宅 Kubo を Cividge の自律分散ストレージとして機能させるためには、単にローカルでデーモンを起動するだけでは不十分であり、世界中の IPFS ピアから自律的にブロックを発見・取得できる通信要件を満たさなければならない (MUST)。

* **理由 (Rationale)**:  
  特定の私設直通回線（Cloudflare Tunnel 等）で特定ノードを贔屓する構成は、IPFS 本来のコンテンツ指向自律分散（Content Addressing）に反する。自宅ノードがあくまで「IPFS ネットワークに参加する対等な一ピア」として振る舞い、世界中のオープンゲートウェイから DHT 経由でブロックを引き抜いてもらうためには、外界からの着信受付と DHT への所持告知が必須となる。

* **満たすべき性質 (Required Behavior)**:  
  1. **対外到達性（Inbound Dial-in / NAT越え）の確保**:
     - ルーターのポート開放を強いることなく、UPnP（`Swarm.DisableNatPortMap: false`）、AutoNAT、または AutoRelay / Hole Punching（`Protocols: /libp2p/dcutr`）により、外部の IPFS ピアが自宅 PC へ P2P 接続（TCP/UDP/QUIC）できるポートを確保・アナウンスすること。
  2. **DHT サーバー参加モードの必須 (`Routing.Type: auto` または `dht`)**:
     - `dhtclient`（クライアント専用）モードは、他ノードからブロックを探すことしかできず、自分が持つブロックの Provider Record（所持情報）を世界地図にアナウンスしないため、自律配信目的では絶対に使用してはならない (MUST NOT)。必ず `auto` 以上に設定し、Pin 留めしたブロックを世界中の DHT へ自律告知すること。
   3. **楽観的 Provide の有効化 (`Experimental.OptimisticProvide: true`)**:
      - Pin 留めしたブロックの DHT アナウンス遅延を最小化し、世界中のゲートウェイから即座に発見可能とすること。

---

### [INV-DELIVERY-005] 単一ホスト照会と総当りKV探索の禁止（KV読み込み枠防護）
* **規則 (Rule)**:  
  ファイル配信リクエストにおいて、KV 台帳を照会する際は **特定された単一ホスト（受信ホストまたは特定されたリレーホスト）のキーのみを照会しなければならない (MUST)**。複数のホスト候補をループ走査して KV の `get()` を連続実行する「総当り探索（Brute-force lookup）」は **厳格に禁止する (MUST NOT)**。

* **理由 (Rationale)**:  
  存在しない URL（404）やランダム URL による DoS 攻撃を受けた際、ホスト候補をループ走査すると 1 リクエストで 5〜10 回もの KV `get()` が消費され、1日10万回の無料枠がわずか数時間で枯渇する。「山田太郎を探すのに鈴木太郎も佐藤太郎も全員呼び出す」ような非効率・危険な照会は設計の敗北である。

* **満たすべき性質 (Required Behavior)**:  
  1. 静的リレー（Pages 等）からバックエンド Worker への中継は、クエリパラメータではなく **フォルダ構造（`/r/<relay-identifier>/<filename>`）** を最優先で使用すること。これにより、キャッシュバスター防御（`INV-INFRA-001`）によるクエリ除去（Ignore Query String）やブラウザの Referrer-Policy による情報欠落に一切影響されず、単一ホストを一発で確定できる。
  2. 照会は「特定されたホスト:ファイル名」の 1 回のみで完結させること（404 空振り時の KV 消費は最大 1 回）。
  3. 404 レスポンスは Cache API（`caches.default`）によりエッジでキャッシュ（最低 300 秒）し、同一パスへの反復攻撃に対する KV 消費を完全ゼロ（0 回）に抑え込むこと。

---

### [INV-CORE-006] ファイル・URL 対称性の原則（完全対等なハードリンクモデル）
* **規則 (Rule)**:  
  すべての公開 URL（KV レコード）は、最初から `host:filename` という均一な一意キー構造を持たなければならず (MUST)、背後のストレージ実体（S3Key / CID）に対する完全に対等な参照ポインタ（ハードリンク）として扱わなければならない (MUST)。  
  「コピー元（親・本物）」と「エイリアス（子）」のような主従関係や、ホスト名を持たない特権キー（単体キー）を設けてはならない (MUST NOT)。

* **状態遷移とライフサイクル (State Transition & Lifecycle)**:  
  1. canonical `ObjectRef` ごとの Durable Object が Link 集合を authoritative に保持する。Link A と Link B は順序のない peer であり、B の作成は A を更新・削除しない。
  2. Link 削除は `beginRemoveLink → delivery KV projection delete → completeRemoveLink` の二段階とする。projection delete 完了前の Link は参照として数え続け、途中失敗は同一 identity で再試行できなければならない。
  3. active Link と pending removal がともに 0 の場合だけ、Object は release candidate になれる。これは物理削除の即時実行を意味しない。
  4. Placement は claim ID と generation を持つ authorize/execute/report により遷移する。stale executor、重複 report、partial failure が共有 Object を破壊してはならない。

* **理由 (Rationale)**:  
  キー名の形式（コロンの有無）で親子を区別する非対称なモデルは、元カードを先に消した際に残ったエイリアスが実体を消せなくなって孤児オブジェクト（容量浪費ゴミ）を生み出すか、または親削除時に他リンクを巻き添え破壊する致命的な欠陥を招く。Linux の inode/hardlink や IPFS の CID/名前と同様に、すべての URL を実体への対等なポインタとして扱うことが、最も堅牢で論理的な不変条件である。

---

### [INV-DELIVERY-006] ホスト・ドメイン完全独立と暗黙フォールバックの禁止
* **規則 (Rule)**:  
  すべての配信ドメインおよび静的リレーは完全に対等であり、特定のホストを暗黙のデフォルトとして優遇したり、フォールバック採用してはならない (MUST NOT)。  
  リクエストから配信ドメインが一意に特定できない場合、憶測で特定ホストのキーを探しに行かず、即座に「404 Not Found」として門前払いしなければならない。また、単体キーへのフォールバック照会も行わず、特定されたドメインのキー（`host:filename`）のみを 1 回で照会しなければならない。

---

### [INV-RELAY-NAMESPACE-STABLE] Relay namespaceの固定
* `relay.k7m.f5.si` の公開ingressは `/r/<relay-id>/<filename>` に固定する。
* `/r/` はrouting/security classificationであり、Objectやcanonical Link identityの一部ではない。
* Workerはrelay-idをpublic hostへ解決し、`<public-host>:<filename>` を1回だけKV照会する。
* `/r/` をflattenしたり、relay-idの集合をCloudflare Security Ruleへ漏らしてはならない。Zone-level Rate Limitは別のabuse-control policyである。

### [INV-RELAY-IDENTITY-CONSISTENT] 公開入口とrelay identityの一致
* pages.dev互換性テストは、選択したpublic hostとredirect後の `/r/<relay-id>/...` が同じidentityを表し、Workerの応答がそのcanonical public hostを確認した場合だけ合格とする。
* relay-idはcanonical hostそのもの、またはallowlist内で一意なfirst-labelだけを認める。他の登録済みrelay経由で得た200/webpは選択hostの合格ではない。

### [INV-NO-RESURRECTION-AFTER-DELETE] Link削除後の再昇格禁止
* authoritative delete後、古いKV projection、storage observation、localStorage、削除前に開始した非同期取得で同じLink世代をactive UIへ戻してはならない。
* LinkBindingはRETIREDと単調増加するLink generationを保持し、明示Refreshの結果にはBOUNDかつKV projectionのgenerationが一致するLinkだけを採用する。公開GETの単一KV照会にはDOを追加しない。
* 同一ブラウザで前回観測したLink行は、reload時にlocalStorageからcached presentationとして表示してよい。これは現在のBOUND判定ではない。削除成功時はメモリと保存済みsnapshotの両方から除去する。

### [INV-MANAGED-VIEW-PERSISTS-LOCALLY] 管理一覧の表示継続
* 同一originの同一ブラウザでは、前回表示した管理一覧をlocalStorageの最終観測projectionから復元し、reload後も表示を継続する。cached / freshはmanaged UI projectionの鮮度であり、`HistoryLink`や`CachedLink`という別のLink domain stateではない。
* 復元した行の表示（Displayed）はObject / Link / Placementの現在の存在証明（Authoritatively Exists）ではない。一方、正本でないことは非表示にする理由ではない（Not authoritative != Do not display）。明示Refreshの成功またはこのブラウザでacknowledgeされたmutationまで、cached viewを表示してよい。

### [INV-PREVIEW-CACHE-IS-PRESENTATION-ONLY] プレビューキャッシュは表示専用
* ブラウザ内の動画サムネイルは表示を速めるための再生成可能なcacheであり、Link、Placement、Object lifecycleの存在証明や削除許可に使用しない。取得・保存・削除に失敗しても管理一覧と親動画の状態は変えない。

### [INV-PREVIEW-CACHE-FOLLOWS-OBJECT-IDENTITY] 親ObjectIdに従うプレビュー
* 動画サムネイルのcache keyは親ObjectIdとする。同名でもObjectIdが異なる動画に古いpreviewを再利用しない。filenameやLink keyをpreviewのidentityにしない。

### [INV-CACHED-PREVIEW-MAY-SURVIVE-RELOAD] 再読み込み後の表示継続
* 一度生成または正常取得した動画previewは、同一ブラウザでreload後も表示してよい。managed一覧のRefreshとpreview cache参照・不足時の個別取得は別操作とする。

### [INV-CACHED-VIDEO-PREVIEW-RESTORES-ON-STARTUP] 起動時の動画preview復元
* 復元したmanaged動画行に親ObjectIdがあり、そのObjectIdのpreviewが同一originのCache Storageに存在する場合、初期描画で利用する。managed一覧のRefreshを必要としない。
* preview cacheはService Workerの静的asset cache更新時にも保持する。cache miss時は既知の公開Linkの `?preview=1` だけを個別取得でき、失敗しても行は残す。cache hitはObject/Link/Placementの存在証明ではない。

### [INV-PREVIEW-INDEPENDENT-OF-MANAGED-REFRESH] プレビュー復元と一覧更新の分離
* 管理一覧の行を復元した後、画像は元Objectの公開URLをpreviewとして表示し、動画は親ObjectIdのderived preview cacheを参照する。いずれも一覧全体のRefreshを必要とせず、不足しているpreviewだけを個別取得できる。

### [INV-PREVIEW-FAILURE-DOES-NOT-ERASE-MANAGED-ROW] プレビュー失敗は行を消さない
* 画像・動画previewの取得や表示に失敗した場合はpreviewだけをplaceholderに戻す。managed row、Link、Placement、Object lifecycleを削除・無効化しない。

### [INV-MANAGED-VIEW-FAILURE-DOES-NOT-ERASE] 観測失敗は空集合ではない
* 更新・観測の失敗を「管理対象が0件」と解釈してはならない。既に表示可能なcached / current viewがある場合は保持し、失敗をUIへ示す。
* 明示Refreshが成功して0件を返した場合だけ、空一覧を新しい観測として採用し、保存済みprojectionも空へ更新する。

### [INV-MANAGED-CACHE-PRESERVES-ACKNOWLEDGED-MUTATIONS] 保存済み表示の単調性
* ローカル一覧は未観測の外部変更について古くてもよい。ただしこのブラウザで成功確認済みの削除・TTL変更等はmanaged snapshotと保存済みprojectionの両方へ反映し、reload時に旧値へ戻してはならない。
* mutationより前に開始した取得結果や古いcacheは、そのacknowledged resultを巻き戻せない。表示の継続とlifecycleの許可判定を混同せず、localStorageをauthorityにしない。

### [INV-DELETE-VISIBILITY-MONOTONIC] 削除表示の単調性
* 削除成功後のUIはVISIBLE→ABSENTの一方向とする。明示的な再upload/rebindで新generationを作る場合だけ、同じcanonical keyを再表示できる。

### [INV-RETRYABLE-RELEASE-CONVERGES] 再upload時の解放状態の収束
* `RELEASE_PENDING` / `RETRYABLE` は同一ObjectRefを永久に使用不能にしない。明示的な再uploadでは、PUT前に同一locatorをread-onlyで調べ、物理保持が確認できれば`PRESENT`、不在なら`RELEASED`へ収束させる。
* 進行中のrelease claimや異なるlocator・異なるCIDを推測で上書きしない。過去のrelease失敗を消去して直したことにはしない。

### [INV-CANONICAL-404-SELF-CONTAINED] 人が開く404
* navigation向けcanonical 404 HTMLは画像をdata URIで内包し、一つのHTTP responseだけで描画できる。別request、relay、KV、storage、古いedge cacheへの依存を持たない。

### [INV-READ-YOUR-WRITES] 設定変更後の表示
* LinkのTTL変更をacknowledgeした後、管理UIは古いKV観測を現在値へ再採用しない。LinkBindingの同一generationに属する単調なpolicy revisionを管理一覧に反映する。

### [INV-PLACEMENT-LIVENESS] Placement claimの生存性
* `PIN_REQUESTED != PINNING != PRESENT`。Pin要求と物理保持確認を混同しない。
* `PINNING` / `RELEASING` claimはDurable Objectが永続化したleaseを持ち、browser reload、executor消失、network failureの後も有限時間で再claim可能に戻る。
* claim IDとgenerationが一致するreportだけがPlacementを進める。lease expiry後のstale reportは状態を変えない。

### [INV-FILEBASE-RPC-RELEASE-AUTHORITY] Filebase RPC releaseの決定権
* Filebase RPC Placementの物理 `pin/rm` は、ObjectLifecycleがreleaseを許可し、Workerがgeneration-bound release claimを取得した後だけ実行できる。Workerが独自に不要性を推測してunpinしてはならない。
* `pin/rm` 失敗または応答喪失時はretryableに保ち、成功を確認するまでObjectを復活・RELEASED確定してはならない。

### [INV-FILEBASE-RPC-ACTUATOR-SCOPE] Filebase RPC actuatorの所有境界
* `FILEBASE_DEDICATED_BUCKET=true` は、対象bucketをCividge Worker RPC専用のPlacement namespaceとして運用する明示的な宣言である。defaultはfalse。外部ツール、他アプリケーション、browser S3 uploadのpinを同じbucketに混在させてはならない。
* Workerはdurableな `cividge_worker_rpc` provenanceを持つ `filebase_rpc` Placementだけをactuateできる。browser/S3の `filebase` Placementや外部所有pinをRPC cleanupへ暗黙に昇格させてはならない。browser側S3 credentialをWorkerへ移さない。
* KV/localStorage/UIはauthority状態をprojectionし、`PIN_REQUESTED` / `PINNING` を単なる「未保持」へ潰さない。

### [INV-OBJECT-IMMUTABLE] Object bytesの不変性
* Object creation完了後にbyte sequenceを変更しない。embedded metadataもObject bytesの一部である。
* conversion、metadata除去/保存、EXIF処理、MP4 FastStartはObject creation前に完了させる。異なるbytesはnew Objectとする。
* conflict判定より前に既存physical locatorへ異なるbytesをPUTしてはならない。localStorageの事前checkを安全性の根拠にしない。

### [INV-VERIFY-HUMAN-FIRST] Human-first verification
* syntax/build/起動可能性の後、通常操作のHuman Exploratory Checkpointを必ず通過させる。
* 通常ユーザーが容易に発見できる不具合が残る間は、高コストなdeep E2E/failure injectionへ進まない。
* Human testは操作の連続性と期待を検査し、machine testはrace、stale generation、retry、idempotencyなど人間に観測困難な状態空間を検査する。

### [INV-FEATURE-STATE-HAS-OWNER] Feature stateの所有者
* 可変なapplication stateには、意味上のfeature ownerを一つ定める。無関係なmoduleが同じcanonical stateを独立に変更してはならない。
* 管理一覧のcanonical snapshotと非同期観測generationは、一つのmanaged ownerを経由して更新する。R2用、Filebase用、View用に別の正本を増やさない。

### [INV-VIEW-DOES-NOT-OWN-DOMAIN-STATE] Viewとdomain stateの境界
* UIは状態を表示し、利用者のintentを収集するprojectionである。描画処理そのものをmanaged/upload stateのauthorityにしてはならない。
* 表示上の区別や操作段階を追加しても、保存・実行時にはcanonical domain stateへ正規化する。

### [INV-VIEW-IS-NETWORK-FREE] 管理Viewの描画とI/Oの分離
* 管理カードの描画はmanaged snapshotからDOMを作るだけで、storage、Worker、providerへの観測を開始しない。
* 画像読み込み失敗後のS3フォールバックは描画ではなく、独立したpresentation eventから実行する。

### [INV-RENDER-DOES-NOT-OBSERVE] 観測の採用境界
* 描画は採用済み観測を利用するが、authoritativeな観測を生成しない。FilebaseのCIDがprojection/cacheにない場合の物理照会は明示的なrefresh generationに属し、staleな結果をmanaged snapshotへ採用しない。
