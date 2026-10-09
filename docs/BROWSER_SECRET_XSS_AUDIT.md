# Browser Secret & XSS Boundary Audit

監査日: 2026-10-09。対象: frontendの追跡済みsource、Pages Functions、関連Workerの公開API/認証cookie経路（読み取り）。実際のbrowser profile、provider console、secretファイルの値は取得していない。既存のドキュメント変更は維持した。これは全依存ライブラリの安全性を保証するものではない。

## 実装変更前の所見

1. R2/Filebase S3 credentialとAdmin tokenはlocalStorageへ保存・reload復元される。これは正式UXとして維持する。
2. Kubo Version/errorを未escapeで `innerHTML` へ渡す入口を確認。Civitai応答の `item.id` がHTML属性へ未escapeで挿入され、URL schemeも未検証。upload preview URLのHTML属性も未escape。
3. QRの `#sync=z.` はcredentialを含むJSONの圧縮で、暗号化ではない。`#enc=` は6桁PINを反復XORしているだけで、秘密保護にならない。`#sync` / `#cfg` は確認なしに設定とcredentialをimportする。
4. CSPのsource内定義はない。scriptはローカル `app.js` のみ。qrcode/fflate/AWS SDK/JSQuashはnpmから自前bundleに入る。CDN runtime scriptはない。
5. upload tokenの同じ値が `uploadApiToken:<origin>` と `uploadTokenVerifiedState.token` に重複保存される。生の例外objectをconsoleへ渡す経路が多い。
6. Filebaseの公式access-key説明ではS3 keyはaccount内の全bucketへ届き、per-key scopeがない。bucket名をUIで限定しても盗まれたkeyの権限は縮まらない。R2はspecific-bucket Object Read & Writeの利用を推奨するが、入力済みkeyの実scopeはsourceから検証できない。

## Browser persistence inventory

localStorageは同一origin/profileでreload・再起動後も残る（ユーザーによる削除・browser evictionは除く）。下表の非secret projectionはlifecycle authorityではない。credentialはprovider/Workerが受理するcapabilityであり、localStorage自体がdomain authorityではない。

| key/name | 内容 / secret / 漏えい時の能力 | 読み書きmodule |
| --- | --- | --- |
| `r2AccessKeyId`, `r2SecretAccessKey` | S3署名key pair。後者はsecret。scope内のread/write/list/deleteが可能 | `app.js` save/load/import/export、`storage/connections.js` |
| `r2AccountId`, `r2BucketName` | account/bucket identifier。非secret。単体の認証権限なし | 同上 |
| `filebaseApiKey`, `filebaseSecretKey` | Filebase S3 key pair。後者はsecret。実権限はaccount内全bucketへ届き得る | 同上 |
| `filebaseBucket` | bucket identifier。非secret。credentialの権限を制限するものではない | 同上 |
| `adminApiToken` | secret。選択WorkerのLink/Object/Placement/Gateway管理API capability | `app.js`、`api/worker-client.js` |
| `uploadApiToken:<Worker origin>` | secret。選択Workerのupload-only capability | `app.js` 外部upload UI。curl/BAT/sxcuへの出力は明示操作 |
| `uploadTokenVerifiedState` | 実装前はtoken/endpoint/verifiedを複製。実装後はtoken digest/endpoint/verifiedだけ | `app.js` upload検証 |
| `kuboRpcUrl` | RPC endpoint。専用token fieldやAuthorization実装なし。認証を含むURLは拒否すべき | `app.js`、`kubo-client.js` |
| `kuboAutoPin`, `kuboAutoPinR2`, `kuboPrioritizePinned` | Kubo操作のユーザーpolicy。非secret、単体でRPC権限なし | `app.js`、capacity execution |
| `kvWorkerUrl` | Worker endpoint。非secret。credential付きURL・query/hashは禁止 | `app.js`、Worker client |
| `r2DomainList`, `r2SelectedDomain`, `r2PublicDomain`, `r2DevDomain`, `filebaseDomainList`, `filebaseSelectedDomain`, `fileDomainMap` | 配信URL設定/projection。非secret。安全なURLとして表示する必要あり | `app.js` |
| `filebaseCompatibilityUrl`, `filebaseCompatibilityEnabled` | 旧keyのremoveのみ。現行save/restoreなし | `app.js` reset |
| `cividge_domain_compat_flags_v2` | 接続テストのUI観測。非secret、allowlist authorityではない | `app.js` |
| `storageProvider`, `activeStorageTab`, `storagePerPage` | upload先/一覧view/page設定。非secret | `app.js`、managed controller |
| `r2StorageLimitGB`, `r2StorageLimit`, `filebaseStorageLimitGB`, `filebaseStorageLimit`, `storageLimit`, `r2AutoFifo`, `autoFifo` | UI容量/FIFO policy。非secret。release許可はDOで決める | `app.js`、`storage/capacity-execution.js` |
| `formatSelect`, `qualityRange`, `renamePattern`, `enableZip` | canonical conversion/filename設定と品質/ZIP。非secret | `app.js` save/load/import/export |
| `appLang` | UI言語。非secret | `app.js` |
| `civitaiUserList`, `civitaiUsername`, `civitaiLastSeenMap`, `civitaiWfMap` | public creator/watch/WF観測。非credential、個人利用履歴 | `app.js` |
| `civitaiShowNewOnly` | 旧keyのread/removeのみ | `app.js` |
| `composerTemplates`, `comfyWfMap` | ユーザー文面/workflow。認証権限なし。ただしユーザーが内容へ秘密を記入する可能性あり | `app.js`、`upload/workflow-cache.js` |
| `ipfsCidMap`, `r2HashMap` | filename/locatorとCIDの対応。非secret、公開配信の補助観測 | `app.js`、`storage/r2-content.js`、filebase content |
| `civitaiTemporaryTransfers`, `cividge_drift_fail_counts` | transfer期限/取得失敗観測。非secret | `app.js` |
| `cividge_managed_projection_v5_r2`, `cividge_managed_projection_v5_filebase` | managed rowの最終観測。passwordは保護flagのみ。bytes/credential/plaintext passwordは保存しない | `managed/managed-cache.js`、controller |
| `cividge_retired_local_entries_v1_r2`, `cividge_retired_local_entries_v1_filebase` | local-only行のretirement projection。非secret | `managed/managed-cache.js` |

| 保存/出力先 | 内容・永続性・capability |
| --- | --- |
| sessionStorage `onboardingKvConnected`, `onboardingKvSuccessMessage` | 接続成功UIだけ。tab session内、secretなし。`app.js` |
| IndexedDB | アプリ自身の使用なし |
| Cache Storage `cividge-video-previews-v1` | parent ObjectId別WebP preview。表示のみ、secret/authorityなし。`media/video-preview-cache.js` |
| Cache Storage `file-publisher-v2` | 旧Service Worker static cache名。現行appに新規registrationなし。既存登録が残るprofileでは使用され得る。`public/sw.js` |
| cookies `auth_<encoded filename>` | frontendにcookie read/writeなし。delivery Workerはpassword成功時のsession tokenを配信originのHttpOnly/Secure/SameSite=Lax cookie（最大1時間）へ発行。cloud credentialではなくそのLinkの閲覧capability |
| URL/query/hash | 通常公開URLにはfilename/domain等。実装前の移行hashはcredentialを含む。実装後は認証付き暗号文だけを明示生成、復元キーはURLへ入れない。hashは初期読取時にreplaceStateで除去 |
| clipboard | 明示したURL/本文/promptコピー、curlコピー、移行URLコピー。実装前はbackup生成時に自動コピー。実装後は移行URLの明示コピーだけ。curlはupload tokenを含む意図したclient export |
| DOM/in-memory | credential inputの `.value` とS3 client、upload password、export payload。フォーム復元のため必要。password badge/titleへの余分なplaintext複製は撤去。UI/preview cacheはauthorityにならない |
| backup/export | 設定QR/backupにはprovider credentialが必要。認証付き暗号化、復元キーを別表示。BAT/sxcuにはupload-only tokenを明示export。鍵とexport両方を共有すれば認証能力も移る |
| console/error | 実装前はraw Error/response bodyが出る経路あり。実装後はlocal secretをredactし、Errorはname/messageだけへ投影する |
| Git/build/ZIP | secret値を含む追跡済み設定ファイルは今回のfilename調査ではなし。実secret値を読んだ照合は行わない。`.env*`/`.dev.vars*`/`.aws`はignoreし、Vite env公開利用を追加しない。自動設定入りdeployment ZIP生成機構はない。`dist`だけをPagesへdeployする |

## Credential blast radius / 運用要件

- **R2:** specific Cividge bucketに限定したObject Read & Writeを使い、account-wide Admin権限をbrowserへ渡さない。sourceは署名用key pairしか必要としない。credentialの実scope/revokeはCloudflare consoleで確認・変更する。
- **Filebase S3:** sourceからbucket制限を強制できない。Cividge専用Filebase accountで無関係なbucketを分離する。これはcredential方式変更ではなく、既存keyのownership境界。rotateはFilebase consoleで行う。
- **Admin/upload token:** Cividge Worker単位のcapability。test tokenも同じWorkerなら同じresourceへuploadできる。account管理APIのCloudflare tokenはbrowser UIにない。
- **Kubo:** token fieldなし。API到達性自体が管理能力になる。localhost/Tailnet等で到達範囲を制限する。CORSは悪意ある同origin scriptに対する秘密境界ではない。
- **Cloudflare purge/deploy token / Filebase RPC key:** browser設定には存在しない。Worker secrets・Wrangler認証は別境界で、browser backupに含めない。
- providerがcredentialをrevokeすればlocalStorageに同じ値が残っても認証できなくなる。アプリのbucket選択やlocal credential persistenceはprovider側scopeを拡張も縮小もしない。

公式資料: [R2 token scope](https://developers.cloudflare.com/r2/api/tokens/)、[Filebase access keys](https://filebase.com/docs/concepts/access-keys)、[CSP WASM directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)。

## 実装後の結果・確認

* Kubo Version/errorはsafe DOMのtextContentへ移し、Civitai ID/metadata Size/upload preview属性はescapeした。Civitai URLの非HTTP(S)/userinfoを拒否し、statsは数値へ正規化した。既存のfilename/metadata textのescapeは維持した。残るinnerHTMLは固定文面・信頼された翻訳またはescape済みtemplateで、document.writeは外部入力を含まない固定preload画面。eval/new Function/outerHTML/srcdoc/動的on属性はアプリsourceで見つからない。既存の固定onclickはイベント登録へ移した。
* 初期接続フォームのcredential復元は `.value` propertyへ移し、innerHTMLの `value` 属性文字列へsecretを埋め込まない。入力中の未保存credentialもredaction対象とし、破損した検証cacheがあっても他のsecret収集を止めない。
* Worker/Kubo endpointにcredential付きURL・query/hashを許可しない。R2 account IDは32桁hexを検証し、署名先hostの文字列注入を防ぐ。新規importは型/endpointを検証し、別Workerへのimport時に旧admin tokenを暗黙で引き継がない。
* QRとbackupはAES-GCM、ランダム128bitの別表示復元キー、ランダムIVを使用する。平文圧縮URL・6桁XOR形式は生成/復元せず、旧形式へのfallbackを撤去した。localStorageの既存provider credentialは削除しない。旧exportは新形式で再発行する。自動clipboard出力を撤去した。curl/BAT/sxcuの明示exportは維持し、shell literalをquoteする。
* 生のErrorをconsoleへ渡す経路はredacted loggerへ切り替えた。name/messageだけを投影し、既知local secret、Authorization、credential/password/token fieldをredactする。Workerのerror echoもredactする。retry用attemptはErrorの非enumerable属性とし、JSONに丸ごと現れない。upload検証cacheはtokenのSHA-256 digestだけを保存する。
* `index.html` のmeta CSPと `public/_headers` を追加した。script-srcはselfとwasm-unsafe-evalだけ（JS unsafe-inline/unsafe-evalなし）。object-src/base-uriはnone。JSQuashのWASM変換にWASM許可が必要。大量の既存inline styleのためstyle-srcにはunsafe-inlineを残す。user-configured provider/Worker/Kuboとpublic mediaを扱うためconnect/img/mediaのHTTP(S)は広く許可し、credentialを読み得る外部scriptは許可しない。_headersにはframe-ancestors none、no-referrer、nosniffも設定した。Pages FunctionsのAPIへこのstatic header設定が適用されるとは仮定しない。
* `.env.*` / `.aws`をGit ignoreへ追加し、public/distへenv/dev.vars/credential設定が入るとbuildを失敗させるguardを追加した。これは任意ファイルに偽装された秘密やdependency改ざんを検出するDLPではない。
* frontend自動テスト **91件成功**（既存81件 + security 10件）。actual managed rendererへmalicious filename/metadataを渡すVM characterization、Kubo safe DOM、URL scheme、token echo/console、provider client再構築、暗号化roundtrip/wrong-key/tamper、public artifact拒否、CSP markupを確認した。通常R2/Filebase uploadは既存orchestratorテストで確認した。実browser/実providerを使うupload・CSP下の変換・端末間復元は手動checkpointで確認する。
* production build成功。公開はしていない。MANUAL EXPLORATORY CHECKPOINT: localhost previewで設定保存→reload、WebP/JXL/JPEG変換、R2/Filebase upload、preview、暗号化QR/backupの発行→別browserで復元キー入力を確認する。CSPでblockされる機能があれば公開前に修正する。
* ローカル確認URLは `http://127.0.0.1:4173/`。本番とは別originなので本番profileのlocalStorageは読み込まない。保存/reload/QRはdummy設定で確認できる。実uploadを確認する場合は明示Worker URLとそのorigin用のprovider CORSを設定する（Vite previewはPages Functionsを実行しない）。

## 残る境界

localStorageは長期・portable設定の正式な保存先。完全侵害profile、強い権限の拡張機能、OS侵害、bundle自体の改ざん、npm supply-chain侵害には抵抗する秘密境界ではない。CSPはlocalStorageをvaultにしない。URL暗号文が履歴やclipboardへ残ること、明示client exportが認証能力を移すことも運用で扱う。current browserの実provider scopeとCloudflare側の実CSP responseは、未デプロイのsource auditだけでは確定できない。
