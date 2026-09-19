import QRCode from "qrcode";
import * as fflate from "fflate";
import encodeJxl, { init as initJxl } from "@jsquash/jxl/encode.js";
import jxlWasmUrl from "@jsquash/jxl/codec/enc/jxl_enc.wasm?url";
import { importer as importUnixFs } from "ipfs-unixfs-importer";
import { BlackHoleBlockstore } from "blockstore-core";
import {
  extensions,
  getContentTypeFromFilename,
  getImageDimensions,
  getVideoThumbnailKey,
  isGeneratedVideoThumbnailKey,
  isVideoThumbnailParentKey,
} from "./media-utils.js";
import { createKuboClient } from "./kubo-client.js";

let jxlInitialized = false;
async function ensureJxl() {
  if (!jxlInitialized) {
    try {
      const res = await fetch(jxlWasmUrl);
      if (!res.ok) throw new Error(`WASM fetch failed: HTTP ${res.status}`);
      const wasmBytes = await res.arrayBuffer();
      const wasmModule = await WebAssembly.compile(wasmBytes);
      await initJxl(wasmModule);
      jxlInitialized = true;
    } catch (e) {
      console.error("Failed to init JXL encoder:", e);
      throw e;
    }
  }
}
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

// --- 多言語 (i18n) 辞書 ---
const i18nDict = {
  ja: {
    siteTitle: "Cividge",
    eyebrow: "ブラウザで変換し、自分のストレージへ直接保存・配信",
    whatIsSiteSummary: "❓ どのようなサイト？",
    whatIsSiteBody: `<strong>Civitai Bridge（Cividge）</strong>は、ブラウザ内でメディアを変換し、自分の Cloudflare R2 または Filebase（IPFS）へ保存・配信する個人用アップローダです。<br><span style="display: inline-block; margin-top: 6px; font-size: 12px; color: #a5b4fc;">必要に応じて KV Worker により別名 URL・期限・閲覧パスワードを管理でき、Kubo ノードは IPFS コンテンツの保全先として利用できます。接続情報はこのブラウザの localStorage に保存されます。</span>
<details style="margin-top: 10px; background: rgba(15, 23, 42, 0.5); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; padding: 6px 10px;">
  <summary style="cursor: pointer; font-weight: 600; color: #38bdf8; font-size: 12px;">💡 ストレージの選択基準・運用のコツ（R2 vs Filebase vs Kubo）</summary>
  <div style="margin-top: 6px; font-size: 11.5px; line-height: 1.55; color: #cbd5e1;">
    <ul style="margin: 0; padding-left: 18px;">
      <li><strong>Cloudflare R2</strong>: ダウンロード転送量（Egress）が<strong>完全無料・無制限</strong>。大量閲覧（バズ）や重い動画（〜128MB）に最適。※クレカ必須、10GBを超えると自動従量課金（上限キャップ不可）のため不要ファイルは定期削除推奨。</li>
      <li><strong>Filebase（IPFS）</strong>: クレカ不要で安全。画像（1〜2MB）を長期間安定配信するのに最適。※無料枠は容量5GB・転送月10GB（実質5GB目安）のため、重い動画やバズるファイルはR2かKubo併用を推奨。</li>
      <li><strong>自宅 Kubo 連携</strong>: 20MB超の動画や人気ファイルは共有前にKuboへピン留め（Pin）すると、Filebase帯域消費が<strong>ゼロ</strong>になります（※初回のみ自宅の上り回線に少し注意）。</li>
    </ul>
  </div>
</details>`,
    inputFiles: "入力ファイル",
    addFolder: "フォルダを追加",
    dropText: "ファイルやフォルダをここにドロップ",
    orClick: "またはクリックしてファイルを選択",
    dropLimitHint: "※ 1ファイルにつき 128MB 未満",
    settings: "設定",
    enableConvertLabel: "画像を変換する",
    enableRenameLabel: "ファイル名をリネームする",
    outputFormat: "出力形式",
    quality: "品質",
    renameRule: "リネーム規則",
    originalName: "元ファイル名",
    seq01: "連番 (01)",
    seq001: "連番 (001)",
    random6: "ランダム (6文字)",
    previewLabel: "プレビュー:",
    zipOptionLabel: "🗜️ ZIP形式でまとめて保存する",
    btnDownload: "📥 ダウンロード",
    btnUpload: "🟩 アップロード",
    btnConvertUpload: "🟩 アップロード",
    btnUploadR2: "⚡ R2へ保存",
    btnUploadFilebase: "🪐 Filebaseへ保存",
    r2BillingWarningBadge: "⚠️ 10GB課金注意",
    r2BillingWarningTooltip: "⚠️ R2は保存容量がアカウント内総量で10GBを超えると自動従量課金が始まります（上限キャップ機能なし）。Cividge以外の用途も含めた総量で判定されるため、課金条件を自身でも必ずご確認ください。",
    cfTitle: "☁️ クラウドストレージ接続設定",
    kvAccordionTitle: "📚 KV 配信・管理 Worker",
    kvAccordionDesc: "R2 / Filebase 共通の短縮 URL、別名リンク、有効期限、パスワード保護を管理する台帳です。",
    r2AccordionDesc: "R2 の接続情報、R2 専用の配信ドメイン、CORS と容量解放を設定します。",
    filebaseAccordionDesc: "Filebase の CID・IPFS 保存、Filebase 専用配信ドメイン、任意の Kubo 保全ノードを設定します。",
    quickR2DomainLabel: "🌐 R2 配信ドメイン",
    quickFilebaseDomainLabel: "🌐 Filebase 配信ドメイン",
    r2DomainPlaceholder: "-- R2 ドメインを選択 --",
    filebaseDomainPlaceholder: "-- Filebase ドメインを選択 --",
    r2DeliveryTitle: "1️⃣ R2 の公開・配信 URL を設定",
    filebaseDeliveryTitle: "2️⃣ Filebase の公開・配信 URL を設定",
    r2CompatibilitySummary: "🛡️ pages.dev 公開互換レイヤー（ランダムクエリ防御）",
    r2CompatibilityConfigured: "公開入口: ",
    r2CompatibilityMissing: "⚠ 上の R2 配信ドメインから、静的リレープロジェクトの pages.dev URL を選択してください。",
    r2CompatibilityInstallSummary: "静的リレープロジェクトを設置する",
    r2CompatibilityInstallBody: "同梱テンプレートを<strong>公開用の静的 Pages プロジェクト</strong>としてデプロイします。各パスを既存の R2 配信ドメインへ転送します。作成された pages.dev URL を上の R2 配信ドメインに追加して選択してください。投稿ごとのスイッチはありません。",
    filebaseCompatibilitySummary: "🛡️ pages.dev 公開互換レイヤー（ランダムクエリ防御）",
    filebaseCompatibilityConfigured: "公開入口: ",
    filebaseCompatibilityMissing: "⚠ 上の Filebase 配信ドメインから、静的リレープロジェクトの pages.dev URL を選択してください。",
    filebaseCompatibilityInstallSummary: "静的リレープロジェクトを設置する",
    filebaseCompatibilityInstallBody: "同梱テンプレートを<strong>公開用の静的 Pages プロジェクト</strong>としてデプロイします。Function・KV・ストレージ認証情報は含みません。各パスを互換 Worker へ転送します。作成された pages.dev URL を上の Filebase 配信ドメインに追加して選択してください。投稿ごとのスイッチはありません。",
    filebaseCompatibilityCloudflareSummary: "Cloudflare の推奨設定（安定運用）",
    filebaseCompatibilityCloudflareBody: "互換 Worker を独自ドメインに置く場合のみ設定します。<ol style=\"margin:6px 0 0;padding-left:18px;\"><li><strong>ルール → URL 書き換えルール</strong>: 互換 Worker のホストに一致させ、パスは保持・クエリは空の静的値へ書き換えます。</li><li><strong>セキュリティ → レート制限ルール</strong>: パスが <code>/r/</code> で始まる要求を、1 IP あたり <strong>30件 / 10秒</strong>、アクション <strong>Block</strong>、緩和時間 <strong>10秒</strong> にします。</li><li>必要なら <strong>カスタムルール</strong>で、互換 Worker は <code>/r/</code> と <code>/api/</code> 以外を Block にします。</li></ol>",
    requiredText: "* 必須",
    deliveryDomainHintR2: "※ R2 用の Worker URL、pages.dev URL、独自ドメイン、R2 dev URL を何件でも追加・削除できます。選択された URL が画像コピーやパレットの配信ベース URL に使用されます。",
    deliveryDomainHintFilebase: "※ Filebase / IPFS 用の Worker URL、pages.dev URL、独自ドメインを何件でも追加・削除できます。選択された URL が Filebase への新規投稿の配信ベース URL に使用されます。",
    deliveryGuideSummary: "配信 URL の作り方・変更方法",
    r2DeliveryGuide: "最初は KV Worker の <code>https://…workers.dev</code> をそのまま使えます。独自の URL が必要な場合だけ、Pages をデプロイするか Worker に独自ドメインを追加します。<ol><li><code>npx wrangler login</code></li><li>リポジトリのルートで <code>npm run build</code></li><li><code>npx wrangler pages deploy dist --project-name=my-r2-delivery</code></li><li>表示された <code>https://my-r2-delivery.pages.dev</code> を「＋」から追加します。</li></ol>",
    filebaseDeliveryGuide: "Filebase 用には R2 と<strong>異なる</strong>配信ドメインを使います。新しい Pages プロジェクトを作成し、この Cividge の配信コードをデプロイしてください。<ol><li><code>npx wrangler login</code></li><li>リポジトリのルートで <code>npm run build</code></li><li><code>npx wrangler pages deploy dist --project-name=my-filebase-delivery</code></li><li>表示された <code>https://my-filebase-delivery.pages.dev</code> を「＋」から追加します。</li></ol>",
    kvWorkerTitle: "📚 KV 台帳連携 (短縮URL・パスワード・BYOC)",
    kvWorkerRepo: "cividge-kv-worker リポジトリ ↗",
    r2CorsSummary: "R2 バケットの CORS 設定（ブラウザから接続するため必須）",
    r2CorsHelp: "R2 → 対象バケット → Settings → CORS Policy → Edit に、フロントエンド URL を許可するポリシーを貼り付けます。配信ドメインではなく、このアプリを開く URL を指定します。",
    r2CorsCopy: "📋 CORS 設定をコピー",
    filebaseBucketLabel: "Filebase バケット名 (IPFS Bucket)",
    filebaseAccessKeyLabel: "Filebase Key (Access Key)",
    filebaseSecretKeyLabel: "Filebase Secret Key",
    filebaseCorsAuto: "⚙️ CORS自動設定",
    kuboTitle: "🏠 自宅 Kubo (IPFS長期保存 Provider)",
    kuboAccordionTitle: "🏠 自宅 Kubo (IPFSノード永続保存)",
    kuboAccordionDesc: "自宅 PC / サーバーの Kubo ノードと連携し、R2 や Filebase の容量解放時にファイルを自動保全します。",
    filebaseAccordionTitle: "🪐 Filebase (IPFS)",
    kuboTest: "🔌 接続テスト",
    kuboRpcLabel: "Kubo RPC エンドポイント URL",
    kuboUnknown: "⚪ 未確認",
    kuboEndpointHelp: "※ 自宅PCでは http://127.0.0.1:5001、外部/HTTPS時は Tailscale 等のエンドポイントを指定",
    kuboAutoPinR2: "Cloudflare R2容量解放時にKuboへ自動Pin留め",
    kuboAutoPin: "Filebase容量解放時にKuboへ自動Pin留め",
    kuboPrioritizePinnedLabel: "Kubo保管済みのファイルを優先して容量解放",
    kuboGuideSummary: "推奨運用・外出先から接続する場合（任意）",
    kvApiEndpointLabel: "KV 台帳 API エンドポイント URL",
    kvApiEndpointHelp: "※ 各自の Cloudflare Worker を指定可能。未入力時は自サイトの /api/cividge-kv を試行します。",
    kvApiTokenLabel: "KV API トークン (API Token)",
    kvApiTokenHelp: "※ トークン未設定時は中央KVを汚さず、安全な IPFS CID 直リン（/i/CID/name）として動作します。",
    r2AccountLabel: "Account ID",
    r2AccountSub: "Cloudflare アカウント ID（S3 API URLを貼り付けても自動抽出されます）",
    r2BucketLabel: "R2 バケット名",
    r2BucketSub: "対象の Cloudflare R2 バケット名",
    r2AccessKeyLabel: "Access Key ID",
    r2AccessKeySub: "R2 API トークンの Access Key ID",
    r2SecretKeyLabel: "Secret Access Key",
    r2SecretKeySub: "R2 API トークンの Secret Access Key",
    r2DomainLabel: "直リンク公開ドメイン URL",
    r2DomainSub: "カスタムドメイン（コピーボタンで使用）",
    r2DevDomainLabel: "R2 Dev アドレス (dev URL)",
    r2DevDomainSub: "R2 パブリック dev アドレス（devコピーで使用）",
    btnSave: "保存する",
    btnShareQr: "📱 スマホ共有 (QR)",
    btnPinBackup: "🔗 PINバックアップ",
    btnClear: "クリア",
    topbarSyncBtn: "スマホ共有 / バックアップ",
    dataSyncHeading: "📦 設定の引き継ぎ & スマホ共有",
    dataSyncDesc: "Civitai ウォッチリスト、Cloudflare R2 接続情報、画像変換設定を別の端末やスマホへ安全に引き継ぎます。",
    btnClearAllData: "🗑️ 全クリア",
    retentionPeriod: "⏳ 有効期間 (時限)",
    ttl1h: "1時間 (1時間後消滅)",
    ttl12h: "12時間 (12時間後消滅)",
    ttl1d: "1日間 (24時間後消滅)",
    ttl3d: "3日間 (72時間後消滅)",
    ttl7d: "7日間 (168時間後消滅)",
    tempPasswordLabel: "🔑 閲覧パスワード",
    tempPasswordPlaceholder: "合言葉を設定",
    passwordIpfsNoticeSummary: "IPFS のパスワード保護について",
    passwordIpfsNotice: "※ パスワードは Cividge の配信 URL を保護します。IPFS の CID を知る人は、IPFS Gateway 経由で直接取得できる場合があります。秘匿が必要なファイルは投稿しないでください。",
    optionalText: "(任意)",
    quickUploadHeading: "🚀 外部投稿 / Windows「送る」連携",
    uploadReturnDomainLabel: "🌐 返却配信用アドレス (用途別に選択):",
    uploadApiUrl: "投稿API エンドポイント URL",
    btnCopyUrl: "📋 URLをコピー",
    btnCopyCurl: "💻 curl例をコピー",
    btnDownloadSendTo: "📥 Windows「送る」登録バッチ",
    btnDownloadSharex: "📥 ShareX 設定 (.sxcu)",
    uploadNamingRuleLabel: "🏷️ ファイル名ルール (ShareX等):",
    uploadNamingOriginal: "元の名前を維持 (100文字自動切り詰め)",
    uploadNamingRandom: "完全ランダム英数字 (名前秘匿)",
    uploadNamingDateRandom: "日付＋ランダム (20260918_xxxxxx)",
    uploadTokenStatusUnknown: "⚪ 未検証",
    uploadTokenStatusChecking: "🟡 検証中...",
    uploadTokenStatusValid: "🟢 トークン一致 (認証成功)",
    uploadTokenStatusInvalid: "🔴 トークン不一致 (Worker設定と異なります)",
    uploadTokenStatusNeedWorker: "⚠️ Worker URL 未設定",
    uploadApiNote: "※ 本APIで投稿されたファイルは Filebase(IPFS) または R2 に保存され、選択した配信用ドメインの短縮URLが発行されます。",
    sendToUninstallNote: "※「送る」から解除・削除したい場合: <code>Win + R</code> ➜ <code>shell:sendto</code> で開くフォルダからバッチを削除してください。",
    passwordBadge: "🔒 パスワード保護",
    qrModalTitle: "📱 スマホ/別端末でスキャン",
    qrModalSub: "スマホのカメラ等で下記QRコードを読み取ると、Civitaiウォッチリストや接続設定が安全に直接引き継がれます。",
    qrModalWarnTitle: "🚨 第三者への共有・公開厳禁",
    qrModalWarnDesc: "このQRコードやURLにはストレージの<strong>【秘密鍵・認証情報】</strong>が含まれています。配信・SNS・第三者へ絶対に公開しないでください（不正アクセス・データ削除の危険があります）。",
    btnCopySyncUrl: "📋 引き継ぎURLをコピー",
    btnClose: "閉じる",
    civitaiGalleryHeading: "🎨 Civitai ギャラリー & クリエイターウォッチ",
    civitaiUsernameLabel: "👤 クリエイター:",
    civitaiAllCreators: "🌐 すべて (新着順)",
    civitaiNoCreator: "(未登録 - ＋から追加)",
    civitaiEmptyDesc: "Civitai クリエイターが登録されていません。「＋」ボタンから気になるクリエイター名を追加してください。",
    civitaiAddCreator: "➕ ウォッチするクリエイターを追加:",
    civitaiMarkRead: "✓ 既読にする",
    civitaiNewBadge: "{count}件の新着",
    civitaiNewOnly: "✨ 新着のみ",
    civitaiShowAll: "☷ すべて表示",
    civitaiLoadMore: "↓ 過去の投稿をさらに読み込む",
    civitaiNoNewItems: "新着の投稿はありません。",
    civitaiLoadingMore: "過去の投稿を読み込み中…",
    sendToSecurityTitle: "🔐 個人専用バッチを生成しますか？",
    sendToSecurityConfirm: "この BAT ファイルには投稿専用の UPLOAD_TOKEN が平文で含まれます。自分の Windows アカウントだけで保管・使用してください。\n\nメール、チャット、Git リポジトリ、共有フォルダへ渡してはいけません。\n紛失・共有した場合は、Worker の UPLOAD_TOKEN を再発行して、古いバッチを削除してください。",
    sendToSecurityProceed: "理解して生成",
    sharexSecurityTitle: "🔐 ShareX 設定ファイルを生成しますか？",
    sharexSecurityConfirm: "この .sxcu ファイルには投稿専用の UPLOAD_TOKEN が平文で含まれます。自分の端末・アカウントだけで保管・使用してください。\n\nメール、チャット、Discord、Git リポジトリ、共有フォルダへ渡してはいけません。\n他人に渡すと、あなたのストレージに画像を勝手にアップロードされる危険があります。\n紛失・共有した場合は、Worker の UPLOAD_TOKEN を再発行してください。",
    sharexSecurityProceed: "理解してダウンロード",
    civitaiDeleteConfirm: "登録クリエイター「{name}」をウォッチリストから削除しますか？",
    civitaiLastOneError: "最低1件のクリエイター登録が必要です。",
    btnAdd: "追加",
    btnCancel: "キャンセル",
    statusWaiting: "待機中",
    statusReady: "準備完了",
    textComposerHeading: "💬 テキスト作成支援",
    templateLabel: "定型文:",
    promptSave: "定型文を保存",
    promptDelete: "削除",
    btnInsertUrlTag: "＋ {url} を挿入",
    paletteNote: "クリックしてURLを本文（カーソル位置）に挿入:",
    composerPlaceholder: "ここにチャット等に投稿する文章を書きます。上の画像をクリックしてURLを挿入したり、定型文をロードできます。",
    btnPromptCopy: "文章をコピーする",
    r2Heading: "⚡ Cloudflare R2 ストレージ内のファイル",
    limitLabel: "上限:",
    autoFifoLabel: "📦 自動容量解放 (FIFO)",
    btnReload: "更新",
    btnBatchDelete: "選択削除",
    copyUrl: "コピー",
    copyPrompt: "プロンプトコピー",
    copyAllPrompts: "📝 プロンプト一括コピー",
    civitaiPrompt: "📝 プロンプト",
    deleteNow: "削除",
    copied: "コピー完了!",
    failed: "失敗",
    noFilesR2: "ファイルはありません。",
    selectFileR2: "削除するファイルを選択してください。",
    confirmBatchDelete: "選択した {count} 件のファイルを R2 ストレージから削除しますか？",
    confirmSingleDelete: "ファイル '{key}' を R2 ストレージから削除しますか？",
    deleteSuccess: "削除が完了しました。",
    saveSuccess: "R2 接続情報を保存しました！",
    clearSuccess: "接続情報をクリアしました。",
    missingConfig: "R2 接続情報 (Account ID, バケット名, Access Key, Secret Key) を設定してください。",
    s3Error: "R2 ストレージ通信エラー",
    rateReduced: "{rate}% 削減",
    rateIncreased: "{rate}% 増加",
    rateUnchanged: "0% 変化なし",
    nonConverted: "非変換",
    promptSelect: "-- 定型文を選択 --",
    promptNew: "＋ 新規定型文として保存",
    promptNameInput: "定型文のタイトルを入力してください:",
    promptOverwriteConfirm: "既存の定型文 '{name}' を上書きしますか？",
    promptSaveSuccess: "定型文 '{name}' を保存しました！",
    promptDeleteConfirm: "定型文 '{name}' を削除しますか？",
    promptEmptyNotice: "定型文の内容が空です。",
  },
  en: {
    siteTitle: "Cividge",
    eyebrow: "Your media. Your storage. Your delivery.",
    whatIsSiteSummary: "❓ What is this site?",
    whatIsSiteBody: `
      <div style="font-size: 13px; line-height: 1.6; color: var(--text);">
        <p style="margin-bottom: 12px; font-weight: 500;">
          <strong>Civitai Bridge (Cividge)</strong> is a personal media uploader for AI creators who want to keep control of where their work lives. Convert media in your browser, then upload directly to storage you control: Cloudflare R2 or Filebase/IPFS.
        </p>
        <p style="margin: 0 0 12px; font-size: 12px; color: var(--text-secondary);">
          It began as a practical replacement when Catbox became unavailable on major Japanese anonymous boards: a way to keep sharing generated images without depending on a single public file host.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin: 14px 0;">
          <div style="background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.25); border-radius: 8px; padding: 10px 12px;">
            <div style="font-weight: bold; color: #818cf8; margin-bottom: 3px;">🔒 Direct-to-your-storage</div>
            <div style="font-size: 11.5px; color: var(--muted);">Upload from your browser to storage in your own account. Cividge does not operate a shared upload relay or keep your storage credentials.</div>
          </div>
          <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 8px; padding: 10px 12px;">
            <div style="font-weight: bold; color: #34d399; margin-bottom: 3px;">🧭 Controlled delivery</div>
            <div style="font-size: 11.5px; color: var(--muted);">An optional Worker you deploy yourself adds stable delivery URLs, aliases, expiration, password gates, and delivery control.</div>
          </div>
          <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 10px 12px;">
            <div style="font-weight: bold; color: #38bdf8; margin-bottom: 3px;">🌱 Discover, preserve, and share</div>
            <div style="font-size: 11.5px; color: var(--muted);">Browse public creator posts with the Civitai API, collect media URLs, and share work through delivery links you control.</div>
          </div>
        </div>

        <details style="margin-top: 10px; background: rgba(15, 23, 42, 0.5); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 6px; padding: 6px 10px;">
          <summary style="cursor: pointer; font-weight: 600; color: #38bdf8; font-size: 12px;">💡 Storage Selection Guide & Operational Tips (R2 vs Filebase vs Kubo)</summary>
          <div style="margin-top: 6px; font-size: 11.5px; line-height: 1.55; color: #cbd5e1;">
            <ul style="margin: 0; padding-left: 18px;">
              <li><strong>Cloudflare R2</strong>: Zero egress cost (100% free downloads). Best for viral traffic and heavy videos (up to 128MB). *Credit card required; automatic pay-as-you-go above 10GB free tier (no cap mechanism).*</li>
              <li><strong>Filebase (IPFS)</strong>: No credit card required. Best for standard images (1–2MB) and decentralized preservation. *Free tier includes 5GB storage & 10GB/month transfer.*</li>
              <li><strong>Self-hosted Kubo Node</strong>: Pinning heavy videos (>20MB) to your Kubo node before sharing completely bypasses Filebase egress quotas via public gateways.</li>
            </ul>
          </div>
        </details>

        <div style="margin-top: 14px; padding: 10px 12px; background: rgba(245, 158, 11, 0.08); border-left: 3px solid #f59e0b; border-radius: 4px; font-size: 11.5px; color: var(--muted);">
          <strong style="color: #fbbf24;">📌 Independent tool notice:</strong><br>
          Storage credentials remain in this browser and are sent to the storage provider you configure. Cividge is independent software and is not affiliated with or endorsed by Civitai.
        </div>
      </div>
    `,
    inputFiles: "Input Files",
    addFolder: "Add Folder",
    dropText: "Drop files or folders here",
    orClick: "or click to select files",
    dropLimitHint: "* Max 128 MB per file",
    settings: "Settings",
    enableConvertLabel: "Convert Images",
    enableRenameLabel: "Rename Files",
    outputFormat: "Output Format",
    quality: "Quality",
    renameRule: "Rename Pattern",
    originalName: "Original Name",
    seq01: "Sequence (01)",
    seq001: "Sequence (001)",
    random6: "Random (6 chars)",
    previewLabel: "Preview:",
    zipOptionLabel: "🗜️ Save all in ZIP archive",
    btnDownload: "📥 Download",
    btnUpload: "🟩 Upload",
    btnConvertUpload: "🟩 Upload",
    btnUploadR2: "⚡ Save to R2",
    btnUploadFilebase: "🪐 Save to Filebase",
    r2BillingWarningBadge: "⚠️ 10GB Billing Warning",
    r2BillingWarningTooltip: "⚠️ R2 begins automatic pay-as-you-go billing once account storage exceeds 10GB (no hard cap). It is calculated based on your total account usage, so please verify billing terms yourself.",
    cfTitle: "☁️ Cloud Storage Settings",
    kvAccordionTitle: "📚 KV Delivery & Management Worker",
    kvAccordionDesc: "The shared registry for R2 and Filebase: short URLs, aliases, expiry, and password protection.",
    r2AccordionDesc: "Configure R2 credentials, R2-only delivery domains, CORS, and capacity release.",
    filebaseAccordionDesc: "Configure Filebase CID/IPFS storage, Filebase-only delivery domains, and an optional Kubo preservation node.",
    quickR2DomainLabel: "🌐 R2 delivery domain",
    quickFilebaseDomainLabel: "🌐 Filebase delivery domain",
    r2DomainPlaceholder: "-- Select R2 domain --",
    filebaseDomainPlaceholder: "-- Select Filebase domain --",
    r2DeliveryTitle: "1️⃣ Set the R2 public / delivery URL",
    filebaseDeliveryTitle: "2️⃣ Set the Filebase public / delivery URL",
    r2CompatibilitySummary: "🛡️ pages.dev public compatibility layer (query-busting defense)",
    r2CompatibilityConfigured: "Public entry: ",
    r2CompatibilityMissing: "⚠ Select the static relay project's pages.dev URL from the R2 delivery-domain list above.",
    r2CompatibilityInstallSummary: "Install the static relay project",
    r2CompatibilityInstallBody: "Deploy the included template as the <strong>public static Pages project</strong>. It redirects each path to the existing R2 delivery domain. Add the resulting pages.dev URL to the R2 delivery-domain list above and select it. There is no per-upload switch.",
    filebaseCompatibilitySummary: "🛡️ pages.dev public compatibility layer (query-busting defense)",
    filebaseCompatibilityConfigured: "Public entry: ",
    filebaseCompatibilityMissing: "⚠ Select the static relay project's pages.dev URL from the Filebase delivery-domain list above.",
    filebaseCompatibilityInstallSummary: "Install the static relay project",
    filebaseCompatibilityInstallBody: "Deploy the included template as the <strong>public static Pages project</strong>. It contains no Functions, KV, or storage credentials; it redirects each path to the compatibility Worker. Add the resulting pages.dev URL to the Filebase delivery-domain list above and select it. There is no per-upload switch.",
    filebaseCompatibilityCloudflareSummary: "Recommended Cloudflare settings",
    filebaseCompatibilityCloudflareBody: "Only needed when the compatibility Worker uses your own domain.<ol style=\"margin:6px 0 0;padding-left:18px;\"><li><strong>Rules → URL Rewrite Rules</strong>: match the compatibility Worker host, preserve the path, and rewrite the query to an empty static value.</li><li><strong>Security → Rate Limiting Rules</strong>: for paths starting with <code>/r/</code>, use <strong>30 requests / 10 seconds per IP</strong>, <strong>Block</strong>, and a <strong>10-second</strong> mitigation timeout.</li><li>If appropriate, add a <strong>Custom Rule</strong> that blocks all compatibility-Worker paths except <code>/r/</code> and <code>/api/</code>.</li></ol>",
    requiredText: "* Required",
    deliveryDomainHintR2: "Add or remove R2 Worker URLs, pages.dev URLs, custom domains, or R2 dev URLs. The selected URL is used as the delivery base for copied image URLs and the palette.",
    deliveryDomainHintFilebase: "Add or remove Filebase/IPFS Worker URLs, pages.dev URLs, or custom domains. The selected URL is used as the delivery base for new Filebase uploads.",
    deliveryGuideSummary: "Create or change a delivery URL",
    r2DeliveryGuide: "Start with the KV Worker <code>https://…workers.dev</code> URL. Only deploy Pages or add a Worker custom domain when you need a separate URL.<ol><li><code>npx wrangler login</code></li><li>Run <code>npm run build</code> at the repository root</li><li><code>npx wrangler pages deploy dist --project-name=my-r2-delivery</code></li><li>Add the shown <code>https://my-r2-delivery.pages.dev</code> URL using ＋.</li></ol>",
    filebaseDeliveryGuide: "Use a delivery domain <strong>separate</strong> from R2 for Filebase. Create a new Pages project and deploy this Cividge delivery code.<ol><li><code>npx wrangler login</code></li><li>Run <code>npm run build</code> at the repository root</li><li><code>npx wrangler pages deploy dist --project-name=my-filebase-delivery</code></li><li>Add the shown <code>https://my-filebase-delivery.pages.dev</code> URL using ＋.</li></ol>",
    kvWorkerTitle: "📚 KV Registry Integration (short URLs, passwords, BYOC)",
    kvWorkerRepo: "cividge-kv-worker repository ↗",
    r2CorsSummary: "R2 bucket CORS policy (required for browser access)",
    r2CorsHelp: "In R2 → your bucket → Settings → CORS Policy → Edit, paste a policy that allows the frontend URL. Use the URL where this app is opened, not the delivery domain.",
    r2CorsCopy: "📋 Copy CORS policy",
    filebaseBucketLabel: "Filebase bucket name (IPFS bucket)",
    filebaseAccessKeyLabel: "Filebase key (Access Key)",
    filebaseSecretKeyLabel: "Filebase Secret Key",
    filebaseCorsAuto: "⚙️ Configure CORS",
    kuboTitle: "🏠 Home Kubo (IPFS preservation provider)",
    kuboAccordionTitle: "🏠 Home Kubo (IPFS Preservation Node)",
    kuboAccordionDesc: "Integrates with your home Kubo node to automatically preserve files when R2 or Filebase releases capacity.",
    filebaseAccordionTitle: "🪐 Filebase (IPFS)",
    kuboTest: "🔌 Test connection",
    kuboRpcLabel: "Kubo RPC endpoint URL",
    kuboUnknown: "⚪ Not checked",
    kuboEndpointHelp: "At home use http://127.0.0.1:5001; for remote HTTPS access use a Tailscale or similar endpoint.",
    kuboAutoPinR2: "Automatically pin to Kubo when Cloudflare R2 releases capacity",
    kuboAutoPin: "Automatically pin to Kubo when Filebase releases capacity",
    kuboPrioritizePinnedLabel: "Prioritize releasing files already pinned to Kubo",
    kuboGuideSummary: "Recommended operation and remote access (optional)",
    kuboGuideBody: "<p style=\"margin: 7px 0 0;\"><strong style=\"color: #ddd6fe;\">What does this do?</strong><br>It uses your PC or server as an IPFS node and pins a CID before Filebase releases capacity. As long as Kubo remains online and retains the pin, you preserve a copy of that CID. This is a preservation layer, not your only backup.</p><p style=\"margin: 7px 0 0;\"><strong style=\"color: #ddd6fe;\">Minimum setup</strong><br>1. Install and start Kubo. 2. At home keep <code>http://127.0.0.1:5001</code>. 3. Enable automatic pinning only after <strong>🔌 Test connection</strong> succeeds. When Kubo is offline, Cividge safely pauses Filebase FIFO to avoid data loss.</p><p style=\"margin: 7px 0 0;\"><strong style=\"color: #ddd6fe;\">Delivery and caching</strong><br>Cividge delivery URLs use edge caching, so cached visits reduce load on Filebase and IPFS nodes. Initial visits and cache misses still access an upstream. Kubo RPC is for pin operations; it does not by itself make Kubo the permanent first delivery origin.</p><p style=\"margin: 7px 0 0;\"><strong style=\"color: #ddd6fe;\">Safe remote access</strong><br>Keep the API bound to <code>127.0.0.1:5001</code>; never expose it directly to the internet. For remote pinning, use an HTTPS endpoint available only inside your Tailnet, such as <strong>Tailscale Serve</strong>. Do not use <strong>0.0.0.0:5001</strong>, a public reverse proxy, or router port forwarding.</p>",
    kvApiEndpointLabel: "KV registry API endpoint URL",
    kvApiEndpointHelp: "You can specify your own Cloudflare Worker. When blank, Cividge tries this site's /api/cividge-kv.",
    kvApiTokenLabel: "KV API token",
    kvApiTokenHelp: "Without a token, it avoids writing to the shared KV and uses a safe direct IPFS CID link (/i/CID/name).",
    r2AccountLabel: "Account ID",
    r2AccountSub: "Cloudflare Account ID",
    r2BucketLabel: "R2 Bucket Name",
    r2BucketSub: "Target Cloudflare R2 Bucket Name",
    r2AccessKeyLabel: "Access Key ID",
    r2AccessKeySub: "R2 API Token Access Key ID",
    r2SecretKeyLabel: "Secret Access Key",
    r2SecretKeySub: "R2 API Token Secret Access Key",
    r2DomainLabel: "Direct Public Domain URL",
    r2DomainSub: "Custom domain (used by Copy button)",
    r2DevDomainLabel: "R2 Dev Address (dev URL)",
    r2DevDomainSub: "R2 public dev address (used by devCopy button)",
    btnSave: "Save",
    btnShareQr: "📱 Share via QR",
    btnPinBackup: "🔗 PIN Backup",
    btnClear: "Clear",
    topbarSyncBtn: "Sync / Backup",
    dataSyncHeading: "📦 Settings Sync & Mobile Sharing",
    dataSyncDesc: "Securely sync Civitai creators watch list, Cloudflare R2 credentials, and converter settings to mobile or other devices.",
    btnClearAllData: "🗑️ Clear All",
    retentionPeriod: "⏳ Retention (TTL)",
    ttlNever: "Keep Forever (No Expiry)",
    ttl1h: "1 Hour (Auto-expire)",
    ttl12h: "12 Hours (Auto-expire)",
    ttl1d: "1 Day (Auto-expire)",
    ttl3d: "3 Days (Auto-expire)",
    ttl7d: "7 Days (Auto-expire)",
    tempPasswordLabel: "🔑 Access Password",
    tempPasswordPlaceholder: "Set password phrase",
    passwordIpfsNoticeSummary: "About IPFS password protection",
    passwordIpfsNotice: "Password protection applies to the Cividge delivery URL. Anyone who knows an IPFS CID may still retrieve it through an IPFS gateway. Do not upload files that require strict confidentiality.",
    optionalText: "(Optional)",
    quickUploadHeading: "🚀 Quick Upload / Windows 'Send To'",
    uploadReturnDomainLabel: "🌐 Return Delivery Address (Select per purpose):",
    uploadApiUrl: "Upload API Endpoint URL",
    btnCopyUrl: "📋 Copy URL",
    btnCopyCurl: "💻 Copy curl",
    btnDownloadSendTo: "📥 Windows 'Send To' Batch",
    btnDownloadSharex: "📥 ShareX Config (.sxcu)",
    uploadNamingRuleLabel: "🏷️ Filename rule (ShareX etc):",
    uploadNamingOriginal: "Keep original name (auto 100-char limit)",
    uploadNamingRandom: "Random alphanumeric (hide original name)",
    uploadNamingDateRandom: "Date + random (20260918_xxxxxx)",
    uploadTokenStatusUnknown: "⚪ Not verified",
    uploadTokenStatusChecking: "🟡 Checking...",
    uploadTokenStatusValid: "🟢 Token valid (Authenticated)",
    uploadTokenStatusInvalid: "🔴 Token mismatch (Invalid token)",
    uploadTokenStatusNeedWorker: "⚠️ Worker URL not configured",
    uploadApiNote: "※ Files uploaded via this API are stored in Filebase (IPFS) or R2 with a short URL for the selected domain.",
    sendToUninstallNote: "※ To remove from 'Send To': Press <code>Win + R</code> ➜ type <code>shell:sendto</code> and delete the batch file.",
    passwordBadge: "🔒 Password Protected",
    qrModalTitle: "📱 Scan with Mobile / Other Device",
    qrModalSub: "Scan this QR code with your mobile camera to securely transfer your Civitai watch list, connection settings, and preferences.",
    qrModalWarnTitle: "🚨 Strictly Confidential — Do NOT Share",
    qrModalWarnDesc: "This QR code and URL contain your storage <strong>【Secret Keys & Admin Tokens】</strong>. Never share or stream this screen (risk of unauthorized access, deletion, or tampering).",
    btnCopySyncUrl: "📋 Copy Sync URL",
    btnClose: "Close",
    civitaiGalleryHeading: "🎨 Civitai Gallery & Watcher",
    civitaiUsernameLabel: "👤 Creator:",
    civitaiAllCreators: "🌐 All (Newest)",
    civitaiNoCreator: "(No creators - click ＋ to add)",
    civitaiEmptyDesc: "No Civitai creators registered. Click \"＋\" to add a creator to your watch list.",
    civitaiAddCreator: "➕ Add Creator to Watch:",
    civitaiMarkRead: "✓ Mark as Read",
    civitaiNewBadge: "{count} New",
    civitaiNewOnly: "✨ New only",
    civitaiShowAll: "☷ Show all",
    civitaiLoadMore: "↓ Load older posts",
    civitaiNoNewItems: "No new posts.",
    civitaiLoadingMore: "Loading older posts…",
    sendToSecurityTitle: "🔐 Generate a personal batch file?",
    sendToSecurityConfirm: "This BAT file contains your upload-only UPLOAD_TOKEN in plain text. Store and use it only under your own Windows account.\n\nNever share it in email, chat, a Git repository, or a shared folder.\nIf it is lost or shared, rotate the Worker's UPLOAD_TOKEN and delete old batch files.",
    sendToSecurityProceed: "I understand — generate",
    sharexSecurityTitle: "🔐 Generate ShareX config file?",
    sharexSecurityConfirm: "This .sxcu file contains your upload-only UPLOAD_TOKEN in plain text. Store and use it only on your own device and account.\n\nNever share it in email, chat, Discord, Git repositories, or public links.\nIf shared, others can upload files to your storage without permission.\nIf compromised, rotate the Worker's UPLOAD_TOKEN immediately.",
    sharexSecurityProceed: "I understand — download",
    civitaiDeleteConfirm: "Remove creator \"{name}\" from your watch list?",
    civitaiLastOneError: "At least one creator must be kept.",
    btnAdd: "Add",
    btnCancel: "Cancel",
    statusWaiting: "Waiting",
    statusReady: "Ready",
    textComposerHeading: "💬 Text Composer",
    templateLabel: "Template:",
    promptSave: "Save Template",
    promptDelete: "Delete",
    btnInsertUrlTag: "＋ Insert {url}",
    paletteNote: "Click image to insert URL at cursor:",
    composerPlaceholder: "Write your post here. Click images above to insert direct URLs.",
    btnPromptCopy: "Copy Post Text",
    r2Heading: "⚡ Files in Cloudflare R2 Storage",
    limitLabel: "Limit:",
    autoFifoLabel: "📦 Automatic capacity release (FIFO)",
    btnReload: "Reload",
    btnBatchDelete: "Delete Selected",
    copyUrl: "Copy",
    copyPrompt: "Copy Prompt",
    copyAllPrompts: "📝 Copy All Prompts",
    civitaiPrompt: "📝 Prompt",
    deleteNow: "Delete",
    copied: "Copied!",
    failed: "Failed",
    noFilesR2: "No files in storage.",
    selectFileR2: "Please select files to delete.",
    confirmBatchDelete: "Are you sure you want to delete {count} selected files from R2?",
    confirmSingleDelete: "Delete file '{key}' from R2 storage?",
    deleteSuccess: "Deletion completed.",
    saveSuccess: "R2 connection settings saved!",
    clearSuccess: "Connection settings cleared.",
    missingConfig: "Please configure R2 Account ID, Bucket Name, Access Key, and Secret Key.",
    s3Error: "R2 storage communication error",
    rateReduced: "{rate}% reduced",
    rateIncreased: "{rate}% increased",
    rateUnchanged: "0% unchanged",
    nonConverted: "Original",
    promptSelect: "-- Select template --",
    promptNew: "+ Save as new template",
    promptNameInput: "Enter title for template:",
    promptOverwriteConfirm: "Overwrite existing template '{name}'?",
    promptSaveSuccess: "Template '{name}' saved!",
    promptDeleteConfirm: "Delete template '{name}'?",
    promptEmptyNotice: "Template content is empty.",
  }
};

// --- アプリケーション状態 ---
const state = {
  files: [],
  results: [],
  r2TotalSize: 0,
};

let paletteFiles = [];

const defaultTemplates = {
  "standard": {
    name: "基本の挨拶",
    text: "お世話になっております。\n画像を添付いたします。\n\n{url}"
  }
};

// --- DOM 要素 ---
const fileInput = document.querySelector("#fileInput");
const folderInput = document.querySelector("#folderInput");
const folderSelectButton = document.querySelector("#folderSelectButton");
const dropzone = document.querySelector("#dropzone");
const fileList = document.querySelector("#fileList");
const fileCount = document.querySelector("#fileCount");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const copyAllPromptsBtn = document.querySelector("#copyAllPromptsBtn");
const civitaiPromptsMap = {};

// 設定要素
const enableConvertCheck = document.querySelector("#enableConvertCheck");
const convertSettingsArea = document.querySelector("#convertSettingsArea");
const enableRenameCheck = document.querySelector("#enableRenameCheck");
const renameSettingsArea = document.querySelector("#renameSettingsArea");
const enableTtlCheck = document.querySelector("#enableTtlCheck");
const tempTtlSelect = document.querySelector("#tempTtlSelect");
const formatSelect = document.querySelector("#formatSelect");
const qualityRange = document.querySelector("#qualityRange");
const qualityOutput = document.querySelector("#qualityOutput");
const renamePattern = document.querySelector("#renamePattern");
const clearRenamePattern = document.querySelector("#clearRenamePattern");
const enableZipCheck = document.querySelector("#enableZipCheck");

// アクションボタン
const convertDownloadButton = document.querySelector("#convertDownloadButton");
const convertUploadR2Button = document.querySelector("#convertUploadR2Button");
const convertUploadFilebaseButton = document.querySelector("#convertUploadFilebaseButton");
const quickDomainSelect = document.querySelector("#quickDomainSelect");
const quickFilebaseDomainSelect = document.querySelector("#quickFilebaseDomainSelect");
const clearButton = document.querySelector("#clearButton");

// ☁️ Cloudflare R2 接続設定フォーム要素
const r2AccountId = document.querySelector("#r2AccountId");
const r2BucketName = document.querySelector("#r2BucketName");
const r2AccessKeyId = document.querySelector("#r2AccessKeyId");
const r2SecretAccessKey = document.querySelector("#r2SecretAccessKey");
const r2DomainSelect = document.querySelector("#r2DomainSelect");
const r2DomainAddBtn = document.querySelector("#r2DomainAddBtn");
const r2DomainDeleteBtn = document.querySelector("#r2DomainDeleteBtn");
const r2DomainAddForm = document.querySelector("#r2DomainAddForm");
const r2DomainNewInput = document.querySelector("#r2DomainNewInput");
const r2DomainNewSaveBtn = document.querySelector("#r2DomainNewSaveBtn");
const r2DomainNewCancelBtn = document.querySelector("#r2DomainNewCancelBtn");
const r2DomainTestBtn = document.querySelector("#r2DomainTestBtn");
const r2DomainCompatBadge = document.querySelector("#r2DomainCompatBadge");
const r2DomainMirrorContainer = document.querySelector("#r2DomainMirrorContainer");
const r2DomainMirrorCheck = document.querySelector("#r2DomainMirrorCheck");
const r2PublicDomain = document.querySelector("#r2PublicDomain"); // 後方互換
const r2DevDomain = document.querySelector("#r2DevDomain"); // 後方互換
const filebaseDomainSelect = document.querySelector("#filebaseDomainSelect");
const filebaseDomainAddBtn = document.querySelector("#filebaseDomainAddBtn");
const filebaseDomainDeleteBtn = document.querySelector("#filebaseDomainDeleteBtn");
const filebaseDomainTestBtn = document.querySelector("#filebaseDomainTestBtn");
const filebaseDomainCompatBadge = document.querySelector("#filebaseDomainCompatBadge");
const filebaseDomainMirrorContainer = document.querySelector("#filebaseDomainMirrorContainer");
const filebaseDomainMirrorCheck = document.querySelector("#filebaseDomainMirrorCheck");
const filebaseDomainAddForm = document.querySelector("#filebaseDomainAddForm");
const filebaseDomainNewInput = document.querySelector("#filebaseDomainNewInput");
const filebaseDomainNewSaveBtn = document.querySelector("#filebaseDomainNewSaveBtn");
const filebaseDomainNewCancelBtn = document.querySelector("#filebaseDomainNewCancelBtn");
const r2CompatibilityStatus = document.querySelector("#r2CompatibilityStatus");
const filebaseCompatibilityStatus = document.querySelector("#filebaseCompatibilityStatus");

// 🪐 Filebase 接続設定フォーム要素
const filebaseBucket = document.querySelector("#filebaseBucket");
const filebaseApiKey = document.querySelector("#filebaseApiKey");
const filebaseSecretKey = document.querySelector("#filebaseSecretKey");

// 🏠 Kubo IPFS ノード接続設定要素
const kuboRpcUrl = document.querySelector("#kuboRpcUrl");
const kuboAutoPinR2Check = document.querySelector("#kuboAutoPinR2Check");
const kuboAutoPinCheck = document.querySelector("#kuboAutoPinCheck");
const kuboPrioritizePinned = document.querySelector("#kuboPrioritizePinned");
const kuboTestButton = document.querySelector("#kuboTestButton");
const kuboWebUiLink = document.querySelector("#kuboWebUiLink");
const kuboStatusIndicator = document.querySelector("#kuboStatusIndicator");

// 🛡️ 管理者 / KV台帳設定要素
const kvWorkerUrl = document.querySelector("#kvWorkerUrl");
const adminApiToken = document.querySelector("#adminApiToken");
const adminTokenStatus = document.querySelector("#adminTokenStatus");

const cfStatus = document.querySelector("#cfStatus");
const cfSettingsAccordion = document.querySelector("#kvSettingsAccordion");
const cfSaveButton = document.querySelector("#cfSaveButton");
const cfClearButton = document.querySelector("#cfClearButton");
const cfShareQrButton = document.querySelector("#cfShareQrButton");
const cfBackupUrlButton = document.querySelector("#cfBackupUrlButton");
const topbarSyncButton = document.querySelector("#topbarSyncButton");
const globalClearButton = document.querySelector("#globalClearButton");
const providerR2 = document.querySelector("#providerR2");
const providerFilebase = document.querySelector("#providerFilebase");
const filebaseCorsButton = document.querySelector("#filebaseCorsButton");
const cfDashboardLink = document.querySelector("#cfDashboardLink");

// 設定を保存先ごとの責務で分離する。入力ID・既存の保存処理は変更せず、
// R2 / Filebase / Kubo / KV Worker の4つの独立アコーディオンへ再配置する。
function organizeStorageSettingsUi() {
  const r2Content = document.querySelector("#r2SettingsContent");
  const filebaseContent = document.querySelector("#filebaseSettingsContent");
  const kuboContent = document.querySelector("#kuboSettingsContent");
  const kvContent = document.querySelector("#kvSettingsContent");
  const r2Delivery = document.querySelector("#r2DeliverySettingsGroup");
  const r2Credentials = document.querySelector("#r2CredentialsSettingsGroup");
  const filebaseDelivery = document.querySelector("#filebaseDeliverySettingsGroup");
  const filebaseCredentials = document.querySelector("#filebaseCredentialsSettingsGroup");
  const kuboSettings = document.querySelector("#kuboSettingsGroup");
  const kvSettings = document.querySelector("#kvWorkerSettingsGroup");
  const actions = document.querySelector("#cloudSettingsActions");
  const keysContainer = document.querySelector("#r2KeysStepContainer");

  if (!r2Content || !filebaseContent || !kvContent) return;
  [r2Delivery, r2Credentials].filter(Boolean).forEach(node => r2Content.appendChild(node));
  [filebaseDelivery, filebaseCredentials].filter(Boolean).forEach(node => filebaseContent.appendChild(node));
  if (kuboSettings && kuboContent) {
    kuboContent.appendChild(kuboSettings);
  } else if (kuboSettings) {
    filebaseContent.appendChild(kuboSettings);
  }
  [kvSettings, actions, cfStatus].filter(Boolean).forEach(node => kvContent.appendChild(node));
  if (keysContainer && keysContainer.childElementCount === 0) keysContainer.remove();

  const corsPreview = document.querySelector("#r2CorsPolicyPreview");
  const corsCopyButton = document.querySelector("#r2CorsPolicyCopyBtn");
  const frontendOrigin = window.location.origin.replace(/\/$/, "");
  const corsPolicy = JSON.stringify([{
    AllowedOrigins: [...new Set([frontendOrigin, "http://127.0.0.1:5173", "http://localhost:5173"])],
    AllowedMethods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
    MaxAgeSeconds: 3600,
  }], null, 2);
  if (corsPreview) corsPreview.textContent = corsPolicy;
  corsCopyButton?.addEventListener("click", () => copyToClipboard(corsPolicy, corsCopyButton, "📋 CORS 設定をコピーしました"));
}

organizeStorageSettingsUi();

// 🎨 Civitai ギャラリー要素
const civitaiUserSelect = document.querySelector("#civitaiUserSelect");
const civitaiUserAddBtn = document.querySelector("#civitaiUserAddBtn");
const civitaiUserDeleteBtn = document.querySelector("#civitaiUserDeleteBtn");
const civitaiUserAddForm = document.querySelector("#civitaiUserAddForm");
const civitaiUserNewInput = document.querySelector("#civitaiUserNewInput");
const civitaiUserNewSaveBtn = document.querySelector("#civitaiUserNewSaveBtn");
const civitaiUserNewCancelBtn = document.querySelector("#civitaiUserNewCancelBtn");
const civitaiNewBadge = document.querySelector("#civitaiNewBadge");
const civitaiMarkReadBtn = document.querySelector("#civitaiMarkReadBtn");
const civitaiLoadMoreBtn = document.querySelector("#civitaiLoadMoreBtn");
const civitaiUsername = civitaiUserSelect; // 後方互換
const civitaiPanel = document.querySelector("#civitaiPanel");
const civitaiGalleryList = document.querySelector("#civitaiGalleryList");
const reloadCivitaiButton = document.querySelector("#reloadCivitaiButton");
const civitaiProfileLink = document.querySelector("#civitaiProfileLink");
const civitaiGalleryState = {
  scopeKey: "",
  items: [],
  nextPages: {},
};

// R2 & Filebase ファイル一覧 & タブ要素
const storageTabR2 = document.querySelector("#storageTabR2");
const storageTabFilebase = document.querySelector("#storageTabFilebase");
let activeStorageTab = localStorage.getItem("activeStorageTab") || "r2";

const r2FileList = document.querySelector("#r2FileList");
const reloadR2FilesButton = document.querySelector("#reloadR2FilesButton");
const deleteSelectedR2FilesButton = document.querySelector("#deleteSelectedR2FilesButton");
const r2PaginationControls = document.querySelector("#r2PaginationControls");
const r2PrevPageBtn = document.querySelector("#r2PrevPageBtn");
const r2NextPageBtn = document.querySelector("#r2NextPageBtn");
const r2PageInfo = document.querySelector("#r2PageInfo");
const r2PerPageSelect = document.querySelector("#r2PerPageSelect");

// 📄 ストレージ一覧ページネーション状態
let storageCurrentPage = 1;
let storagePerPage = parseInt(localStorage.getItem("storagePerPage") || "10", 10);
let storageCachedContents = [];
// タブ切替中に古い非同期一覧取得が完了して、新しいタブの表示を上書きしないための世代番号。
let storageFetchGeneration = 0;
const storageLimitRange = document.querySelector("#storageLimitRange");
const storageLimitInput = document.querySelector("#storageLimitInput");
const storageLimitOutput = document.querySelector("#storageLimitOutput");
const storageUsageText = document.querySelector("#storageUsageText");
const storageUsageBar = document.querySelector("#storageUsageBar");
const autoFifoCheckbox = document.querySelector("#autoFifoCheckbox");
const autoFifoLabel = document.querySelector("#autoFifoLabel");

// テキスト作成支援要素
const templateSelect = document.querySelector("#templateSelect");
const saveTemplateButton = document.querySelector("#saveTemplateButton");
const deleteTemplateButton = document.querySelector("#deleteTemplateButton");
const insertUrlTagButton = document.querySelector("#insertUrlTagButton");
const paletteList = document.querySelector("#paletteList");
const composerTextarea = document.querySelector("#composerTextarea");
const clearComposerButton = document.querySelector("#clearComposerButton");
const copyComposerTextButton = document.querySelector("#copyComposerTextButton");

// QRコードモーダル要素
const qrModal = document.querySelector("#qrModal");
const qrCanvas = document.querySelector("#qrCanvas");
const closeQrModalButton = document.querySelector("#closeQrModalButton");

// 言語切替
const langSelect = document.querySelector("#langSelect");

function getAppLanguage() {
  const saved = localStorage.getItem("appLang");
  if (saved && (saved === "ja" || saved === "en")) return saved;
  return "en";
}

function setAppLanguage(lang) {
  localStorage.setItem("appLang", lang);
  applyLanguage(lang);
}

function applyLanguage(lang) {
  const dict = i18nDict[lang] || i18nDict.ja;
  if (langSelect) langSelect.value = lang;

  document.querySelectorAll("[data-i18n]").forEach(elem => {
    const key = elem.getAttribute("data-i18n");
    if (dict[key]) {
      if (elem.getAttribute("data-i18n-html") === "true") {
        elem.innerHTML = dict[key];
      } else {
        elem.textContent = dict[key];
      }
    }
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(elem => {
    const key = elem.getAttribute("data-i18n-placeholder");
    if (dict[key]) {
      elem.placeholder = dict[key];
    }
  });

  document.querySelectorAll("[data-i18n-title]").forEach(elem => {
    const key = elem.getAttribute("data-i18n-title");
    if (dict[key]) {
      elem.title = dict[key];
    }
  });

  updateR2Status();
  updateStorageUsageUI();
  // 言語切替でも、件数0のオンボーディングを含めストレージ領域を必ず
  // 現在の言語で再描画する。従来は一覧が1件以上の場合だけだったため、
  // 未設定時の案内カードが切替後に古いDOMのまま残っていた。
  const storageConfigured = activeStorageTab === "filebase"
    ? isFilebaseConfigured()
    : isR2Configured();
  if (storageConfigured) {
    renderCurrentStoragePage();
  } else {
    renderStorageOnboardingCard();
  }
  loadTemplates(templateSelect ? templateSelect.value : "");
  render();
}

langSelect?.addEventListener("change", (e) => {
  setAppLanguage(e.target.value);
});

// --- S3 クライアント生成 ＆ ストレージ接続判定ヘルパー ---
let s3ClientR2 = null;
let s3ClientFilebase = null;

function isR2Configured() {
  const accountId = (localStorage.getItem("r2AccountId") || r2AccountId?.value || "").trim();
  const bucketName = (localStorage.getItem("r2BucketName") || r2BucketName?.value || "").trim();
  const accessKeyId = (localStorage.getItem("r2AccessKeyId") || r2AccessKeyId?.value || "").trim();
  const secretAccessKey = (localStorage.getItem("r2SecretAccessKey") || r2SecretAccessKey?.value || "").trim();
  const domain = getSelectedR2Domain("r2");
  return Boolean(accountId && bucketName && accessKeyId && secretAccessKey && domain);
}

function isFilebaseConfigured() {
  const bucketName = (localStorage.getItem("filebaseBucket") || filebaseBucket?.value || "").trim();
  const accessKeyId = (localStorage.getItem("filebaseApiKey") || filebaseApiKey?.value || "").trim();
  const secretAccessKey = (localStorage.getItem("filebaseSecretKey") || filebaseSecretKey?.value || "").trim();
  const domain = getSelectedR2Domain("filebase");
  return Boolean(bucketName && accessKeyId && secretAccessKey && domain);
}

function getBucketName(provider = "r2") {
  if (provider === "filebase") {
    return (localStorage.getItem("filebaseBucket") || filebaseBucket?.value || "").trim();
  }
  return (localStorage.getItem("r2BucketName") || r2BucketName?.value || "").trim();
}

function getS3Client(provider = "r2") {
  if (provider === "filebase") {
    const accessKeyId = (localStorage.getItem("filebaseApiKey") || filebaseApiKey?.value || "").trim();
    const secretAccessKey = (localStorage.getItem("filebaseSecretKey") || filebaseSecretKey?.value || "").trim();
    if (!accessKeyId || !secretAccessKey) return null;

    s3ClientFilebase = new S3Client({
      region: "us-east-1",
      endpoint: "https://s3.filebase.io",
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    return s3ClientFilebase;
  }

  // デフォルト: Cloudflare R2
  const accountId = (localStorage.getItem("r2AccountId") || r2AccountId?.value || "").trim();
  const accessKeyId = (localStorage.getItem("r2AccessKeyId") || r2AccessKeyId?.value || "").trim();
  const secretAccessKey = (localStorage.getItem("r2SecretAccessKey") || r2SecretAccessKey?.value || "").trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;

  s3ClientR2 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
  return s3ClientR2;
}

/**
 * S3 / R2 オブジェクトの安全な削除
 * DeleteObjectsCommand (POST /?delete) がバケットの CORS (POST未許可等) で失敗した場合、
 * 自動的に DeleteObjectCommand (DELETE /<key>) の並行実行へフォールバックする。
 */
async function safeDeleteS3Objects(s3, bucketName, keys) {
  if (!s3 || !bucketName || !keys) return;
  const keyList = Array.isArray(keys) ? keys : Array.from(keys);
  const uniqueKeys = Array.from(new Set(keyList.filter(Boolean)));
  if (uniqueKeys.length === 0) return;

  if (uniqueKeys.length === 1) {
    await s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: uniqueKeys[0],
    }));
    return;
  }

  try {
    const command = new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: uniqueKeys.map(Key => ({ Key })) },
    });
    await s3.send(command);
  } catch (err) {
    console.warn("DeleteObjectsCommand failed, falling back to individual DeleteObjectCommand:", err);
    await Promise.all(uniqueKeys.map(Key => s3.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key,
    }))));
  }
}

// Filebase S3 バケットの CORS 自動設定 (CID 読み取りヘッダー公開)
async function configureFilebaseCors() {
  const s3 = getS3Client("filebase");
  const bucketName = getBucketName("filebase");

  if (!s3 || !bucketName) {
    alert("⚠️ Filebaseのバケット名、Access Key、Secret Keyを入力してから実行してください。");
    return;
  }

  const btn = filebaseCorsButton;
  const origText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⚙️ 設定中...";
  }

  try {
    const corsCommand = new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ["*"],
            AllowedMethods: ["GET", "PUT", "POST", "HEAD", "DELETE"],
            AllowedHeaders: ["*"],
            ExposeHeaders: [
              "ETag",
              "x-amz-meta-cid",
              "x-amz-meta-ipfs-hash",
              "x-amz-meta-size",
              "x-amz-meta-original-size",
            ],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    });
    await s3.send(corsCommand);
    alert(`✅ Filebaseバケット「${bucketName}」にIPFS CID公開用CORS設定を適用しました！\nこれでブラウザからIPFS CIDが正常に取得できます。`);
  } catch (err) {
    console.error("CORS設定失敗:", err);
    alert(`❌ CORS設定の適用に失敗しました:\n${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

// --- 🪐 IPFS CID キャッシュ管理 ---
function isValidIpfsCid(cid) {
  if (!cid || typeof cid !== "string") return false;
  const trimmed = cid.trim();
  // CIDv0: Base58btc、通常 "Qm" で始まり46文字（Base58文字セット: 1-9A-HJ-NP-Za-km-z）
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(trimmed)) return true;
  // CIDv1: 通常 "bafy" または "bafk" で始まり59文字以上
  if (/^(bafy|bafk)[a-z0-9]{50,}$/.test(trimmed)) return true;
  return false;
}

function getStoredIpfsCid(key) {
  if (!key) return null;
  try {
    const map = JSON.parse(localStorage.getItem("ipfsCidMap") || "{}");
    const cid = map[key] || null;
    return isValidIpfsCid(cid) ? cid : null;
  } catch (e) {
    return null;
  }
}

function storeIpfsCid(key, cid) {
  if (!key || !cid || !isValidIpfsCid(cid)) return;
  try {
    const map = JSON.parse(localStorage.getItem("ipfsCidMap") || "{}");
    map[key] = cid.trim();
    localStorage.setItem("ipfsCidMap", JSON.stringify(map));
  } catch (e) {}
}

function blobToBase64(blobOrBytes) {
  return new Promise((resolve) => {
    if (!blobOrBytes) return resolve(null);
    try {
      const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes]);
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        resolve(typeof res === "string" ? res.split(",")[1] : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch (e) {
      resolve(null);
    }
  });
}

// 🪐 画像・サムネイルが 404 / 読み込み失敗した際、S3 から直接 Blob を取得して確実に即座表示する共通フォールバック
async function loadFallbackImageFromS3(imgElement, key, s3Key = null, provider = "filebase") {
  if (!imgElement || (!key && !s3Key)) return;
  try {
    const s3 = getS3Client(provider);
    const bucket = getBucketName(provider);
    const targetKey = s3Key || key;
    if (s3 && bucket && targetKey) {
      const res = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: targetKey,
      }));
      if (res && res.Body) {
        const blob = res.Body instanceof Blob ? res.Body : new Blob([await res.Body.transformToByteArray()]);
        const objUrl = URL.createObjectURL(blob);
        imgElement.src = objUrl;
        return true;
      }
    }
  } catch (e) {
    console.debug("S3 direct thumbnail fallback failed:", e);
  }
  const ext = (s3Key || key || "").split('.').pop().toLowerCase();
  if (imgElement.parentElement) {
    imgElement.parentElement.innerHTML = `<div class="thumb format-badge">${escapeHtml(ext.toUpperCase() || 'IMG')}</div>`;
  }
  return false;
}
if (typeof window !== "undefined") {
  window.loadFallbackImageFromS3 = loadFallbackImageFromS3;
}
// --- 🛡️ KV台帳エンドポイント ＆ APIトークン（BYOC・責任分離） ---
function getCustomKvWorkerUrl() {
  const rawUrl = (localStorage.getItem("kvWorkerUrl") || kvWorkerUrl?.value || "").trim().replace(/\/$/, "");
  if (!rawUrl) return "";
  // Workerのホスト名だけが入力されても、fetchがローカル相対パスとして解釈しないようにする。
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

function getKvApiEndpoint() {
  const customUrl = getCustomKvWorkerUrl();
  if (customUrl) {
    if (customUrl.endsWith("/api/cividge-kv") || customUrl.endsWith("/api/ipfs-kv")) {
      return customUrl;
    }
    return `${customUrl}/api/cividge-kv`;
  }
  return "";
}

function getKvDeliveryBaseDomain() {
  // 🌟 ユーザーが指定・選択している「画像の公開・配信URL (STEP 1)」を最優先で使用！
  const selectedDomain = getSelectedR2Domain();
  if (selectedDomain && selectedDomain.trim()) {
    return selectedDomain.trim().replace(/\/$/, "");
  }
  const customUrl = getCustomKvWorkerUrl();
  if (customUrl) {
    // 末尾の /api/cividge-kv または /api/ipfs-kv があれば除去して配信オリジンを取得
    return customUrl.replace(/\/api\/(cividge-kv|ipfs-kv)\/?$/, "");
  }
  return (typeof window !== "undefined" ? window.location.origin : "").replace(/\/$/, "");
}

function getAdminApiToken() {
  return (localStorage.getItem("adminApiToken") || adminApiToken?.value || "").trim();
}

function hasAdminAccess() {
  // 🛡️ KV台帳モード: 管理者トークン (Admin Token) と KV Worker URL が設定されている場合に有効化
  const custom = getCustomKvWorkerUrl();
  const token = getAdminApiToken();
  return Boolean(token && custom);
}

async function registerKvCid(key, cid = "", size = 0, mime = "", s3Key = "", password = "", blobOrBytes = null, ttl = 0, expiresAt = null, unpinned = false, kuboStatus = null, allowedHost = null, overwriteAllowedHost = false, thumbnailKey = null, width = null, height = null, civitaiTemporary = undefined, contentCid = null, backend = null) {
  if (!key) return;
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();

  // 🛡️ KV連携が有効でない（トークンも独自Workerもない）場合、中央KVへの登録はスキップする。
  if (!hasAdminAccess()) {
    console.log(`[責任分離] 一般ユーザーモードのため、中央KVへの登録をスキップしました: ${key}`);
    return;
  }
  try {
    const payload = { key, cid: cid || "", size, mime, s3Key: s3Key || key };
    if (contentCid) payload.contentCid = contentCid;
    if (backend) payload.backend = backend;
    // Civitai 転送専用の短期置き場だけを、次回の明示更新で回収できるようにする。
    // undefined は既存レコードの印を維持するため、通常のメタデータ更新では送らない。
    if (civitaiTemporary !== undefined) payload.civitaiTemporary = Boolean(civitaiTemporary);
    if (thumbnailKey) payload.thumbnailKey = thumbnailKey;
    const numericWidth = Math.floor(Number(width));
    const numericHeight = Math.floor(Number(height));
    if (numericWidth > 0 && numericHeight > 0) {
      payload.width = numericWidth;
      payload.height = numericHeight;
    }
    if (unpinned) {
      payload.unpinned = true;
    }
    if (kuboStatus) {
      payload.kuboStatus = kuboStatus;
      payload.lastKuboPinAttempt = Date.now();
    }
    if (allowedHost !== null && allowedHost !== undefined) {
      // 🌐 配信ドメイン制限（特定のドメインのみで配信し、他ドメインでのアクセスを404遮断）
      const cleanHost = String(allowedHost).trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0];
      if (cleanHost) payload.allowedHost = cleanHost;
      if (overwriteAllowedHost) payload.overwriteAllowedHost = true;
    }
    if (ttl !== null && ttl !== undefined) {
      if (ttl > 0) {
        payload.ttl = ttl;
        payload.expiresAt = expiresAt || (Date.now() + ttl * 1000);
        try {
          const ttlMap = JSON.parse(localStorage.getItem("fileTtlMap") || "{}");
          ttlMap[key] = { ttl, expiresAt: payload.expiresAt };
          localStorage.setItem("fileTtlMap", JSON.stringify(ttlMap));
        } catch (e) {}
      } else if (expiresAt && Number(expiresAt) > 0) {
        // 保存先の状態更新時は継続時間を復元できない場合がある。絶対期限を優先する。
        payload.expiresAt = Number(expiresAt);
        try {
          const ttlMap = JSON.parse(localStorage.getItem("fileTtlMap") || "{}");
          ttlMap[key] = { ttl: 0, expiresAt: payload.expiresAt };
          localStorage.setItem("fileTtlMap", JSON.stringify(ttlMap));
        } catch (e) {}
      } else {
        // ⏳ 0 または無期限化: KV側にも明示的に解除を指示
        payload.ttl = 0;
        payload.expiresAt = 0;
        payload.clearTtl = true;
        try {
          const ttlMap = JSON.parse(localStorage.getItem("fileTtlMap") || "{}");
          delete ttlMap[key];
          localStorage.setItem("fileTtlMap", JSON.stringify(ttlMap));
        } catch (e) {}
      }
    }
    if (password && typeof password === "string" && password.trim().length > 0) {
      payload.password = password.trim();
    }
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 409 || errData.code === "CID_CONFLICT") {
        throw new Error(`同名ファイル「${key}」が別の内容で既に登録されています。ファイル名を変更してください。`);
      }
      throw new Error(errData.error || `KV登録エラー (${res.status})`);
    }
    return true;
  } catch (e) {
    console.warn("Failed to register CID to KV:", e);
    throw e;
  }
}

async function deleteKvCid(key, { makeTombstone = null } = {}) {
  if (!key) return;
  if (!hasAdminAccess()) {
    console.log(`[責任分離] 一般ユーザーモードのため、KV削除をスキップしました: ${key}`);
    return;
  }
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();
  try {
    const sep = endpoint.includes("?") ? "&" : "?";
    const headers = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    let url = `${endpoint}${sep}key=${encodeURIComponent(key)}`;
    if (makeTombstone !== null && makeTombstone !== undefined) {
      url += `&make_tombstone=${makeTombstone ? "1" : "0"}`;
    }
    await fetch(url, {
      method: "DELETE",
      headers,
    });
  } catch (e) {
    console.warn("Failed to delete CID from KV:", e);
  }
}

// --- 🏠 自宅 Kubo (IPFSノード) RPC ヘルパー ---
function getKuboRpcEndpoint() {
  const custom = (localStorage.getItem("kuboRpcUrl") || kuboRpcUrl?.value || "").trim().replace(/\/$/, "");
  return custom || "http://127.0.0.1:5001";
}

const CIVITAI_TEMP_TRANSFER_STORAGE_KEY = "civitaiTemporaryTransfers";

function getCivitaiTemporaryTransfers() {
  try {
    const raw = JSON.parse(localStorage.getItem(CIVITAI_TEMP_TRANSFER_STORAGE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) {
    return {};
  }
}

function getCivitaiTemporaryTransfer(provider, key) {
  if (!key) return null;
  return getCivitaiTemporaryTransfers()[`${normalizeDeliveryProvider(provider)}:${key}`] || null;
}

function markCivitaiTemporaryTransfer(provider, key, expiresAt) {
  if (!key || !expiresAt) return;
  const records = getCivitaiTemporaryTransfers();
  records[`${normalizeDeliveryProvider(provider)}:${key}`] = { expiresAt: Number(expiresAt) };
  localStorage.setItem(CIVITAI_TEMP_TRANSFER_STORAGE_KEY, JSON.stringify(records));
}

function clearCivitaiTemporaryTransfer(provider, key) {
  if (!key) return;
  const records = getCivitaiTemporaryTransfers();
  delete records[`${normalizeDeliveryProvider(provider)}:${key}`];
  localStorage.setItem(CIVITAI_TEMP_TRANSFER_STORAGE_KEY, JSON.stringify(records));
}
const { checkKuboOnline, checkKuboPinned, pinToKubo, getKuboPinnedCids, unpinFromKubo, addFileToKubo } = createKuboClient(getKuboRpcEndpoint);

// 🏠 Kubo Pin 同期タスク追跡 & せっかち防止（離脱・リロードガード）
const activeKuboPins = new Set();

window.addEventListener("beforeunload", (e) => {
  if (activeKuboPins.size > 0) {
    e.preventDefault();
    e.returnValue = "🏠 Kubo への Pin 同期処理が実行中です。ページを離れる・更新すると同期や台帳反映が中断される可能性があります。";
    return e.returnValue;
  }
});

// [INV-CORE-001] [INV-CORE-003] 画面表示時に裏で全KuboアイテムのKVレコードをregisterKvCid()で
// 自動上書き連打する自己修復コード（healKuboPinnedKvRecords）は書き込み枠（1日1,000回）破壊防止のため完全撤去。


// 🪦 墓標（Unpin予約キュー）の回収処理
let lastKuboDrainTime = 0;
async function drainKuboTombstones() {
  if (!hasAdminAccess()) return; // KV台帳連携がない場合は墓標キューの回収を行わない
  const now = Date.now();
  if (now - lastKuboDrainTime < 60000) return; // 少なくとも60秒に1回に制限
  lastKuboDrainTime = now;
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();

  try {
    const sep = endpoint.includes("?") ? "&" : "?";
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${endpoint}${sep}tombstones=1`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    const tombstones = data.tombstones || [];
    if (tombstones.length === 0) return;

    console.log(`🪦 墓標回収（ゴーストUnpin）開始: ${tombstones.length}件の削除キューを処理中...`);
    for (const cid of tombstones) {
      try {
        await unpinFromKubo(cid);
        // KVから墓標を消去
        await fetch(`${endpoint}${sep}tombstone=${encodeURIComponent(cid)}`, {
          method: "DELETE",
          headers,
        });
        console.log(`🪦 墓標回収完了: ${cid}`);
      } catch (err) {
        console.warn(`🪦 墓標回収エラー (${cid}):`, err);
      }
    }
  } catch (e) {
    console.warn("drainKuboTombstones error:", e);
  }
}

// 🪦 S3実体削除用の墓標（Tombstone）回収処理
let lastS3DrainTime = 0;
async function drainS3Tombstones(s3, bucketName) {
  if (!hasAdminAccess() || !s3 || !bucketName) return;
  const now = Date.now();
  if (now - lastS3DrainTime < 60000) return; // 少なくとも60秒に1回に制限
  lastS3DrainTime = now;
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();

  try {
    const sep = endpoint.includes("?") ? "&" : "?";
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${endpoint}${sep}tombstones_s3=1`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    const tombstones = data.tombstonesS3 || [];
    if (tombstones.length === 0) return;

    console.log(`🪦 S3墓標回収開始: ${tombstones.length}件のS3実体削除キューを処理中...`);
    for (const s3Key of tombstones) {
      try {
        const thumbnailKey = getVideoThumbnailKey(s3Key);
        const objects = [s3Key, thumbnailKey].filter(Boolean).map(Key => ({ Key }));
        await s3.send(objects.length === 1
          ? new DeleteObjectCommand({ Bucket: bucketName, Key: s3Key })
          : new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: objects } }));
        console.log(`🗑️ S3墓標に従い実体を削除しました: ${s3Key}`);

        // KVから墓標を消去
        await fetch(`${endpoint}${sep}tombstone_s3=${encodeURIComponent(s3Key)}`, {
          method: "DELETE",
          headers,
        });
        console.log(`🪦 S3墓標回収完了: ${s3Key}`);
      } catch (err) {
        console.warn(`🪦 S3墓標回収エラー (${s3Key}):`, err);
      }
    }
  } catch (e) {
    console.warn("drainS3Tombstones error:", e);
  }
}

// ==========================================
// 🗃️ 台帳型タプル圧縮ローカルキャッシュ
// キー名を完全排除し [name, cid, size, unixSec, s3Key, backend, isFromS3, isKuboPinned]
// の配列形式で50-60%圧縮し、5MB枠内で4万件超まで収容可能
// ==========================================
const STORAGE_LEDGER_KEY_PREFIX = "cividge_ledger_";

function saveLedgerToLocalStorage(provider, contents) {
  if (!provider || !Array.isArray(contents)) return;
  try {
    const tuples = contents.map(item => [
      item.Key || item.name || "",
      item.contentCid || item.cid || item.metadata?.cid || item.metadata?.c || "",
      item.Size || item.size || 0,
      item.LastModified ? Math.floor(new Date(item.LastModified).getTime() / 1000) : (item.updated ? Math.floor(new Date(item.updated).getTime() / 1000) : 0),
      item.s3Key || item.rawKey || "",
      item.uploadedProvider || item.backend || provider,
      item.isFromS3 ? 1 : 0,
      item.metadata?.kuboStatus === "pinned" ? 1 : 0
    ]);
    localStorage.setItem(`${STORAGE_LEDGER_KEY_PREFIX}${provider}`, JSON.stringify(tuples));
  } catch (e) {
    console.warn("saveLedgerToLocalStorage error:", e);
  }
}

function loadLedgerFromLocalStorage(provider) {
  if (!provider) return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_LEDGER_KEY_PREFIX}${provider}`);
    if (!raw) return [];
    const tuples = JSON.parse(raw);
    if (!Array.isArray(tuples)) return [];
    return tuples.map(t => {
      const name = t[0] || "";
      const cid = t[1] || undefined;
      const size = t[2] || 0;
      const dateIso = t[3] ? new Date(t[3] * 1000).toISOString() : new Date().toISOString();
      const s3Key = t[4] || name;
      const backend = t[5] || provider;
      const isFromS3 = t[6] === 1;
      const isKuboPinned = t[7] === 1;
      return {
        Key: name,
        name,
        cid,
        contentCid: cid,
        Size: size,
        size,
        LastModified: dateIso,
        updated: dateIso,
        s3Key,
        rawKey: s3Key,
        uploadedProvider: backend,
        backend,
        isFromS3,
        metadata: {
          kuboStatus: isKuboPinned ? "pinned" : "not_pinned",
          cid: cid || undefined,
        },
        storageProvider: provider,
        isCached: true
      };
    });
  } catch (e) {
    console.warn("loadLedgerFromLocalStorage error:", e);
    return [];
  }
}

// 🪦 墓標回収の1日1回（24時間）低頻度ガード
const TOMBSTONE_DRAIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function maybeDrainTombstonesDaily(s3, bucketName) {
  if (!hasAdminAccess()) return;
  const lastDrainStr = localStorage.getItem("cividge_last_tombstone_drain");
  const lastDrain = lastDrainStr ? Number(lastDrainStr) : 0;
  const now = Date.now();
  if (now - lastDrain < TOMBSTONE_DRAIN_INTERVAL_MS) return;
  localStorage.setItem("cividge_last_tombstone_drain", String(now));
  console.log("🪦 前回から24時間経過したため墓標（非同期ゴミ回収キュー）を定期走査します");
  try {
    await drainKuboTombstones();
    if (s3 && bucketName) {
      await drainS3Tombstones(s3, bucketName);
    }
  } catch (err) {
    console.warn("maybeDrainTombstonesDaily error:", err);
  }
}

async function fetchKvFiles() {
  // 🛡️ KV台帳連携が有効でない場合、一覧取得はスキップ（相乗り・漏洩防止）
  if (!hasAdminAccess()) {
    return [];
  }
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();
  try {
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(endpoint, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch (e) {
    console.warn("Failed to fetch KV files:", e);
    return [];
  }
}

// --- 🌐 R2 公開・配信ドメイン管理 ---

function normalizeDeliveryProvider(provider) {
  return provider === "filebase" ? "filebase" : "r2";
}

async function fetchKvRecord(key) {
  if (!key || !hasAdminAccess()) return null;
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();
  const sep = endpoint.includes("?") ? "&" : "?";
  try {
    const res = await fetch(`${endpoint}${sep}key=${encodeURIComponent(key)}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    console.warn("Failed to fetch KV record:", e);
    return null;
  }
}

function getR2DomainList(provider = activeStorageTab) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const listKey = storageProvider === "filebase" ? "filebaseDomainList" : "r2DomainList";
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(listKey) || "[]");
  } catch (e) {
    list = [];
  }
  // 既存の共通リストは初回だけ各ストレージ用に複製して互換移行する。
  if (storageProvider === "filebase" && list.length === 0 && !localStorage.getItem(listKey)) {
    try {
      list = JSON.parse(localStorage.getItem("r2DomainList") || "[]");
      localStorage.setItem(listKey, JSON.stringify(list));
    } catch (e) {}
  }
  // cividge.pages.dev（トップ専用）は配信ドメインから除外
  list = list.filter(d => !d.includes("cividge.pages.dev"));

  // 後方互換性：旧 r2PublicDomain / r2DevDomain からの移行（未登録時のみ）
  if (storageProvider === "r2") {
    const legacyPub = (localStorage.getItem("r2PublicDomain") || "").trim();
    const legacyDev = (localStorage.getItem("r2DevDomain") || "").trim();
    if (legacyPub && !legacyPub.includes("cividge.pages.dev") && !list.includes(legacyPub)) list.push(legacyPub);
    if (legacyDev && !legacyDev.includes("cividge.pages.dev") && !list.includes(legacyDev)) list.push(legacyDev);
  }

  // 重複排除 & 空白除去
  return [...new Set(list.map(d => d.trim().replace(/\/$/, "")).filter(Boolean))];
}

function saveR2DomainList(list, provider = activeStorageTab) {
  const key = normalizeDeliveryProvider(provider) === "filebase" ? "filebaseDomainList" : "r2DomainList";
  localStorage.setItem(key, JSON.stringify(list));
}

function getSelectedR2Domain(provider = activeStorageTab) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const list = getR2DomainList(storageProvider);
  const selectedKey = storageProvider === "filebase" ? "filebaseSelectedDomain" : "r2SelectedDomain";
  const saved = (localStorage.getItem(selectedKey) || "").trim().replace(/\/$/, "");
  if (saved && list.includes(saved)) {
    return saved;
  }
  return list.length > 0 ? list[0] : "";
}

function setSelectedR2Domain(domain, provider = activeStorageTab) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const clean = (domain || "").trim().replace(/\/$/, "");
  localStorage.setItem(storageProvider === "filebase" ? "filebaseSelectedDomain" : "r2SelectedDomain", clean);
  if (storageProvider === "r2") localStorage.setItem("r2PublicDomain", clean); // 後方互換
}

// 🌐 既存のURLのオリジン（ドメイン部分）を指定のドメインに差し替える
function switchUrlDomain(originalUrl, targetDomain) {
  if (!originalUrl || !targetDomain) return originalUrl;
  try {
    const parsed = new URL(originalUrl);
    const target = new URL(targetDomain.startsWith("http") ? targetDomain : `https://${targetDomain}`);
    parsed.protocol = target.protocol;
    parsed.host = target.host;
    return parsed.toString();
  } catch (e) {
    // URLパース失敗時のフォールバック
    return originalUrl.replace(/^https?:\/\/[^/]+/, targetDomain.replace(/\/$/, ""));
  }
}

function getIpfsCidFromS3Response(output) {
  const headers = output?.$metadata?.httpHeaders || {};
  const candidate = headers["x-amz-meta-cid"] ||
    headers["x-amz-meta-ipfs-hash"] ||
    output?.Metadata?.cid ||
    output?.Metadata?.["ipfs-hash"];
  return isValidIpfsCid(candidate) ? candidate.trim() : null;
}

// FilebaseのIPFSバケットと同じUnixFS（CIDv0 / protobuf leaves）でCIDを作る。
// onlyHash + BlackHoleBlockstore により、ファイル本体やブロックをブラウザ内に保持しない。
async function calculateFilebaseCid(bytes) {
  if (!bytes?.byteLength) return null;
  const blockstore = new BlackHoleBlockstore();
  let cid = null;
  for await (const entry of importUnixFs(
    [{ path: "file", content: bytes }],
    blockstore,
    { onlyHash: true, cidVersion: 0, rawLeaves: false, wrapWithDirectory: false }
  )) {
    cid = entry.cid?.toString() || null;
  }
  return isValidIpfsCid(cid) ? cid : null;
}

// Filebaseの全オブジェクトをHEADで照合する。ListObjectsはCIDを返さないため、
// 正確な重複判定にはx-amz-meta-cidを取得する必要がある。
async function findFilebaseObjectByCid(s3, bucketName, targetCid) {
  if (!s3 || !bucketName || !targetCid) return null;

  let continuationToken = undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    const objects = page.Contents || [];

    // 既にこのブラウザで取得済みのCIDはHEADを省略する。
    for (const object of objects) {
      if (getStoredIpfsCid(object.Key) === targetCid) {
        return { key: object.Key, cid: targetCid, size: object.Size || 0 };
      }
    }

    const unresolved = objects.filter(object => !getStoredIpfsCid(object.Key));
    const batchSize = 4;
    for (let start = 0; start < unresolved.length; start += batchSize) {
      const batch = unresolved.slice(start, start + batchSize);
      const heads = await Promise.all(batch.map(async (object) => {
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: object.Key }));
          return { object, cid: getIpfsCidFromS3Response(head) };
        } catch (error) {
          console.warn(`Filebase CID lookup failed: ${object.Key}`, error);
          return { object, cid: null };
        }
      }));
      for (const { object, cid } of heads) {
        if (!cid) continue;
        storeIpfsCid(object.Key, cid);
        if (cid === targetCid) return { key: object.Key, cid, size: object.Size || 0 };
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return null;
}

// ⚡ R2 疑似CID: Web Crypto API による高速 SHA-256 コンテンツハッシュ計算
async function calculateContentHash(bytes) {
  if (!crypto || !crypto.subtle || !bytes) return null;
  try {
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    console.warn("Content hash calculation failed:", e);
    return null;
  }
}

function getR2HashMap() {
  try {
    return JSON.parse(localStorage.getItem("r2HashMap") || "{}");
  } catch (e) {
    return {};
  }
}

function getStoredR2Hash(key) {
  if (!key) return null;
  const map = getR2HashMap();
  return map[key] || null;
}

function storeR2Hash(key, hash) {
  if (!key || !hash) return;
  try {
    const map = getR2HashMap();
    map[key] = hash;
    localStorage.setItem("r2HashMap", JSON.stringify(map));
  } catch (e) {}
}

function deleteR2Hash(key) {
  if (!key) return;
  try {
    const map = getR2HashMap();
    delete map[key];
    localStorage.setItem("r2HashMap", JSON.stringify(map));
  } catch (e) {}
}

async function findR2ObjectByHash(s3, bucketName, targetHash, targetSize) {
  if (!s3 || !bucketName || !targetHash) return null;

  // KV 台帳のハッシュ/CIDキャッシュマップを構築（キー -> ハッシュ/CID）
  const kvHashMap = new Map();
  try {
    const kvFiles = await fetchKvFiles();
    for (const item of kvFiles) {
      const h = item.metadata?.contentCid || item.metadata?.c_cid || (item.metadata?.cid && item.metadata.cid !== "r2" ? item.metadata.cid : null) || item.metadata?.hash || item.metadata?.h_sha;
      if (h) {
        const sKey = item.metadata?.s3Key || item.metadata?.k_s3 || item.name;
        kvHashMap.set(sKey, h);
        kvHashMap.set(item.name, h);
      }
    }
  } catch (e) {}

  // S3 (R2) バケット内に実在するオブジェクトを走査（実在しない削除済みキーの誤検知を完全排除）
  let continuationToken = undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    }));
    const objects = page.Contents || [];

    // 1. ローカルキャッシュ または KV台帳 から既知のハッシュ/CIDを照合（通信ゼロ）
    for (const object of objects) {
      const knownHash = getStoredR2Hash(object.Key) || getStoredIpfsCid(object.Key) || kvHashMap.get(object.Key);
      if (knownHash) {
        storeR2Hash(object.Key, knownHash);
        if (knownHash === targetHash) {
          return { key: object.Key, hash: targetHash, size: object.Size || 0 };
        }
      }
    }

    // 2. ハッシュ未解決かつサイズが完全一致するものだけに絞り込み、HEAD で x-amz-meta-cid / x-amz-meta-hash を確認
    const candidateObjects = objects.filter(object => {
      const knownHash = getStoredR2Hash(object.Key) || getStoredIpfsCid(object.Key) || kvHashMap.get(object.Key);
      if (knownHash) return false;
      return targetSize ? (object.Size === targetSize) : true;
    });

    const batchSize = 4;
    for (let start = 0; start < candidateObjects.length; start += batchSize) {
      const batch = candidateObjects.slice(start, start + batchSize);
      const heads = await Promise.all(batch.map(async (object) => {
        try {
          const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: object.Key }));
          const h = head?.Metadata?.cid || head?.Metadata?.["x-amz-meta-cid"] || head?.$metadata?.httpHeaders?.["x-amz-meta-cid"] || head?.Metadata?.hash || head?.$metadata?.httpHeaders?.["x-amz-meta-hash"] || null;
          return { object, hash: h };
        } catch (error) {
          return { object, hash: null };
        }
      }));
      for (const { object, hash } of heads) {
        if (!hash) continue;
        storeR2Hash(object.Key, hash);
        if (hash === targetHash) return { key: object.Key, hash, size: object.Size || 0 };
      }
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return null;
}

function normalizeHttpsOrigin(value) {
  try {
    const parsed = new URL((value || "").trim());
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return "";
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function getPublicDeliveryBase(provider = activeStorageTab, canonicalBase = "") {
  const storageProvider = normalizeDeliveryProvider(provider);
  const canonical = normalizeHttpsOrigin(canonicalBase || getSelectedR2Domain(storageProvider));
  return canonical || (typeof window !== "undefined" ? window.location.origin.replace(/\/$/, "") : "");
}

function getPublicDeliveryUrl(name, provider = activeStorageTab, canonicalBase = "") {
  if (!name) return "";
  const baseDomain = getPublicDeliveryBase(provider, canonicalBase);
  return baseDomain ? `${baseDomain}/${encodeURIComponent(name)}` : "";
}

// CID は内部の配信解決用メタデータであり、共有・コピーする URL には含めない。
// Filebase の静的互換レイヤーを有効にした場合だけ、公開側の origin を差し替える。
function getSelectedDeliveryUrl(result) {
  if (!result?.name) return "";
  const provider = result?.uploadedProvider === "filebase" ? "filebase" : "r2";
  return getPublicDeliveryUrl(result.name, provider);
}

// 🌐 各ファイルカード専用の固定配信ドメイン管理（プルダウン変更で釣られないように完全分離）
function getFileStoredDomain(itemKey, itemDisplayName, rawAllowedHost) {
  // 1. rawKey に host:filename があればそのホストを優先
  if (itemKey && itemKey.indexOf(":") > 0 && !itemKey.startsWith("tombstone_") && !itemKey.startsWith("blob_")) {
    const host = itemKey.split(":")[0].trim();
    if (host) return host.startsWith("http") ? host : `https://${host}`;
  }
  // 2. メタデータの allowedHost / d があれば優先
  if (rawAllowedHost) {
    const host = rawAllowedHost.split(",")[0].trim();
    if (host) return host.startsWith("http") ? host : `https://${host}`;
  }
  // 3. ローカルに保存されている各ファイルの固定ドメイン
  try {
    const map = JSON.parse(localStorage.getItem("fileDomainMap") || "{}");
    if (map[itemKey]) return map[itemKey];
    if (map[itemDisplayName]) return map[itemDisplayName];
  } catch (e) {}

  // 4. 初回登録: 現在の選択ドメインをこのファイル専用に固定記録
  const current = getSelectedR2Domain();
  if (current) {
    try {
      const map = JSON.parse(localStorage.getItem("fileDomainMap") || "{}");
      map[itemKey] = current;
      if (itemDisplayName) map[itemDisplayName] = current;
      localStorage.setItem("fileDomainMap", JSON.stringify(map));
    } catch (e) {}
    return current;
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

function setFileStoredDomain(key, domain) {
  if (!key || !domain) return;
  try {
    const map = JSON.parse(localStorage.getItem("fileDomainMap") || "{}");
    map[key] = domain;
    localStorage.setItem("fileDomainMap", JSON.stringify(map));
  } catch (e) {}
}

// 🌐 各ファイルカード用の固定配信ドメインバッジ ＋ 別ドメイン追加（＋）ボタンHTML生成
function createCardDomainBadgeHtml(currentUrl, extraClass = "") {
  let currentDomain = "";
  try {
    currentDomain = new URL(currentUrl).hostname;
  } catch (e) {
    currentDomain = getSelectedR2Domain() ? new URL(getSelectedR2Domain()).hostname : "未設定";
  }

  let icon = "🌐 ";
  if (currentDomain.includes(".pages.dev")) icon = "⚡ ";
  else if (currentDomain.includes(".r2.dev")) icon = "📦 ";

  let clean = currentDomain;
  if (clean.length > 22) clean = clean.slice(0, 20) + "..";

  return `
    <div class="card-domain-badge-wrapper ${extraClass}" style="display: inline-flex; align-items: center; gap: 4px;">
      <button type="button" class="card-domain-badge copy-card-url-btn" data-url="${escapeHtml(currentUrl)}" title="クリックして配信 URL をコピー：${escapeHtml(currentUrl)}" style="height: 28px; font-size: 11px; max-width: 150px; background: rgba(56, 189, 248, 0.12); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 4px; padding: 0 7px; display: inline-flex; align-items: center; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;" target="_blank" rel="noopener noreferrer" href="${escapeHtml(currentUrl)}">
        ${icon}${escapeHtml(clean)}
      </button>
      <button type="button" class="ghost-button add-domain-alias-btn" title="このファイルの配信ドメインを増やして別カードを作成（同一CID）" style="height: 28px; width: 28px; min-width: 28px; padding: 0; font-size: 14px; font-weight: bold; color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); display: inline-flex; align-items: center; justify-content: center; border-radius: 4px;">＋</button>
    </div>
  `;
}

// ⏳ 各ファイルカード用の有効期限プルダウンHTML生成（初期状態: 0 = 削除しない）
function createCardTtlSelectHtml(expiresAt = null, extraClass = "") {
  const labels = getStorageListLabels();
  const isEnglish = getAppLanguage() === "en";
  // 現在の残り秒数を計算
  let activeValue = "0";
  if (expiresAt && Number(expiresAt) > Date.now()) {
    const diffSec = Math.round((Number(expiresAt) - Date.now()) / 1000);
    // 近いプリセットを特定、またはカスタム残時間として扱う
    if (diffSec <= 3600) activeValue = "3600";
    else if (diffSec <= 43200) activeValue = "43200";
    else if (diffSec <= 86400) activeValue = "86400";
    else if (diffSec <= 259200) activeValue = "259200";
    else activeValue = "604800";
  }

  const options = [
    { val: "0", label: labels.neverDelete },
    { val: "3600", label: isEnglish ? "⏳ Delete after 1 hour" : "⏳ 1時間後に削除" },
    { val: "43200", label: isEnglish ? "⏳ Delete after 12 hours" : "⏳ 12時間後に削除" },
    { val: "86400", label: isEnglish ? "⏳ Delete after 24 hours" : "⏳ 24時間後に削除" },
    { val: "259200", label: isEnglish ? "⏳ Delete after 3 days" : "⏳ 3日後に削除" },
    { val: "604800", label: isEnglish ? "⏳ Delete after 7 days" : "⏳ 7日後に削除" },
  ];

  let optionsHtml = "";
  options.forEach(opt => {
    const isSelected = (opt.val === activeValue) ? "selected" : "";
    optionsHtml += `<option value="${opt.val}" ${isSelected}>${opt.label}</option>`;
  });

  return `
    <select class="card-ttl-switcher ${extraClass}" title="${isEnglish ? "Set automatic deletion time" : "ファイルの自動削除期限を設定・変更する"}" style="height: 28px; font-size: 11px; max-width: 135px; background: rgba(0,0,0,0.4); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 4px; padding: 0 4px; outline: none; cursor: pointer;">
      ${optionsHtml}
    </select>
  `;
}

function renderR2DomainSelect() {
  const r2Domains = getR2DomainList("r2");
  const filebaseDomains = getR2DomainList("filebase");
  const selectedR2Domain = getSelectedR2Domain("r2");
  const selectedFilebaseDomain = getSelectedR2Domain("filebase");

  const populateSelect = (selectElem, domains, selectedDomain, emptyText) => {
    if (!selectElem) return;
    selectElem.innerHTML = "";
    if (domains.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = emptyText;
      selectElem.append(opt);
      return;
    }
    domains.forEach(domain => {
      const opt = document.createElement("option");
      opt.value = domain;
      let icon = "🌐 ";
      if (domain.includes(".pages.dev")) {
        icon = "⚡ ";
      } else if (domain.includes(".r2.dev")) {
        icon = "📦 ";
      }
      opt.textContent = `${icon}${domain}`;
      if (domain === selectedDomain) opt.selected = true;
      selectElem.append(opt);
    });
  };

  const isEnglish = getAppLanguage() === "en";
  populateSelect(r2DomainSelect, r2Domains, selectedR2Domain, isEnglish ? "-- No R2 delivery domain (add with ＋) --" : "-- R2 配信ドメインが未登録です (＋から追加) --");
  populateSelect(filebaseDomainSelect, filebaseDomains, selectedFilebaseDomain, isEnglish ? "-- No Filebase delivery domain (add with ＋) --" : "-- Filebase 配信ドメインが未登録です (＋から追加) --");
  populateSelect(quickDomainSelect, r2Domains, selectedR2Domain, isEnglish ? "-- Select R2 domain --" : "-- R2 ドメインを選択 --");
  populateSelect(quickFilebaseDomainSelect, filebaseDomains, selectedFilebaseDomain, isEnglish ? "-- Select Filebase domain --" : "-- Filebase ドメインを選択 --");

  if (r2DomainDeleteBtn) {
    r2DomainDeleteBtn.disabled = r2Domains.length === 0;
  }
  if (filebaseDomainDeleteBtn) filebaseDomainDeleteBtn.disabled = filebaseDomains.length === 0;
  updateR2CompatibilityUi();
  updateFilebaseCompatibilityUi();
  updateDomainCompatBadgeUi("r2");
  updateDomainCompatBadgeUi("filebase");
}

function updateR2CompatibilityUi() {
  if (!r2CompatibilityStatus) return;
  const isEnglish = getAppLanguage() === "en";
  const publicUrl = normalizeHttpsOrigin(getSelectedR2Domain("r2"));
  const isPagesRelay = publicUrl && new URL(publicUrl).hostname.toLowerCase().endsWith(".pages.dev");
  if (isPagesRelay) {
    const prefix = isEnglish ? i18nDict.en.r2CompatibilityConfigured : i18nDict.ja.r2CompatibilityConfigured;
    r2CompatibilityStatus.innerHTML = `✅ ${prefix}<code>${escapeHtml(publicUrl)}</code>`;
    r2CompatibilityStatus.style.color = "#86efac";
  } else {
    r2CompatibilityStatus.textContent = isEnglish ? i18nDict.en.r2CompatibilityMissing : i18nDict.ja.r2CompatibilityMissing;
    r2CompatibilityStatus.style.color = "#fcd34d";
  }
}

function updateFilebaseCompatibilityUi() {
  if (!filebaseCompatibilityStatus) return;
  const isEnglish = getAppLanguage() === "en";
  const publicUrl = normalizeHttpsOrigin(getSelectedR2Domain("filebase"));
  const isPagesRelay = publicUrl && new URL(publicUrl).hostname.toLowerCase().endsWith(".pages.dev");
  if (isPagesRelay) {
    const prefix = isEnglish ? i18nDict.en.filebaseCompatibilityConfigured : i18nDict.ja.filebaseCompatibilityConfigured;
    filebaseCompatibilityStatus.innerHTML = `✅ ${prefix}<code>${escapeHtml(publicUrl)}</code>`;
    filebaseCompatibilityStatus.style.color = "#86efac";
  } else {
    filebaseCompatibilityStatus.textContent = isEnglish ? i18nDict.en.filebaseCompatibilityMissing : i18nDict.ja.filebaseCompatibilityMissing;
    filebaseCompatibilityStatus.style.color = "#fcd34d";
  }
}

// --- R2 / Filebase 設定状態の更新 ---
function updateR2Status() {
  const r2Ok = isR2Configured();
  const fbOk = isFilebaseConfigured();

  if (cfStatus) {
    const statusParts = [];
    if (r2Ok) {
      statusParts.push(`<span style="color: #4caf50;">⚡ R2 設定済 (${escapeHtml(getBucketName("r2"))})</span>`);
    } else {
      statusParts.push(`<span style="color: var(--muted);">⚡ R2 未設定</span>`);
    }

    if (fbOk) {
      statusParts.push(`<span style="color: #38bdf8;">🪐 Filebase 設定済 (${escapeHtml(getBucketName("filebase"))})</span>`);
    } else {
      statusParts.push(`<span style="color: var(--muted);">🪐 Filebase 未設定</span>`);
    }

    cfStatus.innerHTML = statusParts.join(" &nbsp;|&nbsp; ");
  }

  if (convertUploadR2Button) {
    convertUploadR2Button.disabled = !r2Ok || (state.files.length === 0);
  }
  if (convertUploadFilebaseButton) {
    convertUploadFilebaseButton.disabled = !fbOk || (state.files.length === 0);
  }

  return r2Ok || fbOk;
}

let civitaiPaletteFiles = []; // パレット用キャッシュ

// --- 🎨 Civitai クリエイター・ギャラリー管理 ---

const CIVITAI_RESERVED_SCOPES = new Set(["__ALL__", "__NEW__"]);

function isCivitaiReservedScope(value) {
  return CIVITAI_RESERVED_SCOPES.has(String(value || "").trim());
}

function getCivitaiUserList() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem("civitaiUserList") || "[]");
  } catch (e) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  // __ALL__ / __NEW__ はクリエイター名ではなく、プルダウンの内部的な表示範囲。
  // 旧版が選択状態を誤ってリストへ混ぜた場合も、ここで静かに掃除する。
  const cleaned = [...new Set(list
    .filter(value => typeof value === "string")
    .map(value => value.trim())
    .filter(value => value && !isCivitaiReservedScope(value)))];
  if (cleaned.length !== list.length || cleaned.some((value, index) => value !== list[index])) {
    list = cleaned;
    localStorage.setItem("civitaiUserList", JSON.stringify(list));
  }
  const legacy = (localStorage.getItem("civitaiUsername") || "").trim();
  if (legacy && !isCivitaiReservedScope(legacy) && !list.includes(legacy)) {
    list.unshift(legacy);
    localStorage.setItem("civitaiUserList", JSON.stringify(list));
  }
  return list;
}

function saveCivitaiUserList(list) {
  localStorage.setItem("civitaiUserList", JSON.stringify(list));
}

function getCurrentCivitaiUser() {
  const list = getCivitaiUserList();
  if (list.length === 0) return "";
  const saved = (localStorage.getItem("civitaiUsername") || "").trim();
  // Migrate the former standalone "New only" button setting into the selector.
  if (saved === "__ALL__" && localStorage.getItem("civitaiShowNewOnly") === "true") {
    localStorage.setItem("civitaiUsername", "__NEW__");
    localStorage.removeItem("civitaiShowNewOnly");
    return "__NEW__";
  }
  if (saved === "__ALL__" || saved === "__NEW__" || list.includes(saved)) {
    return saved;
  }
  return "__ALL__";
}

function getCivitaiLastSeenMap() {
  try {
    return JSON.parse(localStorage.getItem("civitaiLastSeenMap") || "{}");
  } catch (e) {
    return {};
  }
}

function saveCivitaiLastSeenMap(map) {
  localStorage.setItem("civitaiLastSeenMap", JSON.stringify(map));
}

function updateCivitaiStatus() {
  const username = getCurrentCivitaiUser();
  if (civitaiProfileLink) {
    const isSingleUser = username && username !== "__ALL__" && username !== "__NEW__";
    civitaiProfileLink.href = isSingleUser ? `https://civitai.com/user/${encodeURIComponent(username)}/images` : "https://civitai.com";
  }
  return Boolean(username);
}

function renderCivitaiUserSelect(unreadUsers = new Set()) {
  if (!civitaiUserSelect) return;
  const list = getCivitaiUserList();
  const currentUser = getCurrentCivitaiUser();
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;

  if (list.length === 0) {
    const noCreatorText = dict.civitaiNoCreator || "(未登録 - ＋から追加)";
    civitaiUserSelect.innerHTML = `<option value="" style="background-color: #1a1c23; color: var(--muted);">${escapeHtml(noCreatorText)}</option>`;
  } else {
    const allLabel = dict.civitaiAllCreators || "🌐 すべて (新着順)";
    const isAllSelected = (currentUser === "__ALL__" || !currentUser);
    const isNewOnlySelected = currentUser === "__NEW__";
    const hasAnyUnread = unreadUsers.size > 0;
    const allPrefix = hasAnyUnread ? "🔴 " : "";
    const allOption = `<option value="__ALL__" style="background-color: #1a1c23; color: #38bdf8; font-weight: bold;"${isAllSelected ? " selected" : ""}>${allPrefix}${escapeHtml(allLabel)}</option>`;
    const newOnlyLabel = dict.civitaiNewOnly || "✨ 新着のみ";
    const newOnlyOption = `<option value="__NEW__" style="background-color: #1a1c23; color: #fbbf24; font-weight: bold;"${isNewOnlySelected ? " selected" : ""}>${hasAnyUnread ? "🔴 " : ""}${escapeHtml(newOnlyLabel)}</option>`;

    const userOptions = list.map(u => {
      const isUnread = unreadUsers.has(u);
      const prefix = isUnread ? "🔴 👤 " : "👤 ";
      const suffix = isUnread ? (lang === "en" ? " (New)" : " (新着)") : "";
      const selected = (u === currentUser && !isAllSelected) ? " selected" : "";
      return `<option value="${escapeHtml(u)}" style="background-color: #1a1c23; color: #f8fafc;"${selected}>${prefix}${escapeHtml(u)}${suffix}</option>`;
    }).join("");

    civitaiUserSelect.innerHTML = allOption + newOnlyOption + userOptions;
  }

  if (civitaiUserDeleteBtn) {
    const canDelete = Boolean(currentUser && currentUser !== "__ALL__" && currentUser !== "__NEW__");
    civitaiUserDeleteBtn.disabled = !canDelete;
    civitaiUserDeleteBtn.style.opacity = canDelete ? "1" : "0.35";
    civitaiUserDeleteBtn.style.cursor = canDelete ? "pointer" : "not-allowed";
  }

  updateCivitaiStatus();
}

let isCheckingCivitaiUnread = false;
async function checkAllCivitaiCreatorsUnread() {
  if (isCheckingCivitaiUnread) return;
  isCheckingCivitaiUnread = true;
  try {
    const list = getCivitaiUserList();
    const lastSeenMap = getCivitaiLastSeenMap();
    const unreadSet = new Set();

    await Promise.all(list.map(async (user) => {
      const lastSeenId = Number(lastSeenMap[user] || 0);
      if (!lastSeenId) return;
      try {
        const res = await fetch(`https://civitai.com/api/v1/images?username=${encodeURIComponent(user)}&limit=1&sort=Newest&browsingLevel=127&nsfw=true&_t=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        const latestItem = data.items && data.items[0];
        if (latestItem && Number(latestItem.id) > lastSeenId) {
          unreadSet.add(user);
        }
      } catch (e) {
        // network skip
      }
    }));

    renderCivitaiUserSelect(unreadSet);
  } catch (err) {
    console.debug("Civitai unread check skipped:", err);
  } finally {
    isCheckingCivitaiUnread = false;
  }
}

async function checkCivitaiItemWf(item) {
  if (!item || !item.url) return false;

  let store = {};
  try {
    store = JSON.parse(localStorage.getItem("civitaiWfMap") || "{}");
  } catch (e) {}

  if (store[item.id] !== undefined) return store[item.id];

  try {
    const res = await fetch(item.url, { headers: { Range: "bytes=0-131072" } });
    if (res.ok || res.status === 206) {
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf));
      const hasWf = (text.includes('"nodes"') && text.includes('"links"')) ||
                    (text.includes('"inputs"') && text.includes('"class_type"')) ||
                    text.includes('"workflow"');
      store[item.id] = hasWf;
      localStorage.setItem("civitaiWfMap", JSON.stringify(store));
      return hasWf;
    }
  } catch (err) {
    console.debug("Civitai WF check skipped:", err);
  }
  return false;
}

function civitaiRequestUrl(url) {
  const requestUrl = new URL(url, window.location.origin);
  requestUrl.searchParams.set("_t", String(Date.now()));
  return requestUrl.toString();
}

function mergeCivitaiItems(existingItems, incomingItems) {
  const byId = new Map(existingItems.map(item => [String(item.id), item]));
  incomingItems.forEach(item => byId.set(String(item.id), item));
  return [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function fetchAndRenderCivitaiGallery({ loadMore = false, refresh = true } = {}) {
  if (!civitaiGalleryList) return;

function createCivitaiStatsHtml(stats) {
  if (!stats) return "";
  const hearts = stats.heartCount || 0;
  const likes = stats.likeCount || 0;
  const laughs = stats.laughCount || 0;
  const cries = stats.cryCount || 0;
  const comments = stats.commentCount || 0;
  const total = hearts + likes + laughs + cries + comments;
  if (total === 0) return "";

  const badges = [];
  if (hearts > 0) {
    badges.push(`<span style="display: inline-flex; align-items: center; gap: 3px; color: #f43f5e; background: rgba(244, 63, 94, 0.12); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(244, 63, 94, 0.25); font-size: 10.5px;" title="ハート: ${hearts}">❤️ <strong>${hearts.toLocaleString()}</strong></span>`);
  }
  if (likes > 0) {
    badges.push(`<span style="display: inline-flex; align-items: center; gap: 3px; color: #38bdf8; background: rgba(56, 189, 248, 0.12); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(56, 189, 248, 0.25); font-size: 10.5px;" title="いいね: ${likes}">👍 <strong>${likes.toLocaleString()}</strong></span>`);
  }
  if (laughs > 0) {
    badges.push(`<span style="display: inline-flex; align-items: center; gap: 3px; color: #fbbf24; background: rgba(251, 191, 36, 0.12); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(251, 191, 36, 0.25); font-size: 10.5px;" title="笑い: ${laughs}">😂 <strong>${laughs.toLocaleString()}</strong></span>`);
  }
  if (cries > 0) {
    badges.push(`<span style="display: inline-flex; align-items: center; gap: 3px; color: #94a3b8; background: rgba(148, 163, 184, 0.12); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.25); font-size: 10.5px;" title="泣き: ${cries}">😢 <strong>${cries.toLocaleString()}</strong></span>`);
  }
  if (comments > 0) {
    badges.push(`<span style="display: inline-flex; align-items: center; gap: 3px; color: #a78bfa; background: rgba(167, 139, 250, 0.12); padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(167, 139, 250, 0.25); font-size: 10.5px;" title="コメント: ${comments}">💬 <strong>${comments.toLocaleString()}</strong></span>`);
  }

  return `<div class="civitai-stats-row" style="display: flex; gap: 6px; align-items: center; margin-top: 5px; flex-wrap: wrap;">${badges.join("")}</div>`;
}

  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  const list = getCivitaiUserList();
  const username = getCurrentCivitaiUser() || "__ALL__";
  const isNewOnlyScope = username === "__NEW__";
  const isAll = username === "__ALL__" || isNewOnlyScope;
  const scopeKey = `${isNewOnlyScope ? "new" : (isAll ? "all" : "user")}:${isAll ? list.join("|") : username}`;

  if (list.length === 0) {
    civitaiGalleryState.items = [];
    civitaiGalleryState.nextPages = {};
    civitaiGalleryState.scopeKey = "";
    if (civitaiLoadMoreBtn) civitaiLoadMoreBtn.style.display = "none";
    civitaiGalleryList.innerHTML = `<span class="item-meta" style="padding: 18px; color: var(--muted); text-align: center; display: block;">${escapeHtml(dict.civitaiEmptyDesc || "Civitai クリエイターが登録されていません。「＋」ボタンから気になるクリエイター名を追加してください。")}</span>`;
    return;
  }

  const hasCachedScope = civitaiGalleryState.scopeKey === scopeKey;
  if (!loadMore && refresh) {
    civitaiGalleryState.scopeKey = scopeKey;
    civitaiGalleryState.items = [];
    civitaiGalleryState.nextPages = {};
  }
  if (loadMore && !hasCachedScope) loadMore = false;

  if (refresh || loadMore || !hasCachedScope) {
    const loadingMsg = loadMore
      ? (dict.civitaiLoadingMore || "過去の投稿を読み込み中…")
      : (isAll
        ? (lang === "en" ? "Fetching newest posts from all creators..." : "登録クリエイター全員の新着を取得中...")
        : `Civitai からメディアを取得中 (${escapeHtml(username)})...`);
    civitaiGalleryList.innerHTML = `<span class="status-text" style="padding: 18px;">${escapeHtml(loadingMsg)}</span>`;
  }

  try {
    if (refresh || loadMore || !hasCachedScope) {
      if (isAll) {
        const usersToFetch = loadMore
          ? list.filter(u => civitaiGalleryState.nextPages[u])
          : list;
        const fetches = usersToFetch.map(async (u) => {
          const pageUrl = loadMore
            ? civitaiGalleryState.nextPages[u]
            : `https://civitai.com/api/v1/images?username=${encodeURIComponent(u)}&limit=25&sort=Newest&browsingLevel=127&nsfw=true`;
          if (!pageUrl) return [];
          try {
            const res = await fetch(civitaiRequestUrl(pageUrl));
            if (!res.ok) return [];
            const data = await res.json();
            civitaiGalleryState.nextPages[u] = data.metadata?.nextPage || null;
            return (data.items || []).map(it => ({ ...it, _creator: u }));
          } catch (e) {
            return [];
          }
        });
        const results = await Promise.all(fetches);
        civitaiGalleryState.items = mergeCivitaiItems(
          loadMore ? civitaiGalleryState.items : [],
          results.flat(),
        );
      } else {
        try {
          const pageUrl = loadMore
            ? civitaiGalleryState.nextPages[username]
            : `https://civitai.com/api/v1/images?username=${encodeURIComponent(username)}&limit=50&sort=Newest&browsingLevel=127&nsfw=true`;
          if (!pageUrl) return;
          const res = await fetch(civitaiRequestUrl(pageUrl));
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          const data = await res.json();
          civitaiGalleryState.nextPages[username] = data.metadata?.nextPage || null;
          civitaiGalleryState.items = mergeCivitaiItems(
            loadMore ? civitaiGalleryState.items : [],
            (data.items || []).map(it => ({ ...it, _creator: username })),
          );
        } catch (err) {
          throw err;
        }
      }
    }
    const items = civitaiGalleryState.items;

    // 新着判定
    const lastSeenMap = getCivitaiLastSeenMap();
    let newItemsCount = 0;

    if (!isAll) {
      const lastSeenId = Number(lastSeenMap[username] || 0);
      const newestId = items.length > 0 ? Number(items[0].id) : 0;
      if (lastSeenId === 0) {
        newItemsCount = items.length;
      } else if (newestId > lastSeenId) {
        newItemsCount = items.filter(it => Number(it.id) > lastSeenId).length;
      }
    } else {
      list.forEach(u => {
        const lastSeenId = Number(lastSeenMap[u] || 0);
        const uItems = items.filter(it => (it._creator || it.username || "") === u);
        if (lastSeenId === 0) {
          newItemsCount += uItems.length;
        } else {
          newItemsCount += uItems.filter(it => Number(it.id) > lastSeenId).length;
        }
      });
    }

    if (newItemsCount > 0) {
      if (civitaiNewBadge) {
        civitaiNewBadge.textContent = `🔴 ${(dict.civitaiNewBadge || "{count}件の新着").replace("{count}", newItemsCount)}`;
        civitaiNewBadge.style.display = "inline-flex";
      }
      if (civitaiMarkReadBtn) {
        civitaiMarkReadBtn.style.display = "inline-flex";
        civitaiMarkReadBtn.onclick = () => {
          // The API result is sorted by publication time, whereas unread state uses
          // Civitai IDs. Store the largest ID we received for each creator so one
          // click reliably acknowledges every displayed new item.
          const updatedLastSeenMap = getCivitaiLastSeenMap();
          const creatorsToMark = isAll ? list : [username];
          creatorsToMark.forEach((creator) => {
            const highestSeenId = items
              .filter(item => (item._creator || item.username || "") === creator)
              .reduce((highest, item) => Math.max(highest, Number(item.id) || 0), 0);
            if (highestSeenId > 0) updatedLastSeenMap[creator] = highestSeenId;
          });
          saveCivitaiLastSeenMap(updatedLastSeenMap);
          fetchAndRenderCivitaiGallery({ refresh: false });
        };
      }
    } else {
      if (civitaiNewBadge) civitaiNewBadge.style.display = "none";
      if (civitaiMarkReadBtn) civitaiMarkReadBtn.style.display = "none";
    }

    const hasMore = isAll
      ? list.some(u => Boolean(civitaiGalleryState.nextPages[u]))
      : Boolean(civitaiGalleryState.nextPages[username]);
    if (civitaiLoadMoreBtn) {
      civitaiLoadMoreBtn.style.display = hasMore ? "inline-flex" : "none";
      civitaiLoadMoreBtn.disabled = !hasMore;
      civitaiLoadMoreBtn.textContent = dict.civitaiLoadMore || "↓ 過去の投稿をさらに読み込む";
      civitaiLoadMoreBtn.onclick = () => fetchAndRenderCivitaiGallery({ loadMore: true });
    }

    const visibleItems = isNewOnlyScope
      ? items.filter(item => Number(item.id) > Number(lastSeenMap[item._creator || item.username || ""] || 0))
      : items;

    civitaiPaletteFiles = visibleItems.map(item => {
      const isVideo = item.type === "video";
      const directUrl = item.url;
      const previewSrc = isVideo ? directUrl : (directUrl.includes("/original=true/") ? directUrl.replace("/original=true/", "/width=450/") : directUrl);
      return {
        key: `Civitai ID:${item.id}`,
        url: directUrl,
        previewUrl: previewSrc,
        isVideo,
        isCivitai: true,
      };
    });
    renderUrlPalette();

    civitaiGalleryList.className = "result-list civitai-grid";
    civitaiGalleryList.innerHTML = "";
    if (visibleItems.length === 0) {
      const emptyText = isNewOnlyScope
        ? (dict.civitaiNoNewItems || "新着の投稿はありません。")
        : (lang === "en" ? "No media posts found on Civitai." : "Civitai に投稿されたメディアが見つかりませんでした。");
      civitaiGalleryList.innerHTML = `<span class="item-meta" style="padding: 18px; text-align: center;">${escapeHtml(emptyText)}</span>`;
      return;
    }

    visibleItems.forEach(item => {
      const itemCreator = item._creator || item.username || "";
      const lastSeenId = Number(lastSeenMap[itemCreator] || 0);
      const isNewItem = (lastSeenId > 0 && Number(item.id) > lastSeenId);
      const article = document.createElement("article");
      article.className = "civitai-card";

      const isVideo = item.type === "video";
      const directUrl = item.url;
      const civitaiPostPageUrl = `https://civitai.com/images/${item.id}`;

      let thumbHtml = "";
      if (isVideo) {
        thumbHtml = `
          <video src="${escapeHtml(directUrl)}" preload="metadata" muted playsinline loop style="pointer-events: none;"></video>
          <div class="civitai-video-play-indicator">▶</div>
        `;
      } else {
        const previewSrc = directUrl.includes("/original=true/") ? directUrl.replace("/original=true/", "/width=450/") : directUrl;
        thumbHtml = `<img alt="" src="${escapeHtml(previewSrc)}" loading="lazy">`;
      }

      const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleDateString() : "";
      const dimensions = item.width && item.height ? `${item.width}×${item.height}` : "";

      const creatorTagHtml = itemCreator
        ? `<button type="button" class="civitai-creator-tag" data-username="${escapeHtml(itemCreator)}" title="${escapeHtml(itemCreator)} の投稿だけに絞り込む">👤 ${escapeHtml(itemCreator)}</button>`
        : `<span></span>`;

      const civitaiPrompt = item.meta?.prompt;
      if (civitaiPrompt) {
        civitaiPromptsMap[item.id] = civitaiPrompt;
      }

      const promptBtnHtml = civitaiPrompt
        ? `<button type="button" class="ghost-button civitai-prompt-btn" data-id="${item.id}" style="height: 30px; font-size: 11px; padding: 0 8px; color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); display: inline-flex; align-items: center; gap: 3px;" title="生成プロンプトをコピー">📝 ${escapeHtml(dict.civitaiPrompt || "プロンプト")}</button>`
        : "";

      article.innerHTML = `
        <div class="civitai-card-media-wrap" style="position: relative; width: 100%; aspect-ratio: 3 / 4; background: #090a0f; overflow: hidden;">
          <a href="${escapeHtml(directUrl)}" target="_blank" rel="noopener noreferrer" class="civitai-card-media" title="直リンクを表示">
            ${thumbHtml}
          </a>
          <div class="civitai-card-overlay-top">
            ${creatorTagHtml}
            <div class="civitai-card-badges-col">
              ${isNewItem ? `<span class="civitai-new-item-badge" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(239, 68, 68, 0.9); backdrop-filter: blur(4px); color: #fff; border: 1px solid rgba(239, 68, 68, 0.5); font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">✨ NEW</span>` : ""}
              ${isVideo ? `<span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(14, 165, 233, 0.9); backdrop-filter: blur(4px); color: #fff; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">🎬 VIDEO</span>` : ""}
              <span class="civitai-wf-badge-placeholder" data-id="${item.id}"></span>
              ${item.nsfwLevel && item.nsfwLevel !== "None" ? `<span style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: rgba(244, 63, 94, 0.9); backdrop-filter: blur(4px); color: #fff; font-weight: bold; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${escapeHtml(item.nsfwLevel)}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="civitai-card-body">
          <div class="civitai-card-meta-row">
            <span class="item-id">#${escapeHtml(String(item.id))}</span>
            <span style="font-size: 10.5px;">${escapeHtml(dateStr)} ${dimensions ? `· ${escapeHtml(dimensions)}` : ""}</span>
          </div>
          <div class="civitai-card-stats">
            ${createCivitaiStatsHtml(item.stats)}
          </div>
          <div class="civitai-card-actions">
            ${promptBtnHtml}
            <button type="button" class="ghost-button civitai-copy-btn" data-url="${escapeHtml(directUrl)}" style="flex: 1; height: 30px; font-size: 11px; padding: 0 8px; justify-content: center;">📋 ${escapeHtml(dict.copyUrl || "URLコピー")}</button>
            <a href="${escapeHtml(civitaiPostPageUrl)}" target="_blank" rel="noopener noreferrer" class="ghost-button civitai-post-link" style="height: 30px; font-size: 11px; padding: 0 8px; text-decoration: none; display: inline-flex; align-items: center; justify-content: center;" title="Civitai で投稿の編集・削除・確認を行う">Civitai ↗</a>
          </div>
        </div>
      `;

      if (isVideo) {
        const videoEl = article.querySelector("video");
        if (videoEl) {
          article.addEventListener("mouseenter", () => {
            videoEl.play().catch(() => {});
          });
          article.addEventListener("mouseleave", () => {
            videoEl.pause();
          });
        }
      }

      civitaiGalleryList.append(article);

      checkCivitaiItemWf(item).then(hasWf => {
        if (hasWf) {
          const badgePlaceholder = article.querySelector('.civitai-wf-badge-placeholder');
          if (badgePlaceholder) {
            badgePlaceholder.innerHTML = '<span class="meta-badge" style="background: rgba(16, 185, 129, 0.9); backdrop-filter: blur(4px); color: #fff; border: 1px solid rgba(16, 185, 129, 0.6); font-size: 9.5px; padding: 2px 6px; border-radius: 4px; font-weight: 600; box-shadow: 0 2px 4px rgba(0,0,0,0.3);" title="ComfyUIワークフローが完全な形で含まれています。">🧬 WF</span>';
          }
        }
      });
    });

    // ✨ 案A: 「新着のみ」または個別クリエイターで画面に表示されたアイテムを自動既読化
    // （現在の画面ではそのまま閲覧でき、次回「更新」を押した時や次回アクセス時に表示されなくなる）
    if (visibleItems.length > 0) {
      const updatedLastSeen = getCivitaiLastSeenMap();
      let hasUpdate = false;
      const targetCreators = (!isAll) ? [username] : (isNewOnlyScope ? list : []);
      targetCreators.forEach(creator => {
        const creatorItems = visibleItems.filter(it => (it._creator || it.username || "") === creator);
        if (creatorItems.length > 0) {
          const highest = creatorItems.reduce((max, it) => Math.max(max, Number(it.id) || 0), 0);
          const current = Number(updatedLastSeen[creator] || 0);
          if (highest > current) {
            updatedLastSeen[creator] = highest;
            hasUpdate = true;
          }
        }
      });
      if (hasUpdate) {
        saveCivitaiLastSeenMap(updatedLastSeen);
      }
    }

    checkAllCivitaiCreatorsUnread();

  } catch (err) {
    console.error("Civitai gallery fetch error:", err);
    civitaiGalleryList.innerHTML = `<span class="item-meta error" style="padding: 18px; color: var(--danger);">Civitai ギャラリーの取得に失敗しました: ${escapeHtml(err.message)}</span>`;
  }
}

// --- 設定の読み込みと初期化 ---
function loadSettings() {
  const savedProvider = localStorage.getItem("storageProvider") || "r2";
  if (savedProvider === "filebase") {
    if (providerFilebase) providerFilebase.checked = true;
  } else {
    if (providerR2) providerR2.checked = true;
  }

  const savedAccount   = localStorage.getItem("r2AccountId") || "";
  const savedBucket    = localStorage.getItem("r2BucketName") || "";
  const savedKeyId     = localStorage.getItem("r2AccessKeyId") || "";
  const savedSecret    = localStorage.getItem("r2SecretAccessKey") || "";
  const savedPublic    = localStorage.getItem("r2PublicDomain") || "";
  const savedDev       = localStorage.getItem("r2DevDomain") || "";

  const savedFbBucket  = localStorage.getItem("filebaseBucket") || "";
  const savedFbKeyId   = localStorage.getItem("filebaseApiKey") || "";
  const savedFbSecret  = localStorage.getItem("filebaseSecretKey") || "";

  if (r2AccountId) r2AccountId.value = savedAccount;
  if (r2BucketName) r2BucketName.value = savedBucket;
  if (r2AccessKeyId) r2AccessKeyId.value = savedKeyId;
  if (r2SecretAccessKey) r2SecretAccessKey.value = savedSecret;

  if (filebaseBucket) filebaseBucket.value = savedFbBucket;
  if (filebaseApiKey) filebaseApiKey.value = savedFbKeyId;
  if (filebaseSecretKey) filebaseSecretKey.value = savedFbSecret;

  renderR2DomainSelect();
  updateFilebaseCompatibilityUi();
  updateR2Status();
  renderCivitaiUserSelect();
  updateCivitaiStatus();

  const savedEnableConvert = localStorage.getItem("enableConvert");
  if (savedEnableConvert !== null && enableConvertCheck) {
    enableConvertCheck.checked = savedEnableConvert === "true";
  }
  if (convertSettingsArea && enableConvertCheck) {
    convertSettingsArea.classList.toggle("is-disabled-area", !enableConvertCheck.checked);
  }

  const savedEnableRename = localStorage.getItem("enableRename");
  if (savedEnableRename !== null && enableRenameCheck) {
    enableRenameCheck.checked = savedEnableRename === "true";
  }
  if (renameSettingsArea && enableRenameCheck) {
    renameSettingsArea.classList.toggle("is-disabled-area", !enableRenameCheck.checked);
  }

  const savedEnableZip = localStorage.getItem("enableZip");
  if (savedEnableZip !== null && enableZipCheck) {
    enableZipCheck.checked = savedEnableZip === "true";
  }

  const savedFormat = localStorage.getItem("formatSelect");
  if (savedFormat && extensions[savedFormat] && formatSelect) {
    formatSelect.value = savedFormat;
  }

  const savedQuality = localStorage.getItem("qualityRange");
  if (savedQuality) {
    if (qualityRange) qualityRange.value = savedQuality;
    if (qualityOutput) qualityOutput.textContent = savedQuality;
  }

  const savedRename = localStorage.getItem("renamePattern");
  if (savedRename && renamePattern) {
    renamePattern.value = savedRename;
  }

  syncStorageLimitControl();

  syncAutoFifoControl();

  // 🏠 Kubo設定ロード
  const savedKuboUrl = localStorage.getItem("kuboRpcUrl") || "http://127.0.0.1:5001";
  if (kuboRpcUrl) kuboRpcUrl.value = savedKuboUrl;
  const savedKuboAutoPinR2 = localStorage.getItem("kuboAutoPinR2");
  if (kuboAutoPinR2Check) kuboAutoPinR2Check.checked = savedKuboAutoPinR2 !== "false"; // デフォルトでON
  const savedKuboAutoPin = localStorage.getItem("kuboAutoPin");
  if (kuboAutoPinCheck) kuboAutoPinCheck.checked = savedKuboAutoPin !== "false"; // デフォルトでON
  const savedKuboPrioritizePinned = localStorage.getItem("kuboPrioritizePinned");
  if (kuboPrioritizePinned) kuboPrioritizePinned.checked = savedKuboPrioritizePinned !== "false"; // デフォルトでON

  // 🛡️ KV台帳・管理者トークン設定ロード
  const savedKvUrl = localStorage.getItem("kvWorkerUrl") || "";
  if (kvWorkerUrl) kvWorkerUrl.value = savedKvUrl;
  const savedAdminToken = localStorage.getItem("adminApiToken") || "";
  if (adminApiToken) adminApiToken.value = savedAdminToken;
  updateAdminTokenStatusUI();

  loadTemplates();
}

function loadTemplates(selectedValue = "") {
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  let savedTemplates = {};
  try {
    savedTemplates = JSON.parse(localStorage.getItem("composerTemplates") || "{}");
  } catch (e) {
    savedTemplates = {};
  }
  
  const templates = { ...defaultTemplates, ...savedTemplates };
  if (!templateSelect) return;
  
  templateSelect.innerHTML = `<option value="">${escapeHtml(dict.promptSelect)}</option>`;
  for (const [key, item] of Object.entries(templates)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.dataset.text = item.text;
    opt.textContent = item.name;
    templateSelect.append(opt);
  }

  const optCustom = document.createElement("option");
  optCustom.value = "__new__";
  optCustom.textContent = dict.promptNew;
  templateSelect.append(optCustom);

  if (selectedValue) {
    templateSelect.value = selectedValue;
  }
}

// --- 🔐 PINコードによる暗号化/復号化 ---
function encryptPayloadWithPin(payloadObj, pin) {
  const jsonStr = JSON.stringify(payloadObj);
  const utf8Bytes = new TextEncoder().encode(jsonStr);
  const pinBytes = new TextEncoder().encode(pin);
  const xorBytes = new Uint8Array(utf8Bytes.length);
  for (let i = 0; i < utf8Bytes.length; i++) {
    xorBytes[i] = utf8Bytes[i] ^ pinBytes[i % pinBytes.length];
  }
  let binStr = "";
  for (let i = 0; i < xorBytes.length; i++) {
    binStr += String.fromCharCode(xorBytes[i]);
  }
  return btoa(binStr);
}

function decryptPayloadWithPin(encodedStr, pin) {
  try {
    const binStr = atob(encodedStr);
    const xorBytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      xorBytes[i] = binStr.charCodeAt(i);
    }
    const pinBytes = new TextEncoder().encode(pin);
    const utf8Bytes = new Uint8Array(xorBytes.length);
    for (let i = 0; i < xorBytes.length; i++) {
      utf8Bytes[i] = xorBytes[i] ^ pinBytes[i % pinBytes.length];
    }
    const decodedStr = new TextDecoder().decode(utf8Bytes);
    return JSON.parse(decodedStr);
  } catch {
    return null;
  }
}

function generateRandom6DigitPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// --- 🗜️ 同期ペイロード圧縮 & 解凍 (QRコード / 短縮URL用) ---
function compressPayloadSync(str) {
  try {
    const buf = fflate.strToU8(str);
    const def = fflate.deflateSync(buf, { level: 9 });
    let bin = "";
    for (let i = 0; i < def.length; i++) {
      bin += String.fromCharCode(def[i]);
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch (err) {
    console.warn("compressPayloadSync fallback:", err);
    return btoa(encodeURIComponent(str));
  }
}

function decompressPayloadSync(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    u8[i] = bin.charCodeAt(i);
  }
  const inf = fflate.inflateSync(u8);
  return fflate.strFromU8(inf);
}

// --- 📦 アプリ統合データのエクスポート & インポート (R2 / Civitai / 変換設定) ---

function buildAppExportPayload() {
  const accountId       = (localStorage.getItem("r2AccountId") || r2AccountId?.value || "").trim();
  const bucketName      = (localStorage.getItem("r2BucketName") || r2BucketName?.value || "").trim();
  const accessKeyId     = (localStorage.getItem("r2AccessKeyId") || r2AccessKeyId?.value || "").trim();
  const secretAccessKey = (localStorage.getItem("r2SecretAccessKey") || r2SecretAccessKey?.value || "").trim();
  const publicDomain    = (localStorage.getItem("r2PublicDomain") || r2PublicDomain?.value || "").trim();
  const devDomain       = (localStorage.getItem("r2DevDomain") || r2DevDomain?.value || "").trim();

  // Filebase
  const fbBucket = (localStorage.getItem("filebaseBucket") || filebaseBucket?.value || "").trim();
  const fbKeyId  = (localStorage.getItem("filebaseApiKey") || filebaseApiKey?.value || "").trim();
  const fbSecret = (localStorage.getItem("filebaseSecretKey") || filebaseSecretKey?.value || "").trim();

  // Kubo
  const kUrl     = (localStorage.getItem("kuboRpcUrl") || kuboRpcUrl?.value || "").trim();
  const kAutoPinR2 = localStorage.getItem("kuboAutoPinR2");
  const kAutoPin = localStorage.getItem("kuboAutoPin");
  const kPrioritizePinned = localStorage.getItem("kuboPrioritizePinned");

  // KV Worker
  const kvUrl    = (localStorage.getItem("kvWorkerUrl") || kvWorkerUrl?.value || "").trim();
  const kvToken  = (localStorage.getItem("adminApiToken") || adminApiToken?.value || "").trim();

  const currentCivitaiUser = getCurrentCivitaiUser();
  const civitaiUserList = getCivitaiUserList();
  const domainList = getR2DomainList();
  const selectedDomain = getSelectedR2Domain();
  const filebaseDomainList = getR2DomainList("filebase");
  const selectedFilebaseDomain = getSelectedR2Domain("filebase");
  const storageProvider = localStorage.getItem("storageProvider") || "r2";

  const payload = { v: 4 };
  if (storageProvider) payload.sp = storageProvider;
  if (accountId) payload.a = accountId;
  if (bucketName) payload.b = bucketName;
  if (accessKeyId) payload.k = accessKeyId;
  if (secretAccessKey) payload.s = secretAccessKey;
  if (publicDomain) payload.p = publicDomain;
  if (devDomain) payload.d = devDomain;
  if (domainList.length > 0) payload.dl = domainList;
  if (selectedDomain) payload.ds = selectedDomain;
  if (filebaseDomainList.length > 0) payload.fdl = filebaseDomainList;
  if (selectedFilebaseDomain) payload.fds = selectedFilebaseDomain;

  if (fbBucket) payload.fb = fbBucket;
  if (fbKeyId) payload.fk = fbKeyId;
  if (fbSecret) payload.fs = fbSecret;

  if (kUrl) payload.ku = kUrl;
  if (kAutoPinR2 !== null) payload.kpr2 = (kAutoPinR2 !== "false");
  if (kAutoPin !== null) payload.kp = (kAutoPin !== "false");
  if (kPrioritizePinned !== null) payload.kpp = (kPrioritizePinned !== "false");

  if (kvUrl) payload.kv = kvUrl;
  if (kvToken) payload.kt = kvToken;

  if (currentCivitaiUser) payload.cu = currentCivitaiUser;
  if (civitaiUserList.length > 0) payload.cul = civitaiUserList;

  const enableConvert = localStorage.getItem("enableConvert");
  if (enableConvert !== null) payload.conv = (enableConvert === "true");

  const enableRename = localStorage.getItem("enableRename");
  if (enableRename !== null) payload.ren = (enableRename === "true");
  const pattern = localStorage.getItem("renamePattern");
  if (pattern) payload.pat = pattern;

  return payload;
}

function applyAppImportPayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  let hasRestoredAny = false;

  // 0. ストレージプロバイダー設定
  if (payload.sp) {
    localStorage.setItem("storageProvider", payload.sp);
    if (payload.sp === "filebase") {
      if (providerFilebase) providerFilebase.checked = true;
    } else {
      if (providerR2) providerR2.checked = true;
    }
    hasRestoredAny = true;
  }

  // 1. R2 接続設定
  if (payload.a && payload.b && payload.k && payload.s) {
    localStorage.setItem("r2AccountId", payload.a);
    localStorage.setItem("r2BucketName", payload.b);
    localStorage.setItem("r2AccessKeyId", payload.k);
    localStorage.setItem("r2SecretAccessKey", payload.s);
    if (payload.p) localStorage.setItem("r2PublicDomain", payload.p);
    if (payload.d) localStorage.setItem("r2DevDomain", payload.d);

    if (r2AccountId) r2AccountId.value = payload.a;
    if (r2BucketName) r2BucketName.value = payload.b;
    if (r2AccessKeyId) r2AccessKeyId.value = payload.k;
    if (r2SecretAccessKey) r2SecretAccessKey.value = payload.s;
    hasRestoredAny = true;
  }

  // 1.1 R2 配信ドメインリスト復元
  if (Array.isArray(payload.dl) && payload.dl.length > 0) {
    saveR2DomainList(payload.dl);
    if (payload.ds) setSelectedR2Domain(payload.ds);
    renderR2DomainSelect();
    hasRestoredAny = true;
  }
  if (Array.isArray(payload.fdl) && payload.fdl.length > 0) {
    saveR2DomainList(payload.fdl, "filebase");
    if (payload.fds) setSelectedR2Domain(payload.fds, "filebase");
    hasRestoredAny = true;
  }
  // 1.2 Filebase 接続設定
  if (payload.fb && payload.fk && payload.fs) {
    localStorage.setItem("filebaseBucket", payload.fb);
    localStorage.setItem("filebaseApiKey", payload.fk);
    localStorage.setItem("filebaseSecretKey", payload.fs);
    if (filebaseBucket) filebaseBucket.value = payload.fb;
    if (filebaseApiKey) filebaseApiKey.value = payload.fk;
    if (filebaseSecretKey) filebaseSecretKey.value = payload.fs;
    hasRestoredAny = true;
  }

  // 1.3 自宅 Kubo 設定
  if (payload.ku) {
    localStorage.setItem("kuboRpcUrl", payload.ku);
    if (kuboRpcUrl) kuboRpcUrl.value = payload.ku;
    hasRestoredAny = true;
  }
  if (payload.kpr2 !== undefined) {
    localStorage.setItem("kuboAutoPinR2", String(payload.kpr2));
    if (kuboAutoPinR2Check) kuboAutoPinR2Check.checked = Boolean(payload.kpr2);
  }
  if (payload.kp !== undefined) {
    localStorage.setItem("kuboAutoPin", String(payload.kp));
    if (kuboAutoPinCheck) kuboAutoPinCheck.checked = Boolean(payload.kp);
  }
  if (payload.kpp !== undefined) {
    localStorage.setItem("kuboPrioritizePinned", String(payload.kpp));
    if (kuboPrioritizePinned) kuboPrioritizePinned.checked = Boolean(payload.kpp);
  }

  // 1.4 KV台帳 Worker & トークン
  if (payload.kv) {
    localStorage.setItem("kvWorkerUrl", payload.kv);
    if (kvWorkerUrl) kvWorkerUrl.value = payload.kv;
    hasRestoredAny = true;
  }
  if (payload.kt) {
    localStorage.setItem("adminApiToken", payload.kt);
    if (adminApiToken) adminApiToken.value = payload.kt;
    hasRestoredAny = true;
  }
  updateAdminTokenStatusUI();

  // 2. Civitai 設定
  if (Array.isArray(payload.cul) && payload.cul.length > 0) {
    localStorage.setItem("civitaiUserList", JSON.stringify(payload.cul));
    hasRestoredAny = true;
  }
  if (payload.cu) {
    localStorage.setItem("civitaiUsername", payload.cu);
    hasRestoredAny = true;
  } else if (Array.isArray(payload.cul) && payload.cul.length > 0) {
    localStorage.setItem("civitaiUsername", payload.cul[0]);
    hasRestoredAny = true;
  }

  // 3. 変換・リネーム設定
  if (payload.conv !== undefined) {
    localStorage.setItem("enableConvert", String(payload.conv));
    if (enableConvertCheck) enableConvertCheck.checked = Boolean(payload.conv);
  }
  if (payload.ren !== undefined) {
    localStorage.setItem("enableRename", String(payload.ren));
    if (enableRenameCheck) enableRenameCheck.checked = Boolean(payload.ren);
  }
  if (payload.pat) {
    localStorage.setItem("renamePattern", payload.pat);
    if (renamePattern) renamePattern.value = payload.pat;
  }

  // 4. IPFS CID 対応表の同期復元
  if (payload.cm && typeof payload.cm === "object") {
    try {
      const curMap = JSON.parse(localStorage.getItem("ipfsCidMap") || "{}");
      localStorage.setItem("ipfsCidMap", JSON.stringify({ ...curMap, ...payload.cm }));
      hasRestoredAny = true;
    } catch (e) {}
  }

  // UI へ再反映
  loadSettings();
  renderCivitaiUserSelect();
  fetchAndRenderCivitaiGallery();
  updateR2Status();
  updateCivitaiStatus();

  // ☁️ 復元後に自動保存 & ファイル一覧同期を確実に実行
  if (hasRestoredAny) {
    saveR2SettingsAuto();
    fetchAndRenderR2Files();
  }

  return hasRestoredAny;
}

// PINコード付き暗号化バックアップURLの発行
async function generatePinBackupUrl() {
  // 💾 バックアップ発行前に最新の入力状態を自動で一回保存
  saveR2SettingsAuto();

  const payload = buildAppExportPayload();
  const hasData = payload.a || payload.fb || payload.kv || payload.ku || payload.cu || (payload.cul && payload.cul.length > 0) || (payload.dl && payload.dl.length > 0);
  if (!hasData) {
    alert("⚠️ バックアップする設定（クラウドストレージ接続設定またはCivitaiクリエイターリスト）がありません。");
    return;
  }

  const autoPin = generateRandom6DigitPin();
  const encrypted = encryptPayloadWithPin(payload, autoPin);
  const backupUrl = `${window.location.origin}${window.location.pathname}#enc=${encrypted}`;

  try {
    await navigator.clipboard.writeText(backupUrl);
  } catch (err) {
    console.error("Clipboard copy error:", err);
  }

  const pinDisplayModal = document.querySelector("#pinDisplayModal");
  const generatedPinText = document.querySelector("#generatedPinText");
  const backupUrlTextarea = document.querySelector("#backupUrlTextarea");

  if (generatedPinText) generatedPinText.textContent = autoPin;
  if (backupUrlTextarea) backupUrlTextarea.value = backupUrl;
  if (pinDisplayModal) pinDisplayModal.style.display = "grid";
}

let pendingEncryptedHash = "";

function checkAndApplyHashSync() {
  try {
    const hash = window.location.hash || "";
    if (!hash) return;

    // 🛡️ セキュリティ保護: 機密情報を含むハッシュを読み取った直後に即座にURL欄から消去
    // 誤ってブックマークされたり、URLバーからコピー・共有されるのを完全に防止
    if (hash.startsWith("#enc=") || hash.startsWith("#sync=") || hash.startsWith("#cfg=")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    if (hash.startsWith("#enc=")) {
      pendingEncryptedHash = hash.replace("#enc=", "");
      const pinModal = document.querySelector("#pinModal");
      const pinInput = document.querySelector("#pinInput");
      const pinErrorNotice = document.querySelector("#pinErrorNotice");
      if (pinInput) pinInput.value = "";
      if (pinErrorNotice) pinErrorNotice.textContent = "";
      if (pinModal) pinModal.style.display = "grid";
      return;
    }

    if (hash.startsWith("#sync=") || hash.startsWith("#cfg=")) {
      const prefix = hash.startsWith("#sync=") ? "#sync=" : "#cfg=";
      const rawParam = hash.replace(prefix, "").trim();
      if (rawParam) {
        let payload = null;

        // 1. 新方式: 圧縮形式 (プレフィックス "z." または deflate 解凍試行)
        if (rawParam.startsWith("z.")) {
          try {
            const jsonStr = decompressPayloadSync(rawParam.slice(2));
            payload = JSON.parse(jsonStr);
          } catch (e) {
            console.warn("Deflate decompression failed with z. prefix:", e);
          }
        }

        // 2. プレフィックスなし、または旧方式フォールバック
        if (!payload) {
          // まず deflate 試行
          try {
            const jsonStr = decompressPayloadSync(rawParam);
            payload = JSON.parse(jsonStr);
          } catch (e1) {
            // 次に従来の Base64 / URIEncoded 復元を試行
            const normalized = rawParam.replace(/ /g, "+");
            try {
              payload = JSON.parse(decodeURIComponent(atob(normalized)));
            } catch (e2) {
              try {
                payload = JSON.parse(atob(normalized));
              } catch (e3) {
                try {
                  payload = JSON.parse(decodeURIComponent(rawParam));
                } catch (e4) {}
              }
            }
          }
        }

        if (payload && applyAppImportPayload(payload)) {
          history.replaceState(null, "", window.location.pathname + window.location.search);
          setTimeout(() => {
            alert("🎉 設定の引き継ぎが完了しました！すべての接続情報・設定が正常に反映されました。");
          }, 300);
        }
      }
    }
  } catch (err) {
    console.error("Failed to parse sync hash:", err);
  }
}

// 起動時の初期ロード & ハッシュ同期チェック
checkAndApplyHashSync();
loadSettings();
setAppLanguage(getAppLanguage());
updateR2Status();
fetchAndRenderR2Files();
fetchAndRenderCivitaiGallery();

// --- イベントリスナー: R2 設定自動保存 ---
let r2AutoFetchTimer = null;

function saveR2SettingsAuto() {
  s3ClientR2 = null;
  s3ClientFilebase = null;

  // 🛡️ 入力欄を操作中（フォーカス中）の消去のみ許可し、触っていない別アコーディオンの既存設定を誤削除しない
  const safeSaveField = (inputEl, key) => {
    if (!inputEl) return;
    const value = inputEl.value.trim();
    if (value) {
      localStorage.setItem(key, value);
    } else if (document.activeElement === inputEl) {
      localStorage.removeItem(key);
    }
  };

  let rawAccount = r2AccountId?.value?.trim() || "";
  // S3 API URL（https://<account_id>.r2.cloudflarestorage.com）が貼られた場合は自動抽出
  if (rawAccount.includes(".r2.cloudflarestorage.com")) {
    const match = rawAccount.match(/https?:\/\/([a-f0-9]+)\.r2\.cloudflarestorage\.com/i);
    if (match && match[1]) {
      rawAccount = match[1];
      if (r2AccountId) r2AccountId.value = rawAccount;
    }
  }

  safeSaveField(r2AccountId, "r2AccountId");
  safeSaveField(r2BucketName, "r2BucketName");
  safeSaveField(r2AccessKeyId, "r2AccessKeyId");
  safeSaveField(r2SecretAccessKey, "r2SecretAccessKey");

  safeSaveField(filebaseBucket, "filebaseBucket");
  safeSaveField(filebaseApiKey, "filebaseApiKey");
  safeSaveField(filebaseSecretKey, "filebaseSecretKey");

  const kUrl = kuboRpcUrl?.value?.trim() || "";
  if (kUrl) {
    localStorage.setItem("kuboRpcUrl", kUrl);
    if (kuboWebUiLink) kuboWebUiLink.href = `${kUrl.replace(/\/$/, "")}/webui`;
  } else if (document.activeElement === kuboRpcUrl) {
    localStorage.removeItem("kuboRpcUrl");
  }
  if (kuboAutoPinR2Check) {
    localStorage.setItem("kuboAutoPinR2", kuboAutoPinR2Check.checked ? "true" : "false");
  }
  if (kuboAutoPinCheck) {
    localStorage.setItem("kuboAutoPin", kuboAutoPinCheck.checked ? "true" : "false");
  }
  if (kuboPrioritizePinned) {
    localStorage.setItem("kuboPrioritizePinned", kuboPrioritizePinned.checked ? "true" : "false");
  }

  // 🛡️ KV台帳Worker URL & APIトークン自動保存
  safeSaveField(kvWorkerUrl, "kvWorkerUrl");
  safeSaveField(adminApiToken, "adminApiToken");
  updateAdminTokenStatusUI();

  const isConfigured = updateR2Status();
  render();

  if (r2AutoFetchTimer) clearTimeout(r2AutoFetchTimer);
  if (isConfigured || hasAdminAccess()) {
    r2AutoFetchTimer = setTimeout(() => {
      fetchAndRenderR2Files();
    }, 400);
  }
};

filebaseCorsButton?.addEventListener("click", configureFilebaseCors);

// 🏠 自宅 Kubo 接続テストハンドラ
kuboTestButton?.addEventListener("click", async () => {
  if (!kuboTestButton) return;
  const origText = kuboTestButton.textContent;
  kuboTestButton.disabled = true;
  kuboTestButton.textContent = "🔌 確認中...";
  if (kuboStatusIndicator) {
    kuboStatusIndicator.innerHTML = '<span style="color: #fcd34d;">🟡 接続中...</span>';
  }

  saveR2SettingsAuto();
  const info = await checkKuboOnline(4000);

  if (info.online) {
    if (kuboStatusIndicator) {
      kuboStatusIndicator.innerHTML = `<span style="color: #4caf50; font-weight: bold;">🟢 オンライン (${info.agentVersion || "Kubo"})</span>`;
    }
    alert(`✅ 自宅 Kubo ノードへの接続に成功しました！\n\n・Version: ${info.agentVersion}\n・RPC: ${getKuboRpcEndpoint()}`);
  } else {
    if (kuboStatusIndicator) {
      kuboStatusIndicator.innerHTML = `<span style="color: #f87171;">🔴 オフライン (${info.error})</span>`;
    }
    alert(`❌ 自宅 Kubo ノードに接続できませんでした。\n\n・エラー: ${info.error}\n・接続先: ${getKuboRpcEndpoint()}\n\n【確認事項】\n1. DockerまたはWSL上で Kubo が起動しているか\n2. CORS許可設定（ipfs config API.HTTPHeaders...）が済んでいるか\n3. ポート5001が解放されているか`);
  }

  kuboTestButton.disabled = false;
  kuboTestButton.textContent = origText;
});


// 🛡️ KV台帳・管理者トークン表示状態の更新
function updateAdminTokenStatusUI() {
  if (!adminTokenStatus) return;
  const customKv = (localStorage.getItem("kvWorkerUrl") || kvWorkerUrl?.value || "").trim();
  const token = getAdminApiToken();

  if (customKv && token) {
    adminTokenStatus.innerHTML = '<span style="color: #22c55e; font-weight: bold;">🟢 KV台帳連携中 (認証完了)</span>';
  } else if (token && !customKv) {
    adminTokenStatus.innerHTML = '<span style="color: #f59e0b; font-weight: bold;">⚠️ KV Worker URL 未設定</span>';
  } else if (customKv && !token) {
    adminTokenStatus.innerHTML = '<span style="color: #f59e0b; font-weight: bold;">⚠️ KV API トークン 未入力</span>';
  } else {
    adminTokenStatus.innerHTML = '<span style="color: var(--muted);">⚪ 一般ユーザーモード (配信ドメイン直リンク)</span>';
  }
}

r2AccountId?.addEventListener("input", saveR2SettingsAuto);
r2BucketName?.addEventListener("input", saveR2SettingsAuto);
r2AccessKeyId?.addEventListener("input", saveR2SettingsAuto);
r2SecretAccessKey?.addEventListener("input", saveR2SettingsAuto);

filebaseBucket?.addEventListener("input", saveR2SettingsAuto);
filebaseApiKey?.addEventListener("input", saveR2SettingsAuto);
filebaseSecretKey?.addEventListener("input", saveR2SettingsAuto);

kuboRpcUrl?.addEventListener("input", saveR2SettingsAuto);
kuboAutoPinR2Check?.addEventListener("change", saveR2SettingsAuto);
kuboAutoPinCheck?.addEventListener("change", saveR2SettingsAuto);
kuboPrioritizePinned?.addEventListener("change", saveR2SettingsAuto);

kvWorkerUrl?.addEventListener("input", saveR2SettingsAuto);
adminApiToken?.addEventListener("input", saveR2SettingsAuto);

// 🌐 ドメイン選択変更リスナー
const handleDomainSelectionChange = (newDomain, provider = activeStorageTab) => {
  const storageProvider = normalizeDeliveryProvider(provider);
  setSelectedR2Domain(newDomain, storageProvider);
  if (storageProvider === normalizeDeliveryProvider(activeStorageTab) && r2DomainSelect && r2DomainSelect.value !== newDomain) {
    r2DomainSelect.value = newDomain;
  }
  if (storageProvider === "r2" && quickDomainSelect && quickDomainSelect.value !== newDomain) {
    quickDomainSelect.value = newDomain;
  }
  if (storageProvider === "filebase" && quickFilebaseDomainSelect && quickFilebaseDomainSelect.value !== newDomain) {
    quickFilebaseDomainSelect.value = newDomain;
  }
  if (storageProvider === "r2") updateR2CompatibilityUi();
  if (storageProvider === "filebase") updateFilebaseCompatibilityUi();
  updateR2Status();
  updateDomainCompatBadgeUi(storageProvider);
  if (storageProvider === normalizeDeliveryProvider(activeStorageTab)) {
    if (storageCachedContents && storageCachedContents.length > 0) {
      renderCurrentStoragePage();
    } else {
      fetchAndRenderR2Files();
    }
  }
};

r2DomainSelect?.addEventListener("change", (e) => {
  handleDomainSelectionChange(e.target.value, "r2");
});

filebaseDomainSelect?.addEventListener("change", (e) => {
  handleDomainSelectionChange(e.target.value, "filebase");
});

quickDomainSelect?.addEventListener("change", (e) => {
  handleDomainSelectionChange(e.target.value, "r2");
});

quickFilebaseDomainSelect?.addEventListener("change", (e) => {
  handleDomainSelectionChange(e.target.value, "filebase");
});

function showDomainAddForm(form, input) {
  if (!form) return;
  form.style.display = "flex";
  if (input) {
    input.value = "";
    input.focus();
  }
}

// --- 🌐 配信ドメイン互換レイヤ検証＆排他ガードユーティリティ [INV-FRONT-006] ---
const DOMAIN_COMPAT_STORAGE_KEY = "cividge_domain_compat_flags";

function getDomainCompatFlags() {
  try {
    return JSON.parse(localStorage.getItem(DOMAIN_COMPAT_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setDomainCompatFlag(domainUrl, hasCompatLayer) {
  if (!domainUrl) return;
  const flags = getDomainCompatFlags();
  flags[domainUrl] = {
    hasCompatLayer: Boolean(hasCompatLayer),
    lastTested: Date.now(),
  };
  localStorage.setItem(DOMAIN_COMPAT_STORAGE_KEY, JSON.stringify(flags));
}

/**
 * 配信ドメインが Cividge 互換レイヤ（Worker）に接続されているかを検証
 * Worker の組み込み看板画像 /404-character.webp への HEAD プローブ
 */
async function verifyDomainCompatLayer(domainUrl) {
  if (!domainUrl) return false;
  const cleanUrl = domainUrl.replace(/\/$/, "");
  const probeUrl = `${cleanUrl}/404-character.webp`;

  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 4000); // 4秒タイムアウト

  try {
    const res = await fetch(probeUrl, {
      method: "HEAD",
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(tid);

    const isWorker = res.ok && (res.headers.get("content-type") || "").includes("webp");
    setDomainCompatFlag(domainUrl, isWorker);
    return isWorker;
  } catch (e) {
    clearTimeout(tid);
    setDomainCompatFlag(domainUrl, false);
    return false;
  }
}

/**
 * ドメインのステータスバッジを描画
 */
function updateDomainCompatBadgeUi(provider) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const isFilebase = storageProvider === "filebase";
  const badgeElem = isFilebase ? filebaseDomainCompatBadge : r2DomainCompatBadge;
  const mirrorContainer = isFilebase ? filebaseDomainMirrorContainer : r2DomainMirrorContainer;
  const mirrorCheck = isFilebase ? filebaseDomainMirrorCheck : r2DomainMirrorCheck;
  if (!badgeElem) return;

  const currentDomain = getSelectedR2Domain(storageProvider);
  if (!currentDomain) {
    badgeElem.style.display = "none";
    if (mirrorContainer) mirrorContainer.style.display = "none";
    return;
  }

  const flags = getDomainCompatFlags();
  const info = flags[currentDomain];

  badgeElem.style.display = "inline-flex";
  if (info && info.hasCompatLayer) {
    badgeElem.textContent = "🟢 互換レイヤ接続済（両ストレージ併用可能）";
    badgeElem.style.background = "rgba(34, 197, 94, 0.15)";
    badgeElem.style.color = "#22c55e";
    badgeElem.style.border = "1px solid rgba(34, 197, 94, 0.4)";

    if (mirrorContainer && mirrorCheck) {
      mirrorContainer.style.display = "inline-flex";
      const otherProvider = storageProvider === "r2" ? "filebase" : "r2";
      const otherList = getR2DomainList(otherProvider);
      mirrorCheck.checked = otherList.includes(currentDomain);
    }
  } else {
    badgeElem.textContent = "⚠️ 直結・未検証モード（ストレージ排他設定）";
    badgeElem.style.background = "rgba(245, 158, 11, 0.15)";
    badgeElem.style.color = "#f59e0b";
    badgeElem.style.border = "1px solid rgba(245, 158, 11, 0.4)";

    if (mirrorContainer) {
      mirrorContainer.style.display = "none";
    }
  }
}

function bindDomainTestButton(provider, testBtn) {
  const storageProvider = normalizeDeliveryProvider(provider);
  testBtn?.addEventListener("click", async () => {
    const current = getSelectedR2Domain(storageProvider);
    if (!current) {
      await showCustomAlert("テスト対象のドメインが選択されていません。", "ℹ️ ドメイン検証");
      return;
    }
    const origText = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = "検証中...";
    try {
      const isCompat = await verifyDomainCompatLayer(current);
      updateDomainCompatBadgeUi(storageProvider);
      if (isCompat) {
        await showCustomAlert(`🟢 検証成功！\nドメイン「${current}」は Cividge 互換レイヤ（Worker）に正常に接続されています。\nR2 と Filebase の両ストレージで安全に併用可能です。`, "✅ 接続合格");
      } else {
        await showCustomAlert(`⚠️ 直結・未接続モード\nドメイン「${current}」から Cividge Worker の応答が確認できませんでした。\n\n・直結モードとして単一ストレージでのみ利用可能です（両ストレージでの同一ドメイン登録はブロックされます）。\n・もし Worker を設定済みの場合は、Cloudflare の Custom Domain や DNS 反映をお待ちください。`, "⚠️ 検証結果");
      }
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = origText;
    }
  });
}

async function handleAddNewDomain(provider, input, form) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const raw = input?.value?.trim() || "";
  if (!raw) return;

  let formatted = raw.replace(/\/$/, "");
  if (!/^https?:\/\//i.test(formatted)) {
    formatted = "https://" + formatted;
  }
  const cleanHost = formatted.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase();

  // 🛡️ ロック1: 【宗派替え事故防止】他方ストレージのファイルが台帳に残っていないかチェック
  const otherProvider = storageProvider === "r2" ? "filebase" : "r2";
  try {
    const kvFiles = await fetchKvFiles();
    const foreignFiles = kvFiles.filter(f => {
      const key = (f.name || "").toLowerCase();
      if (!key.startsWith(`${cleanHost}:`)) return false;
      const b = f.metadata?.backend || f.metadata?.b;
      return b === otherProvider || (otherProvider === "r2" ? f.metadata?.cid === "r2" : f.metadata?.cid !== "r2");
    });
    if (foreignFiles.length > 0) {
      await showCustomAlert(
        `🚫 登録拒否: このドメイン（${cleanHost}）には、過去に ${otherProvider.toUpperCase()} で登録されたファイルがまだ ${foreignFiles.length} 件台帳に残っています。\n\nURLの衝突やすり替わり事故を防ぐため、該当ファイルを全削除しない限り、${storageProvider.toUpperCase()} で再利用することはできません。`,
        "⚠️ ドメイン宗派替え防止ロック"
      );
      return;
    }
  } catch (e) {
    console.warn("KV check error during domain add:", e);
  }

  // 🛡️ ロック2: 【ストレージ排他ガード】他方ストレージにすでに同じドメインがある場合、互換レイヤ検証に合格必須
  const otherDomainList = getR2DomainList(otherProvider).map(d => d.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase());
  if (otherDomainList.includes(cleanHost)) {
    const isCompat = await verifyDomainCompatLayer(formatted);
    if (!isCompat) {
      await showCustomAlert(
        `🚫 このドメイン（${cleanHost}）は互換レイヤの接続テストに合格していません。\n\nファイルの上書き消滅や衝突事故を防ぐため、R2 と Filebase の両方に同一の直結ドメインを登録することはできません。\nWorker にカスタムドメインを設定して [テスト] に合格するか、別々のドメインを指定してください。`,
        "⚠️ ストレージ排他ガード"
      );
      return;
    }
  }

  // 自動接続テスト実行（非同期）
  verifyDomainCompatLayer(formatted).then(() => {
    updateDomainCompatBadgeUi(storageProvider);
  });

  const list = getR2DomainList(storageProvider);
  if (!list.includes(formatted)) {
    list.push(formatted);
    saveR2DomainList(list, storageProvider);
  }
  setSelectedR2Domain(formatted, storageProvider);
  renderR2DomainSelect();
  updateR2Status();
  updateDomainCompatBadgeUi(storageProvider);
  render();
  if (storageProvider === normalizeDeliveryProvider(activeStorageTab)) fetchAndRenderR2Files();
  if (form) form.style.display = "none";
}

function bindDomainManager(provider, select, addBtn, deleteBtn, form, input, saveBtn, cancelBtn, label) {
  const storageProvider = normalizeDeliveryProvider(provider);
  addBtn?.addEventListener("click", () => showDomainAddForm(form, input));
  cancelBtn?.addEventListener("click", () => { if (form) form.style.display = "none"; });
  saveBtn?.addEventListener("click", () => handleAddNewDomain(storageProvider, input, form));
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddNewDomain(storageProvider, input, form);
    } else if (e.key === "Escape" && form) {
      form.style.display = "none";
    }
  });

  deleteBtn?.addEventListener("click", async () => {
    const current = getSelectedR2Domain(storageProvider);
    if (!current) return;
    const cleanHost = current.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase();

    // 🛡️ ロック2: 【残存ファイル消し忘れ防止】このドメインに紐づくファイルが台帳に残っていないかチェック
    try {
      const kvFiles = await fetchKvFiles();
      const activeFiles = kvFiles.filter(f => (f.name || "").toLowerCase().startsWith(`${cleanHost}:`));
      if (activeFiles.length > 0) {
        await showCustomAlert(
          `⚠️ このドメイン（${cleanHost}）で配信中のファイルがまだ ${activeFiles.length} 件存在します。\n\nドメイン設定を削除すると、これらはアクセス不能（404）になります。\nドメインを削除する前に、該当ファイルを削除するか別ドメインへ移してください。`,
          "⚠️ 配信中ファイル保護ロック"
        );
        return;
      }
    } catch (e) {
      console.warn("KV check error during domain delete:", e);
    }

    if (!confirm(`選択中の${label}配信ドメイン「${current}」を削除しますか？`)) return;
    const nextList = getR2DomainList(storageProvider).filter(d => d !== current);
    saveR2DomainList(nextList, storageProvider);
    setSelectedR2Domain(nextList[0] || "", storageProvider);
    renderR2DomainSelect();
    updateR2Status();
    updateDomainCompatBadgeUi(storageProvider);
    render();
    if (storageProvider === normalizeDeliveryProvider(activeStorageTab)) fetchAndRenderR2Files();
  });
}

bindDomainManager("r2", r2DomainSelect, r2DomainAddBtn, r2DomainDeleteBtn, r2DomainAddForm, r2DomainNewInput, r2DomainNewSaveBtn, r2DomainNewCancelBtn, "R2 ");
bindDomainManager("filebase", filebaseDomainSelect, filebaseDomainAddBtn, filebaseDomainDeleteBtn, filebaseDomainAddForm, filebaseDomainNewInput, filebaseDomainNewSaveBtn, filebaseDomainNewCancelBtn, "Filebase ");
bindDomainTestButton("r2", r2DomainTestBtn);
bindDomainTestButton("filebase", filebaseDomainTestBtn);

function bindDomainMirrorCheckbox(provider, mirrorCheck) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const otherProvider = storageProvider === "r2" ? "filebase" : "r2";
  const otherLabel = otherProvider === "r2" ? "R2" : "Filebase";

  mirrorCheck?.addEventListener("change", async () => {
    const currentDomain = getSelectedR2Domain(storageProvider);
    if (!currentDomain) return;
    const cleanHost = currentDomain.replace(/^https?:\/\//, "").split("/")[0].split(":")[0].toLowerCase();
    const otherList = getR2DomainList(otherProvider);

    if (mirrorCheck.checked) {
      if (!otherList.includes(currentDomain)) {
        otherList.push(currentDomain);
        saveR2DomainList(otherList, otherProvider);
        if (!getSelectedR2Domain(otherProvider)) {
          setSelectedR2Domain(currentDomain, otherProvider);
        }
        renderR2DomainSelect();
        updateR2Status();
        updateDomainCompatBadgeUi(otherProvider);
      }
    } else {
      // 🛡️ ロック: 他方ストレージでこのドメインに紐づくファイルが台帳に残っていないかチェック
      try {
        const kvFiles = await fetchKvFiles();
        const foreignFiles = kvFiles.filter(f => {
          const key = (f.name || "").toLowerCase();
          if (!key.startsWith(`${cleanHost}:`)) return false;
          const b = f.metadata?.backend || f.metadata?.b;
          return b === otherProvider || (otherProvider === "r2" ? f.metadata?.cid === "r2" : f.metadata?.cid !== "r2");
        });
        if (foreignFiles.length > 0) {
          await showCustomAlert(
            `⚠️ ${otherLabel} 側にこのドメイン（${cleanHost}）で配信中のファイルがまだ ${foreignFiles.length} 件存在します。\n\n登録を解除するとそれらがアクセス不能（404）になります。\n該当ファイルを削除するか別ドメインに移してから解除してください。`,
            "⚠️ 配信中ファイル保護ロック"
          );
          mirrorCheck.checked = true;
          return;
        }
      } catch (e) {
        console.warn("KV check error during domain unmirror:", e);
      }

      const nextList = otherList.filter(d => d !== currentDomain);
      saveR2DomainList(nextList, otherProvider);
      if (getSelectedR2Domain(otherProvider) === currentDomain) {
        setSelectedR2Domain(nextList[0] || "", otherProvider);
      }
      renderR2DomainSelect();
      updateR2Status();
      updateDomainCompatBadgeUi(otherProvider);
    }
  });
}

bindDomainMirrorCheckbox("r2", r2DomainMirrorCheck);
bindDomainMirrorCheckbox("filebase", filebaseDomainMirrorCheck);

cfSaveButton?.addEventListener("click", () => {
  saveR2SettingsAuto();
  if (cfSettingsAccordion) cfSettingsAccordion.open = false;
  fetchAndRenderR2Files();
});

cfClearButton?.addEventListener("click", () => {
  localStorage.removeItem("r2AccountId");
  localStorage.removeItem("r2BucketName");
  localStorage.removeItem("r2AccessKeyId");
  localStorage.removeItem("r2SecretAccessKey");
  localStorage.removeItem("r2DomainList");
  localStorage.removeItem("r2SelectedDomain");
  localStorage.removeItem("r2PublicDomain");
  localStorage.removeItem("r2DevDomain");
  localStorage.removeItem("filebaseDomainList");
  localStorage.removeItem("filebaseSelectedDomain");
  localStorage.removeItem("filebaseCompatibilityUrl");
  localStorage.removeItem("filebaseCompatibilityEnabled");

  localStorage.removeItem("filebaseBucket");
  localStorage.removeItem("filebaseApiKey");
  localStorage.removeItem("filebaseSecretKey");

  localStorage.removeItem("kuboRpcUrl");
  localStorage.removeItem("kuboAutoPinR2");
  localStorage.removeItem("kuboAutoPin");
  localStorage.removeItem("kuboPrioritizePinned");
  localStorage.removeItem("kvWorkerUrl");
  localStorage.removeItem("adminApiToken");

  if (r2AccountId) r2AccountId.value = "";
  if (r2BucketName) r2BucketName.value = "";
  if (r2AccessKeyId) r2AccessKeyId.value = "";
  if (r2SecretAccessKey) r2SecretAccessKey.value = "";

  if (filebaseBucket) filebaseBucket.value = "";
  if (filebaseApiKey) filebaseApiKey.value = "";
  if (filebaseSecretKey) filebaseSecretKey.value = "";

  if (kuboRpcUrl) kuboRpcUrl.value = "http://127.0.0.1:5001";
  if (kuboAutoPinR2Check) kuboAutoPinR2Check.checked = true;
  if (kuboAutoPinCheck) kuboAutoPinCheck.checked = true;
  if (kuboPrioritizePinned) kuboPrioritizePinned.checked = true;
  if (kuboStatusIndicator) kuboStatusIndicator.textContent = "⚪ 未確認";

  if (kvWorkerUrl) kvWorkerUrl.value = "";
  if (adminApiToken) adminApiToken.value = "";
  updateAdminTokenStatusUI();

  renderR2DomainSelect();
  updateR2Status();
  render();
  fetchAndRenderR2Files();
  if (cfSettingsAccordion) cfSettingsAccordion.open = true;
});

// --- 📱 可視光スキャン（QRコード）同期ハンドラ ---
let lastGeneratedSyncUrl = "";
const copySyncUrlButton = document.querySelector("#copySyncUrlButton");

async function openSyncQrModal() {
  saveR2SettingsAuto();
  const payload = buildAppExportPayload();
  const hasData = payload.a || payload.fb || payload.kv || payload.ku || payload.cu || (payload.cul && payload.cul.length > 0) || (payload.dl && payload.dl.length > 0);
  if (!hasData) {
    alert("⚠️ 引き継ぐ設定（クラウドストレージ接続設定またはCivitaiクリエイターリスト）がありません。");
    return;
  }

  try {
    const jsonStr = JSON.stringify(payload);
    const compressed = compressPayloadSync(jsonStr);
    lastGeneratedSyncUrl = `${window.location.origin}${window.location.pathname}#sync=z.${compressed}`;

    if (qrCanvas) {
      await QRCode.toCanvas(qrCanvas, lastGeneratedSyncUrl, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "L", // 画面読み取りに最も適した大型ドット（超高認識率・低密度）
        color: {
          dark: "#0f172a",
          light: "#ffffff",
        },
      });
    }

    if (qrModal) qrModal.style.display = "grid";
  } catch (err) {
    console.error("QR Code generation error:", err);
    alert("QRコードの生成に失敗しました。");
  }
}

copySyncUrlButton?.addEventListener("click", async () => {
  if (!lastGeneratedSyncUrl) return;
  try {
    await navigator.clipboard.writeText(lastGeneratedSyncUrl);
    const originalText = copySyncUrlButton.textContent;
    copySyncUrlButton.textContent = "✅ コピーしました！";
    setTimeout(() => {
      copySyncUrlButton.textContent = originalText;
    }, 2000);
  } catch (err) {
    console.error("Clipboard copy failed:", err);
    prompt("以下の引き継ぎURLをコピーしてください:", lastGeneratedSyncUrl);
  }
});

cfShareQrButton?.addEventListener("click", openSyncQrModal);
topbarSyncButton?.addEventListener("click", openSyncQrModal);

globalClearButton?.addEventListener("click", () => {
  if (!confirm("⚠️ アプリに保存された全設定（R2接続情報、Civitaiウォッチリスト、変換設定等）を消去して初期化しますか？")) return;
  localStorage.clear();
  location.reload();
});

cfBackupUrlButton?.addEventListener("click", generatePinBackupUrl);

closeQrModalButton?.addEventListener("click", () => {
  if (qrModal) qrModal.style.display = "none";
});

qrModal?.addEventListener("click", (e) => {
  if (e.target === qrModal) {
    qrModal.style.display = "none";
  }
});

// 🎨 Civitai クリエイター選択・追加・削除・更新イベントリスナー
civitaiUserSelect?.addEventListener("change", () => {
  const selected = civitaiUserSelect.value.trim();
  if (selected) {
    localStorage.setItem("civitaiUsername", selected);
    updateCivitaiStatus();
    fetchAndRenderCivitaiGallery();
  }
});

civitaiUserAddBtn?.addEventListener("click", () => {
  if (!civitaiUserAddForm) return;
  const isOpen = civitaiUserAddForm.style.display === "flex";
  civitaiUserAddForm.style.display = isOpen ? "none" : "flex";
  if (!isOpen && civitaiUserNewInput) {
    civitaiUserNewInput.value = "";
    civitaiUserNewInput.focus();
  }
});

civitaiUserNewCancelBtn?.addEventListener("click", () => {
  if (civitaiUserAddForm) civitaiUserAddForm.style.display = "none";
});

civitaiUserNewSaveBtn?.addEventListener("click", () => {
  const val = civitaiUserNewInput?.value?.trim() || "";
  if (!val) return;

  const list = getCivitaiUserList();
  const exists = list.some(u => u.toLowerCase() === val.toLowerCase());
  if (!exists) {
    list.push(val);
    saveCivitaiUserList(list);
  }

  localStorage.setItem("civitaiUsername", val);
  if (civitaiUserAddForm) civitaiUserAddForm.style.display = "none";
  renderCivitaiUserSelect();
  fetchAndRenderCivitaiGallery();
});

civitaiUserNewInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    civitaiUserNewSaveBtn?.click();
  } else if (e.key === "Escape") {
    civitaiUserNewCancelBtn?.click();
  }
});

civitaiUserDeleteBtn?.addEventListener("click", () => {
  const list = getCivitaiUserList();
  const current = getCurrentCivitaiUser();
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;

  if (!current) return;

  const confirmMsg = (dict.civitaiDeleteConfirm || "登録クリエイター「{name}」をウォッチリストから削除しますか？").replace("{name}", current);
  if (!confirm(confirmMsg)) return;

  const newList = list.filter(u => u !== current);
  saveCivitaiUserList(newList);

  const lastSeenMap = getCivitaiLastSeenMap();
  delete lastSeenMap[current];
  saveCivitaiLastSeenMap(lastSeenMap);

  if (newList.length > 0) {
    localStorage.setItem("civitaiUsername", newList[0]);
  } else {
    localStorage.removeItem("civitaiUsername");
  }

  renderCivitaiUserSelect();
  fetchAndRenderCivitaiGallery();
});

reloadCivitaiButton?.addEventListener("click", () => {
  fetchAndRenderCivitaiGallery();
});

// PINモーダル処理
const submitPinButton = document.querySelector("#submitPinButton");
const cancelPinButton = document.querySelector("#cancelPinButton");
const pinModal = document.querySelector("#pinModal");
const pinInput = document.querySelector("#pinInput");
const pinErrorNotice = document.querySelector("#pinErrorNotice");
const closePinDisplayModalButton = document.querySelector("#closePinDisplayModalButton");
const pinDisplayModal = document.querySelector("#pinDisplayModal");

submitPinButton?.addEventListener("click", () => {
  const pin = pinInput?.value?.trim() || "";
  if (!pin || pin.length < 6) {
    if (pinErrorNotice) pinErrorNotice.textContent = "6桁のPINコードを入力してください";
    return;
  }

  const payload = decryptPayloadWithPin(pendingEncryptedHash, pin);
  if (!payload || typeof payload !== "object") {
    if (pinErrorNotice) pinErrorNotice.textContent = "❌ PINコードが正しくありません";
    return;
  }

  const restored = applyAppImportPayload(payload);
  if (!restored) {
    if (pinErrorNotice) pinErrorNotice.textContent = "⚠️ バックアップデータが破損しているか空です";
    return;
  }

  if (pinModal) pinModal.style.display = "none";
  history.replaceState(null, "", window.location.pathname + window.location.search);
  alert("🎉 設定を正常に復元・保存しました！");
});

cancelPinButton?.addEventListener("click", () => {
  if (pinModal) pinModal.style.display = "none";
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

closePinDisplayModalButton?.addEventListener("click", () => {
  if (pinDisplayModal) pinDisplayModal.style.display = "none";
});

// --- UI イベントリスナー ---
enableConvertCheck?.addEventListener("change", () => {
  const isChecked = enableConvertCheck.checked;
  localStorage.setItem("enableConvert", String(isChecked));
  if (convertSettingsArea) {
    convertSettingsArea.classList.toggle("is-disabled-area", !isChecked);
  }
  render();
  updateRenamePreview();
});

enableRenameCheck?.addEventListener("change", () => {
  const isChecked = enableRenameCheck.checked;
  localStorage.setItem("enableRename", String(isChecked));
  if (renameSettingsArea) {
    renameSettingsArea.classList.toggle("is-disabled-area", !isChecked);
  }
  render();
  updateRenamePreview();
});

enableZipCheck?.addEventListener("change", () => {
  const isChecked = enableZipCheck.checked;
  localStorage.setItem("enableZip", String(isChecked));
  render();
});

qualityRange?.addEventListener("input", () => {
  if (qualityOutput) qualityOutput.textContent = qualityRange.value;
  localStorage.setItem("qualityRange", qualityRange.value);
});

formatSelect?.addEventListener("change", () => {
  localStorage.setItem("formatSelect", formatSelect.value);
  updateRenamePreview();
});

renamePattern?.addEventListener("input", () => {
  localStorage.setItem("renamePattern", renamePattern.value.trim());
  updateRenamePreview();
});

clearRenamePattern?.addEventListener("click", () => {
  if (renamePattern) {
    renamePattern.value = "";
    renamePattern.focus();
    localStorage.setItem("renamePattern", "");
    updateRenamePreview();
  }
});

document.querySelector(".pattern-helpers")?.addEventListener("click", (event) => {
  const target = event.target;
  if (target.classList.contains("tag-button")) {
    const insertText = target.dataset.insert;
    if (!insertText || !renamePattern) return;

    const start = renamePattern.selectionStart ?? renamePattern.value.length;
    const end = renamePattern.selectionEnd ?? renamePattern.value.length;
    const text = renamePattern.value;

    const newText = text.substring(0, start) + insertText + text.substring(end);
    renamePattern.value = newText;

    renamePattern.focus();
    const newPos = start + insertText.length;
    renamePattern.setSelectionRange(newPos, newPos);

    localStorage.setItem("renamePattern", renamePattern.value.trim());
    updateRenamePreview();
  }
});

function getActiveStorageLimitGB() {
  if (activeStorageTab === "filebase") {
    const savedGb = localStorage.getItem("filebaseStorageLimitGB");
    if (savedGb) return Math.max(1, parseInt(savedGb, 10));
    const savedMb = Number(localStorage.getItem("filebaseStorageLimit") || "5000");
    return Math.max(1, Math.round(savedMb / 1024));
  }
  const savedGb = localStorage.getItem("r2StorageLimitGB");
  if (savedGb) return Math.max(1, parseInt(savedGb, 10));
  const savedMb = Number(localStorage.getItem("r2StorageLimit") || localStorage.getItem("storageLimit") || "5000");
  return Math.max(1, Math.round(savedMb / 1024));
}

function setActiveStorageLimitGB(val) {
  const gb = Math.max(1, parseInt(val, 10) || 5);
  const mb = gb * 1024;
  if (activeStorageTab === "filebase") {
    localStorage.setItem("filebaseStorageLimitGB", String(gb));
    localStorage.setItem("filebaseStorageLimit", String(mb)); // FIFO処理用
  } else {
    localStorage.setItem("r2StorageLimitGB", String(gb));
    localStorage.setItem("r2StorageLimit", String(mb));
    localStorage.setItem("storageLimit", String(mb)); // 後方互換
  }
}

function getActiveStorageLimit() {
  return getActiveStorageLimitGB() * 1024;
}

function setActiveStorageLimit(val) {
  setActiveStorageLimitGB(Math.round(Number(val) / 1024));
}

function syncStorageLimitControl() {
  const gb = getActiveStorageLimitGB();
  if (storageLimitInput) {
    storageLimitInput.value = String(gb);
  }
  if (storageLimitRange) {
    const isFb = activeStorageTab === "filebase";
    storageLimitRange.min = "1";
    storageLimitRange.max = isFb ? "50" : "100";
    storageLimitRange.step = "1";
    storageLimitRange.value = String(Math.min(gb, Number(storageLimitRange.max)));
  }
}

// 📦 上限数値入力ボックス
storageLimitInput?.addEventListener("input", () => {
  let gb = parseInt(storageLimitInput.value, 10);
  if (isNaN(gb) || gb < 1) return;
  setActiveStorageLimitGB(gb);
  if (storageLimitRange) {
    storageLimitRange.value = String(Math.min(gb, Number(storageLimitRange.max)));
  }
  updateStorageUsageUI();
});

// 📦 上限スライダー
storageLimitRange?.addEventListener("input", () => {
  const gb = parseInt(storageLimitRange.value, 10) || 1;
  if (storageLimitInput) {
    storageLimitInput.value = String(gb);
  }
  setActiveStorageLimitGB(gb);
  updateStorageUsageUI();
});

autoFifoCheckbox?.addEventListener("change", () => {
  const key = activeStorageTab === "filebase" ? "autoFifo" : "r2AutoFifo";
  localStorage.setItem(key, String(autoFifoCheckbox.checked));
});

function updateStorageUsageUI() {
  if (!storageUsageText || !storageUsageBar) return;
  const totalSize = state.r2TotalSize || 0;
  const limitGb = getActiveStorageLimitGB();
  const limitBytes = limitGb * 1024 * 1024 * 1024;
  
  const percentage = limitBytes > 0 ? (totalSize / limitBytes) * 100 : 0;
  const clampedPercentage = Math.min(100, Math.round(percentage * 10) / 10);
  
  if (storageUsageBar) storageUsageBar.value = clampedPercentage;
  
  if (storageUsageText) {
    storageUsageText.textContent = `${getAppLanguage() === "en" ? "Usage" : "使用量"}: ${formatBytes(totalSize)} / ${limitGb} GB (${clampedPercentage}%)`;
    
    if (totalSize > limitBytes) {
      storageUsageText.classList.add("storage-warning");
    } else {
      storageUsageText.classList.remove("storage-warning");
    }
  }
}

// ファイル選択関連
fileInput?.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []).map(f => {
    f.relativePath = f.name;
    return f;
  });
  addFiles(files);
  fileInput.value = "";
});

folderSelectButton?.addEventListener("click", () => {
  folderInput?.click();
});

folderInput?.addEventListener("change", () => {
  const files = Array.from(folderInput.files || []).map(f => {
    f.relativePath = f.webkitRelativePath || f.name;
    return f;
  });
  addFiles(files);
  folderInput.value = "";
});

// ドラッグ＆ドロップ関連
dropzone?.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragging");
});

dropzone?.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragging");
});

dropzone?.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");

  const items = event.dataTransfer.items;
  if (items) {
    const files = [];
    const scanPromises = [];

    const scanFiles = async (entry, path = "") => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        file.relativePath = path ? `${path}/${file.name}` : file.name;
        files.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAllEntries = async () => {
          const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (entries.length > 0) {
            const nextPath = path ? `${path}/${entry.name}` : entry.name;
            for (const nextEntry of entries) {
              await scanFiles(nextEntry, nextPath);
            }
            await readAllEntries();
          }
        };
        await readAllEntries();
      }
    };

    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        scanPromises.push(scanFiles(entry));
      }
    }

    await Promise.all(scanPromises);
    addFiles(files);
  } else {
    const fallbackFiles = Array.from(event.dataTransfer.files || []).map(f => {
      f.relativePath = f.name;
      return f;
    });
    addFiles(fallbackFiles);
  }
});

clearButton?.addEventListener("click", () => {
  state.results.forEach((result) => {
    if (result && result.url) URL.revokeObjectURL(result.url);
  });
  state.files = [];
  state.results = [];
  render();
});


// --- ComfyUI ワークフロー / 生成メタデータ検出ユーティリティ ---
function parseA1111Parameters(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const negIndex = trimmed.indexOf("Negative prompt:");
  const stepsIndex = trimmed.search(/\bSteps:\s*\d+/);

  let prompt = "";
  let negativePrompt = "";
  let params = "";

  if (negIndex !== -1) {
    prompt = trimmed.substring(0, negIndex).trim();
    if (stepsIndex !== -1 && stepsIndex > negIndex) {
      negativePrompt = trimmed.substring(negIndex + "Negative prompt:".length, stepsIndex).trim();
      params = trimmed.substring(stepsIndex).trim();
    } else {
      negativePrompt = trimmed.substring(negIndex + "Negative prompt:".length).trim();
    }
  } else if (stepsIndex !== -1) {
    prompt = trimmed.substring(0, stepsIndex).trim();
    params = trimmed.substring(stepsIndex).trim();
  } else {
    prompt = trimmed;
  }

  return { prompt, negativePrompt, params, raw: trimmed };
}

function unescapeJsonString(str) {
  if (!str) return "";
  try {
    const sanitized = str.replace(/[\u0000-\u001f]/g, (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    });
    return JSON.parse(`"${sanitized}"`);
  } catch (e) {
    return str
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

const EXCLUDE_WORDS = new Set([
  "true", "false", "null", "undefined", "none", "fixed", "increment",
  "decrement", "randomize", "auto", "enable", "disable", "cpu", "gpu", "cuda",
  "euler", "euler_ancestral", "heun", "dpm_2", "karras", "exponential",
  "normal", "simple", "ddim", "uni_pc"
]);

function isExcludedString(s) {
  if (!s || s.length < 3) return true;
  const lower = s.toLowerCase().trim();
  if (EXCLUDE_WORDS.has(lower)) return true;
  if (/^https?:\/\//i.test(lower)) return true;
  if (/\.(safetensors|ckpt|pt|bin|pth|onnx|engine|yaml|json|png|jpg|jpeg|webp|mp4|webm|gif|mov)$/i.test(lower)) return true;
  if (/^[\d\s.,_-]+$/.test(lower)) return true;
  return false;
}

function extractPromptsFromRawText(text) {
  if (!text || typeof text !== "string") return null;

  // AI関連キーワードが一切ない場合は重い走査をスキップ（高速化）
  const hasAiHint = text.includes('"inputs"') || 
                    text.includes('"class_type"') || 
                    text.includes('"prompt"') || 
                    text.includes('"workflow"') || 
                    text.includes('"nodes"') ||
                    text.includes('"widgets_values"') ||
                    text.includes('Negative prompt:') ||
                    text.includes('Steps:');
  if (!hasAiHint) return null;

  const candidates = [];

  const addCandidate = (rawVal) => {
    const val = unescapeJsonString(rawVal).trim();
    if (!isExcludedString(val) && !candidates.includes(val)) {
      candidates.push(val);
    }
  };

  // 1. "widgets_values": [...] の配列内を走査 (UI workflow形式)
  const widgetArrayMatches = text.matchAll(/"widgets_values"\s*:\s*\[([\s\S]*?)\]/gi);
  for (const m of widgetArrayMatches) {
    const arrayContent = m[1];
    const stringMatches = arrayContent.matchAll(/"((?:[^"\\]|\\.)*)"/gi);
    for (const sm of stringMatches) {
      addCandidate(sm[1]);
    }
  }

  // 2. キー名による抽出 ("text", "prompt", "positive", "caption", "text_positive", etc.)
  const keyMatches = text.matchAll(/"(?:text|prompt|positive|text_positive|caption|prompt_text)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi);
  for (const m of keyMatches) {
    addCandidate(m[1]);
  }

  if (candidates.length === 0) return null;

  const negKeywords = ["low quality", "worst quality", "blurry", "bad anatomy", "watermark", "deformed", "ugly", "nsfw", "lowres", "bad hands", "error", "missing fingers"];
  const positives = [];
  const negatives = [];

  for (const c of candidates) {
    const lower = c.toLowerCase();
    const isNeg = negKeywords.some(k => lower.includes(k)) || lower.startsWith("negative") || lower.includes("embedding:");
    if (isNeg) {
      negatives.push(c);
    } else {
      positives.push(c);
    }
  }

  let prompt = "";
  let negativePrompt = "";

  if (positives.length > 0) {
    positives.sort((a, b) => b.length - a.length);
    prompt = positives[0];
    if (negatives.length > 0) {
      negativePrompt = negatives[0];
    } else if (positives.length > 1) {
      negativePrompt = positives[1];
    }
  } else {
    prompt = candidates[0];
    if (candidates.length > 1) negativePrompt = candidates[1];
  }

  return {
    prompt,
    negativePrompt,
    params: `Extracted ${candidates.length} candidate(s)`,
    raw: text.slice(0, 5000),
  };
}

function parseComfyPromptJson(rawJson) {
  if (!rawJson) return null;
  let obj = null;
  try {
    obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch (e) {
    if (typeof rawJson === "string") {
      return extractPromptsFromRawText(rawJson);
    }
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  // { prompt: { ... }, workflow: { ... } } などのラッパー対応
  const targetObj = (obj.prompt && typeof obj.prompt === "object") ? obj.prompt : obj;

  const textNodes = [];
  for (const k of Object.keys(targetObj)) {
    const node = targetObj[k];
    if (node && node.inputs) {
      const val = node.inputs.text || node.inputs.prompt || node.inputs.positive || node.inputs.text_positive || node.inputs.caption;
      if (typeof val === "string" && !isExcludedString(val)) {
        textNodes.push({
          type: node.class_type || "CLIPTextEncode",
          text: val.trim(),
        });
      }
    }
  }

  const wfObj = (obj.workflow && typeof obj.workflow === "object") ? obj.workflow : obj;
  if (textNodes.length === 0 && Array.isArray(wfObj.nodes)) {
    for (const node of wfObj.nodes) {
      if (node && Array.isArray(node.widgets_values)) {
        for (const val of node.widgets_values) {
          if (typeof val === "string" && !isExcludedString(val)) {
            textNodes.push({
              type: node.type || "CLIPTextEncode",
              text: val.trim(),
            });
          }
        }
      }
    }
  }

  if (textNodes.length === 0) {
    return extractPromptsFromRawText(JSON.stringify(obj));
  }

  const prompt = textNodes[0]?.text || "";
  const negativePrompt = textNodes.length > 1 ? textNodes[1]?.text : "";
  return {
    prompt,
    negativePrompt,
    params: `Nodes: ${textNodes.length}`,
    raw: typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson, null, 2),
  };
}

function parseNovelAiComment(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (obj && (obj.prompt || obj.uc)) {
      return {
        prompt: obj.prompt || "",
        negativePrompt: obj.uc || "",
        params: `Steps: ${obj.steps || ""}, Scale: ${obj.scale || ""}, Seed: ${obj.seed || ""}`,
        raw: typeof raw === "string" ? raw : JSON.stringify(raw),
      };
    }
  } catch (e) {}
  return null;
}

// ==========================================
// 🧬 PNG メタデータ救出・再注入エンジン (ComfyUI / A1111 互換)
// ==========================================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function calculateCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 元画像から ComfyUI / A1111 のメタデータ (tEXt / iTXt チャンクおよびテキスト) を救出
async function extractMetadataChunksFromPng(fileOrBuffer) {
  try {
    const buffer = (fileOrBuffer instanceof ArrayBuffer) ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
      return { chunks: [], texts: {} };
    }

    const chunks = [];
    const texts = {};
    let offset = 8;
    const length = buffer.byteLength;

    while (offset < length - 8) {
      const chunkLength = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (chunkType === "IEND") break;

      // ComfyUI (prompt, workflow) および A1111 (parameters), NovelAI (Comment) 等のテキストメタデータを救出
      // ※ 位置情報・撮影機材情報が含まれうる "eXIf" チャンクは意図的に除外（プライバシー更地化）
      if (chunkType === "tEXt" || chunkType === "iTXt") {
        const fullChunk = new Uint8Array(buffer, offset, chunkLength + 12);
        chunks.push(new Uint8Array(fullChunk)); // コピーして保持

        const chunkData = new Uint8Array(buffer, offset + 8, chunkLength);
        let nullIndex = -1;
        for (let i = 0; i < chunkData.length; i++) {
          if (chunkData[i] === 0) { nullIndex = i; break; }
        }
        if (nullIndex > 0) {
          const keyword = new TextDecoder("utf-8").decode(chunkData.subarray(0, nullIndex));
          try {
            const valText = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
            texts[keyword] = valText;
          } catch (e) {}
        }
      }

      offset += chunkLength + 12;
    }
    return { chunks, texts };
  } catch (err) {
    console.warn("Failed to extract PNG metadata chunks:", err);
    return { chunks: [], texts: {} };
  }
}

// 変換後の PNG バイナリの IEND 直前に救出したメタデータチャンクを再注入
async function injectMetadataChunksIntoPng(pngBlobOrBuffer, chunks) {
  if (!chunks || chunks.length === 0) return pngBlobOrBuffer;
  try {
    const buffer = (pngBlobOrBuffer instanceof ArrayBuffer) ? pngBlobOrBuffer : await pngBlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (view.byteLength < 8 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
      return pngBlobOrBuffer;
    }

    // IEND チャンクの位置を探索
    let offset = 8;
    let iendOffset = -1;
    const length = buffer.byteLength;

    while (offset < length - 8) {
      const chunkLength = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );
      if (chunkType === "IEND") {
        iendOffset = offset;
        break;
      }
      offset += chunkLength + 12;
    }

    if (iendOffset === -1) return pngBlobOrBuffer;

    let extraSize = 0;
    for (const c of chunks) extraSize += c.byteLength;

    const newBuffer = new Uint8Array(buffer.byteLength + extraSize);
    // IENDの手前までコピー
    newBuffer.set(new Uint8Array(buffer, 0, iendOffset), 0);

    // 救出したメタデータチャンク群を挿入
    let cur = iendOffset;
    for (const c of chunks) {
      newBuffer.set(c, cur);
      cur += c.byteLength;
    }

    // 残りのIENDチャンクをコピー
    newBuffer.set(new Uint8Array(buffer, iendOffset), cur);

    return new Blob([newBuffer], { type: "image/png" });
  } catch (err) {
    console.warn("Failed to inject PNG metadata chunks:", err);
    return pngBlobOrBuffer;
  }
}

// 変換後の WebP (RIFF) バイナリに ComfyUI メタデータ (VP8X + EXIF チャンク) を再注入
async function injectMetadataIntoWebp(webpBlobOrBuffer, texts, width = 0, height = 0) {
  if (!texts || (!texts.workflow && !texts.prompt && !texts.parameters)) {
    return webpBlobOrBuffer;
  }

  const originalBlob = (webpBlobOrBuffer instanceof Blob) ? webpBlobOrBuffer : new Blob([webpBlobOrBuffer], { type: "image/webp" });

  try {
    const buffer = (webpBlobOrBuffer instanceof ArrayBuffer) ? webpBlobOrBuffer : await webpBlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    if (buffer.byteLength < 12) return originalBlob;

    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    const webp = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (riff !== "RIFF" || webp !== "WEBP") return originalBlob;

    // 元WebPから画像チャンク（VP8 または VP8L）の位置とサイズを特定
    let offset = 12;
    let imageChunkType = "";
    let imageChunkOffset = -1;
    let imageChunkTotalSize = 0;
    let hasAlpha = false;

    while (offset < buffer.byteLength - 8) {
      const chunkType = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkSize = view.getUint32(offset + 4, true);
      const paddedSize = chunkSize + (chunkSize % 2 === 1 ? 1 : 0);

      if (chunkType === "VP8 " || chunkType === "VP8L") {
        imageChunkType = chunkType;
        imageChunkOffset = offset;
        imageChunkTotalSize = 8 + paddedSize;
        if (chunkType === "VP8L") hasAlpha = true;
        break;
      } else if (chunkType === "VP8X") {
        // 既にVP8Xがある場合はスキップ
        return originalBlob;
      }
      offset += 8 + paddedSize;
    }

    if (imageChunkOffset === -1) return originalBlob;

    // ComfyUI が解釈できる形式の Exif UserComment を構築
    const payload = {};
    if (texts.prompt) {
      try { payload.prompt = JSON.parse(texts.prompt); } catch (e) { payload.prompt = texts.prompt; }
    }
    if (texts.workflow) {
      try { payload.workflow = JSON.parse(texts.workflow); } catch (e) { payload.workflow = texts.workflow; }
    }
    if (texts.parameters) payload.parameters = texts.parameters;

    const payloadJsonStr = JSON.stringify(payload);
    const commentBytes = new TextEncoder().encode(payloadJsonStr);

    const userCommentHeader = new Uint8Array([0x55, 0x4E, 0x49, 0x43, 0x4F, 0x44, 0x45, 0x00]); // 'UNICODE\0'
    const totalCommentDataLen = userCommentHeader.length + commentBytes.length;
    const exifIfdOffset = 26;
    const userCommentDataOffset = 44;

    const exifPayloadSize = 6 + 8 + 2 + 12 + 4 + 2 + 12 + 4 + totalCommentDataLen;
    const exifChunkDataSize = exifPayloadSize + (exifPayloadSize % 2 === 1 ? 1 : 0);
    const exifData = new Uint8Array(exifChunkDataSize);
    const eView = new DataView(exifData.buffer);

    exifData.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // 'Exif\0\0'
    eView.setUint8(6, 0x49); eView.setUint8(7, 0x49); // 'II'
    eView.setUint16(8, 42, true);
    eView.setUint32(10, 8, true);

    // IFD0
    eView.setUint16(14, 1, true);
    eView.setUint16(16, 0x8769, true);
    eView.setUint16(18, 4, true);
    eView.setUint32(20, 1, true);
    eView.setUint32(24, exifIfdOffset, true);
    eView.setUint32(28, 0, true);

    // ExifIFD
    eView.setUint16(32, 1, true);
    eView.setUint16(34, 0x9286, true);
    eView.setUint16(36, 7, true);
    eView.setUint32(38, totalCommentDataLen, true);
    eView.setUint32(42, userCommentDataOffset, true);
    eView.setUint32(46, 0, true);

    exifData.set(userCommentHeader, 50);
    exifData.set(commentBytes, 58);

    // WebP Extended Header (VP8X): 10 バイトデータ
    // Flags (1B): Exifフラグ (0x08) | (hasAlpha ? 0x10 : 0)
    // Reserved (3B): 00 00 00
    // Canvas Width - 1 (24-bit LE, 3B)
    // Canvas Height - 1 (24-bit LE, 3B)
    const vp8xChunkSize = 8 + 10; // 18 bytes
    const vp8xData = new Uint8Array(18);
    const vpView = new DataView(vp8xData.buffer);
    vp8xData.set([0x56, 0x50, 0x38, 0x58], 0); // 'VP8X'
    vpView.setUint32(4, 10, true); // size = 10
    vp8xData[8] = 0x08 | (hasAlpha ? 0x10 : 0); // Exif flag (+ Alpha if any)
    vp8xData[9] = 0; vp8xData[10] = 0; vp8xData[11] = 0; // Reserved

    const wMinus1 = Math.max(0, width - 1);
    const hMinus1 = Math.max(0, height - 1);
    vp8xData[12] = wMinus1 & 0xFF;
    vp8xData[13] = (wMinus1 >> 8) & 0xFF;
    vp8xData[14] = (wMinus1 >> 16) & 0xFF;
    vp8xData[15] = hMinus1 & 0xFF;
    vp8xData[16] = (hMinus1 >> 8) & 0xFF;
    vp8xData[17] = (hMinus1 >> 16) & 0xFF;

    // EXIF チャンクヘッダー
    const exifChunkHeader = new Uint8Array(8);
    exifChunkHeader.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
    new DataView(exifChunkHeader.buffer).setUint32(4, exifChunkDataSize, true);

    // 全体組み立て: [RIFF] + [VP8X] + [画像データ(VP8/VP8L)] + [EXIF]
    const imageBytes = new Uint8Array(buffer, imageChunkOffset, imageChunkTotalSize);
    const totalNewSize = 12 + vp8xChunkSize + imageBytes.byteLength + 8 + exifChunkDataSize;
    const finalBuffer = new Uint8Array(totalNewSize);
    const fView = new DataView(finalBuffer.buffer);

    finalBuffer.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    fView.setUint32(4, totalNewSize - 8, true);
    finalBuffer.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'

    let cur = 12;
    finalBuffer.set(vp8xData, cur);
    cur += vp8xChunkSize;

    finalBuffer.set(imageBytes, cur);
    cur += imageBytes.byteLength;

    finalBuffer.set(exifChunkHeader, cur);
    cur += 8;

    finalBuffer.set(exifData, cur);

    const injectedBlob = new Blob([finalBuffer], { type: "image/webp" });

    // 🛡️ ロードテスト・セーフガード: ブラウザで正常に描画できるか検証
    const testUrl = URL.createObjectURL(injectedBlob);
    try {
      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => reject(new Error("Decoded image broken"));
        img.src = testUrl;
      });
      URL.revokeObjectURL(testUrl);
      return injectedBlob; // 検証OK！
    } catch (testErr) {
      console.warn("Injected WebP verification failed, safely falling back to clean WebP:", testErr);
      URL.revokeObjectURL(testUrl);
      return originalBlob; // 壊れていた場合は元の正常なWebPを返す
    }
  } catch (err) {
    console.warn("Failed to inject WebP metadata, fallback:", err);
    return originalBlob;
  }
}

// ==========================================
// 🎬 MP4 FastStart 最適化エンジン (moov atom 先頭再配置)
// ==========================================
async function applyFastStartToMp4(mp4BlobOrBuffer) {
  try {
    const buffer = (mp4BlobOrBuffer instanceof ArrayBuffer) ? mp4BlobOrBuffer : await mp4BlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    const length = buffer.byteLength;

    let offset = 0;
    let ftypAtom = null;
    let moovAtom = null;
    let moovOffset = -1;
    let mdatOffset = -1;

    while (offset < length - 8) {
      let atomSize = view.getUint32(offset);
      const atomType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (atomSize === 1) {
        // 64-bit extended size
        atomSize = Number(view.getBigUint64(offset + 8));
      } else if (atomSize === 0) {
        atomSize = length - offset;
      }

      if (atomSize <= 0 || offset + atomSize > length) break;

      if (atomType === "ftyp" && !ftypAtom) {
        ftypAtom = new Uint8Array(buffer, offset, atomSize);
      } else if (atomType === "moov") {
        moovAtom = new Uint8Array(buffer, offset, atomSize);
        moovOffset = offset;
      } else if (atomType === "mdat" && mdatOffset === -1) {
        mdatOffset = offset;
      }

      offset += atomSize;
    }

    // moov が存在し、mdat より後ろにある場合のみ先頭（ftypの直後）へ引っ越しさせる
    if (!moovAtom || mdatOffset === -1 || moovOffset < mdatOffset) {
      return mp4BlobOrBuffer; // 既に先頭にあるか、未対応
    }

    const moovSize = moovAtom.byteLength;
    // moov 内の stco (32-bit offset) と co64 (64-bit offset) を moovSize 分だけ前方シフト修正
    const patchedMoov = new Uint8Array(moovAtom);
    const moovView = new DataView(patchedMoov.buffer, patchedMoov.byteOffset, patchedMoov.byteLength);

    for (let i = 0; i < patchedMoov.length - 8; i++) {
      const tag = String.fromCharCode(
        patchedMoov[i],
        patchedMoov[i + 1],
        patchedMoov[i + 2],
        patchedMoov[i + 3]
      );

      if (tag === "stco") {
        const count = moovView.getUint32(i + 8);
        let entryOffset = i + 12;
        for (let c = 0; c < count; c++) {
          const curVal = moovView.getUint32(entryOffset);
          moovView.setUint32(entryOffset, curVal + moovSize);
          entryOffset += 4;
        }
      } else if (tag === "co64") {
        const count = moovView.getUint32(i + 8);
        let entryOffset = i + 12;
        for (let c = 0; c < count; c++) {
          const curVal = moovView.getBigUint64(entryOffset);
          moovView.setBigUint64(entryOffset, curVal + BigInt(moovSize));
          entryOffset += 8;
        }
      }
    }

    // 新しい MP4 の組み立て: [ftyp] + [patchedMoov] + [mdat以降のデータ(moov以外)]
    const newLength = length;
    const resultBuffer = new Uint8Array(newLength);
    let writePos = 0;

    if (ftypAtom) {
      resultBuffer.set(ftypAtom, writePos);
      writePos += ftypAtom.byteLength;
    }

    resultBuffer.set(patchedMoov, writePos);
    writePos += patchedMoov.byteLength;

    // ftyp 以降から moov 以外の部分をコピー
    const startAfterFtyp = ftypAtom ? ftypAtom.byteLength : 0;
    const beforeMoov = new Uint8Array(buffer, startAfterFtyp, moovOffset - startAfterFtyp);
    resultBuffer.set(beforeMoov, writePos);
    writePos += beforeMoov.byteLength;

    const afterMoovOffset = moovOffset + moovSize;
    if (afterMoovOffset < length) {
      const afterMoov = new Uint8Array(buffer, afterMoovOffset, length - afterMoovOffset);
      resultBuffer.set(afterMoov, writePos);
    }

    return new Blob([resultBuffer], { type: "video/mp4" });
  } catch (err) {
    console.warn("MP4 FastStart optimization skipped due to error:", err);
    return mp4BlobOrBuffer;
  }
}

// 🖼️ 動画の0秒目（先頭フレーム）を軽量WebPサムネイルとして高速抽出
async function captureVideoFirstFrame(videoBlob) {
  return new Promise((resolve) => {
    try {
      const video = document.createElement("video");
      const url = URL.createObjectURL(videoBlob);
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;

      let resolved = false;
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          URL.revokeObjectURL(url);
          video.remove();
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 5000); // 最大5秒でタイムアウト

      video.onloadeddata = () => {
        try {
          video.currentTime = 0;
        } catch (e) {}
      };

      video.onseeked = async () => {
        try {
          const canvas = document.createElement("canvas");
          const maxDim = 640;
          let w = video.videoWidth || 640;
          let h = video.videoHeight || 360;

          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }

          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, w, h);

          canvas.toBlob((blob) => {
            clearTimeout(timer);
            cleanup();
            resolve(blob);
          }, "image/webp", 0.82);
        } catch (err) {
          console.warn("Frame capture canvas error:", err);
          clearTimeout(timer);
          cleanup();
          resolve(null);
        }
      };

      video.onerror = () => {
        clearTimeout(timer);
        cleanup();
        resolve(null);
      };
    } catch (e) {
      console.warn("captureVideoFirstFrame error:", e);
      resolve(null);
    }
  });
}

async function detectComfyMetadata(file) {
  if (!file) return { hasWorkflow: false, hasPrompt: false, hasA1111: false, type: "none" };

  const fileName = (file.name || "").toLowerCase();
  const isPng = fileName.endsWith(".png") || file.type === "image/png";
  const isMp4 = fileName.endsWith(".mp4") || file.type === "video/mp4";
  const isWebm = fileName.endsWith(".webm") || file.type === "video/webm";

  let promptDetails = null;

  try {
    // 1. 先頭領域（10MB以下の動画クリップは全体、それ以外は先頭 5MB）
    const isSmallVideo = (isMp4 || isWebm) && file.size <= 10 * 1024 * 1024;
    const headSize = isSmallVideo ? file.size : Math.min(file.size, 5 * 1024 * 1024);
    const headBuffer = await file.slice(0, headSize).arrayBuffer();

    if (isPng) {
      const view = new DataView(headBuffer);
      if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
        let offset = 8;
        const length = headBuffer.byteLength;
        let hasWorkflow = false;
        let hasPrompt = false;
        let hasA1111 = false;
        let nodeCount = 0;

        while (offset < length - 8) {
          const chunkLength = view.getUint32(offset);
          offset += 4;
          const chunkType = String.fromCharCode(
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
            view.getUint8(offset + 3)
          );
          offset += 4;

          if (chunkType === "IEND") break;

          if (chunkType === "tEXt" || chunkType === "iTXt") {
            const chunkData = new Uint8Array(headBuffer, offset, chunkLength);
            let nullIndex = -1;
            for (let i = 0; i < chunkData.length; i++) {
              if (chunkData[i] === 0) { nullIndex = i; break; }
            }
            if (nullIndex > 0) {
              const keyword = new TextDecoder("utf-8").decode(chunkData.subarray(0, nullIndex));
              if (keyword === "workflow") {
                hasWorkflow = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  const wfJson = JSON.parse(text);
                  if (Array.isArray(wfJson.nodes)) nodeCount = wfJson.nodes.length;
                  if (!promptDetails) promptDetails = parseComfyPromptJson(wfJson);
                } catch (e) {}
              } else if (keyword === "prompt") {
                hasPrompt = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  const parsed = parseComfyPromptJson(text);
                  if (parsed && parsed.prompt) promptDetails = parsed;
                } catch (e) {}
              } else if (keyword === "parameters") {
                hasA1111 = true;
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  promptDetails = parseA1111Parameters(text);
                } catch (e) {}
              } else if (keyword === "Comment") {
                try {
                  const text = new TextDecoder("utf-8").decode(chunkData.subarray(nullIndex + 1));
                  if (!promptDetails) promptDetails = parseNovelAiComment(text);
                } catch (e) {}
              }
            }
          }

          offset += chunkLength + 4;
        }

        if (hasWorkflow) return { hasWorkflow: true, hasPrompt, hasA1111, nodeCount, type: "comfy_workflow", promptDetails };
        if (hasPrompt) return { hasWorkflow: false, hasPrompt: true, hasA1111, type: "comfy_prompt", promptDetails };
        if (hasA1111) return { hasWorkflow: false, hasPrompt: false, hasA1111: true, type: "a1111", promptDetails };
      }
    }

    // 2. テキスト判定
    let textSample = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(headBuffer));

    // 3. 動画（MP4 / WebM）で 10MB 超の場合、末尾（moov atom）も読み込む
    if ((isMp4 || isWebm) && file.size > headSize) {
      const tailSize = Math.min(file.size, 5 * 1024 * 1024);
      const tailBuffer = await file.slice(file.size - tailSize).arrayBuffer();
      const tailText = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(tailBuffer));
      textSample = textSample + "\n" + tailText;
    }

    // 判定ロジック（ComfyUI-VideoHelperSuite / VHS 形式対応 & 汎用プロンプト検出）
    const hasWf = (textSample.includes('"nodes"') && textSample.includes('"links"')) ||
                  (textSample.includes('"workflow"') && textSample.includes('"nodes"'));
    let hasPrompt = (textSample.includes('"inputs"') && (textSample.includes('"class_type"') || textSample.includes('"text"'))) ||
                    textSample.includes('"client_id"') || textSample.includes('"extra_pnginfo"');
    const hasA1111 = textSample.includes("Negative prompt:") || textSample.includes("Steps: ");

    if (!promptDetails) {
      if (hasA1111) {
        const m = textSample.match(/([\s\S]+?)(Negative prompt:[\s\S]+?)(Steps:\s*\d+[\s\S]*)/);
        if (m) {
          promptDetails = parseA1111Parameters(m[0]);
        } else {
          const negIdx = textSample.indexOf("Negative prompt:");
          if (negIdx !== -1) {
            const start = Math.max(0, negIdx - 800);
            promptDetails = parseA1111Parameters(textSample.substring(start, negIdx + 800));
          }
        }
      }

      if (!promptDetails) {
        promptDetails = extractPromptsFromRawText(textSample);
      }
    }

    if (promptDetails && promptDetails.prompt) {
      hasPrompt = true;
    }

    if (hasWf) return { hasWorkflow: true, hasPrompt: true, hasA1111: false, type: "comfy_workflow", promptDetails };
    if (hasPrompt) return { hasWorkflow: false, hasPrompt: true, hasA1111: false, type: "comfy_prompt", promptDetails };
    if (hasA1111) return { hasWorkflow: false, hasPrompt: false, hasA1111: true, type: "a1111", promptDetails };
    if (promptDetails && promptDetails.prompt) return { hasWorkflow: false, hasPrompt: true, hasA1111: false, type: "ai_metadata", promptDetails };

  } catch (err) {
    console.warn("Metadata detection error:", err);
  }

  return { hasWorkflow: false, hasPrompt: Boolean(promptDetails?.prompt), hasA1111: false, type: promptDetails ? "comfy_prompt" : "none", promptDetails };
}

function createComfyBadgeHtml(file, result) {
  const meta = file.metaStatus;
  if (!meta) return '<div style="font-size: 10px; color: var(--muted); margin-top: 3px;">🔍 メタデータ解析中...</div>';

  const isConvertOn = enableConvertCheck?.checked ?? true;

  let badge = "";
  if (meta.hasWorkflow) {
    badge = `
      <span class="meta-badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10.5px; padding: 2px 6px; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;" title="ComfyUIのワークフロー（ノード接続・配置情報）が完全な形で含まれています。ComfyUI画面にドロップすると完全再現可能です。">
        <span>🧬 ComfyUI ワークフロー完全内包</span>
        ${meta.nodeCount ? `<span style="font-size: 9.5px; opacity: 0.85;">(${meta.nodeCount}ノード)</span>` : ""}
      </span>
    `;
  } else if (meta.hasPrompt) {
    badge = `
      <span class="meta-badge" style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 10.5px; padding: 2px 6px; border-radius: 4px; font-weight: 600;" title="ComfyUIのプロンプト/API情報が含まれています。">
        📝 ComfyUI プロンプト情報あり
      </span>
    `;
  } else if (meta.hasA1111) {
    badge = `
      <span class="meta-badge" style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); font-size: 10.5px; padding: 2px 6px; border-radius: 4px; font-weight: 600;" title="WebUI (A1111) 生成パラメータが含まれています。">
        📋 WebUI (A1111) 生成情報あり
      </span>
    `;
  } else {
    badge = `
      <span class="meta-badge" style="background: rgba(255, 255, 255, 0.05); color: var(--muted); border: 1px solid var(--border); font-size: 10px; padding: 1px 5px; border-radius: 4px;" title="ワークフローメタデータは検出されませんでした（Exif削除済みまたは非AI画像）。">
        ⚪ ワークフローなし
      </span>
    `;
  }

  const fileExt = (file.name || "").split('.').pop().toLowerCase();
  const isVideo = ["mp4", "webm", "mov"].includes(fileExt) || file.type?.startsWith("video/");
  let statusNotice = "";
  if (meta.hasWorkflow || meta.hasPrompt) {
    if (isConvertOn && !isVideo) {
      statusNotice = '<span style="font-size: 10px; color: #f87171; margin-left: 4px;" title="画像を変換（再エンコード）するとブラウザの仕様によりワークフローは削除されます。保持したい場合は『画像を変換する』をOFFにしてください。">⚠️ 変換ONのためExif/WFは削除されます</span>';
    } else {
      statusNotice = '<span style="font-size: 10px; color: #34d399; margin-left: 4px;">🛡️ ワークフロー保持のまま保存/共有されます</span>';
    }
  }

  return `<div class="comfy-meta-row" style="margin-top: 3px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">${badge}${statusNotice}</div>`;
}

async function checkRemoteFileWf(key, publicUrl) {
  if (!key || !publicUrl) return false;
  const ext = key.split('.').pop().toLowerCase();
  if (!["png", "webp", "mp4", "webm"].includes(ext)) return false;

  let wfStore = {};
  try {
    wfStore = JSON.parse(localStorage.getItem("comfyWfMap") || "{}");
  } catch (e) {}

  if (wfStore[key] !== undefined) return wfStore[key];

  try {
    const res = await fetch(publicUrl, { headers: { Range: "bytes=0-131072" } });
    if (res.ok || res.status === 206) {
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf));
      const hasWf = (text.includes('"nodes"') && text.includes('"links"')) ||
                    (text.includes('"inputs"') && text.includes('"class_type"')) ||
                    text.includes('"workflow"');
      wfStore[key] = hasWf;
      localStorage.setItem("comfyWfMap", JSON.stringify(wfStore));
      return hasWf;
    }
  } catch (err) {
    console.debug("Remote WF check skipped:", err);
  }
  return false;
}

// 許可する拡張子一覧（アーカイブ除外、メディア・テキスト系に限定）
const ALLOWED_EXT_LIST = new Set([
  // 画像
  "jpg", "jpeg", "png", "webp", "gif", "avif", "jxl", "bmp", "ico",
  // 動画
  "mp4", "webm", "ogv", "mov", "m4v", "avi",
  // 音声
  "mp3", "wav", "ogg", "m4a", "flac", "aac",
  // 文書・テキスト
  "pdf", "txt", "md", "json", "csv",
]);

// 危険なファイル・アーカイブ（明確に除外）
const BLOCKED_EXT_LIST = new Set([
  "exe", "bat", "cmd", "ps1", "sh", "msi", "com", "vbs", "html", "htm", "js", "mjs", "cjs", "php", "py", "svg",
  // アーカイブ（zip, 7z, rar等）は除外
  "zip", "7z", "rar", "tar", "gz", "bz2", "xz"
]);

function isFileAcceptable(file) {
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  if (BLOCKED_EXT_LIST.has(ext)) return false;
  if (ALLOWED_EXT_LIST.has(ext)) return true;
  if (file.type && (file.type.startsWith("image/") || file.type.startsWith("audio/") || file.type.startsWith("video/"))) {
    return true;
  }
  return false;
}

function addFiles(files) {
  let blockedCount = 0;
  const allowed = files.filter((file) => {
    const ok = isFileAcceptable(file);
    if (!ok) blockedCount++;
    return ok;
  });

  if (blockedCount > 0) {
    alert(`⚠️ 実行ファイルやスクリプトなどの危険なファイル形式（${blockedCount}件）は除外されました。`);
  }

  state.files.push(...allowed);
  invalidateConversionCache();
  render();

  // 🧬 ファイル追加時に非同期で ComfyUI メタデータを自動解析（画像ファイルのみ）
  allowed.forEach(f => {
    const ext = f.name.includes(".") ? f.name.split(".").pop().toLowerCase() : "";
    const isImage = (f.type && f.type.startsWith("image/")) || ["jpg", "jpeg", "png", "webp", "avif", "jxl"].includes(ext);
    if (isImage) {
      detectComfyMetadata(f).then(meta => {
        f.metaStatus = meta;
        render();
      }).catch(err => {
        console.warn("Meta parse error:", err);
        f.metaStatus = { hasWorkflow: false, type: "none" };
        render();
      });
    } else {
      f.metaStatus = { hasWorkflow: false, type: "none" };
    }
  });
}

function setUiLock(locked) {
  const r2Ok = isR2Configured();
  const fbOk = isFilebaseConfigured();
  const hasFiles = state.files.length > 0;
  const isConvertOn = enableConvertCheck?.checked ?? true;
  const isRenameOn = enableRenameCheck?.checked ?? true;
  const isZipOn = enableZipCheck?.checked ?? false;
  const canProcessLocal = isConvertOn || isRenameOn || isZipOn;

  if (fileInput) fileInput.disabled = locked;
  if (dropzone) dropzone.classList.toggle("is-disabled", locked);
  if (clearButton) clearButton.disabled = locked;
  if (convertDownloadButton) {
    convertDownloadButton.disabled = locked || !hasFiles || !canProcessLocal;
    convertDownloadButton.title = (!canProcessLocal && hasFiles)
      ? "画像変換・リネーム・ZIPまとめ保存がすべてオフのためダウンロード無効"
      : "";
  }
  if (convertUploadR2Button) convertUploadR2Button.disabled = locked || !hasFiles || !r2Ok;
  if (convertUploadFilebaseButton) convertUploadFilebaseButton.disabled = locked || !hasFiles || !fbOk;
}

function updateRenamePreview() {
  const previewText = document.querySelector("#renamePreviewText");
  if (!previewText) return;

  const firstFile = state.files[0];
  const firstExt = firstFile ? (firstFile.name.split('.').pop() || "") : "";
  const isFirstImage = firstFile
    ? (firstFile.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"].includes(firstExt.toLowerCase()))
    : true;

  const isRenameOn = enableRenameCheck?.checked ?? true;
  const isConvertOn = enableConvertCheck?.checked ?? true;

  // 画像以外（MP3等）なら変換設定に関わらず元拡張子を維持
  const ext = (isConvertOn && isFirstImage)
    ? (extensions[formatSelect?.value || "image/webp"] || "webp")
    : (firstExt || "ext");

  const dummyName = firstFile ? firstFile.name.replace(/\.[^.]+$/, "") : "sample";

  if (!isRenameOn) {
    previewText.textContent = `${dummyName}.${ext}`;
    return;
  }

  const rawPattern = renamePattern?.value;
  const pattern = (rawPattern !== undefined && rawPattern !== "") ? rawPattern : "{name}";
  
  let previewName = pattern.replaceAll("{name}", dummyName);

  previewName = previewName.replace(/\{rand[ao]m(?::(\d+))?\}/g, (match, digits) => {
    const len = digits ? parseInt(digits, 10) : 6;
    return "a8Kx21".slice(0, Math.min(len, 6)).padEnd(len, "x");
  });

  previewName = previewName.replace(/\{num(?::(\d+))?\}/g, (match, digits) => {
    const targetLength = digits ? parseInt(digits, 10) : 1;
    return "1".padStart(targetLength, "0");
  });

  previewName = previewName.replace(/[\\/:*?"<>|]/g, "-");
  previewText.textContent = truncateFilename(`${previewName}.${ext}`, 100);
}

// --- インプレース描画 (Unified File Card) ---
function render() {
  const r2Ok = isR2Configured();
  const fbOk = isFilebaseConfigured();
  const hasFiles = state.files.length > 0;
  if (fileCount) fileCount.textContent = `${state.files.length}件`;

  const isConvertOn = enableConvertCheck?.checked ?? true;
  const isRenameOn = enableRenameCheck?.checked ?? true;
  const isZipOn = enableZipCheck?.checked ?? false;
  const canProcessLocal = isConvertOn || isRenameOn || isZipOn;

  if (convertDownloadButton) {
    convertDownloadButton.disabled = !hasFiles || !canProcessLocal;
    convertDownloadButton.title = (!canProcessLocal && hasFiles)
      ? "画像変換・リネーム・ZIPまとめ保存がすべてオフのためダウンロード無効"
      : "";
  }
  if (convertUploadR2Button) convertUploadR2Button.disabled = !hasFiles || !r2Ok;
  if (convertUploadFilebaseButton) convertUploadFilebaseButton.disabled = !hasFiles || !fbOk;

  if (dropzone) {
    dropzone.classList.toggle("has-files", hasFiles);
  }

  updateRenamePreview();

  if (fileList) {
    fileList.innerHTML = "";
    const lang = getAppLanguage();
    const dict = i18nDict[lang] || i18nDict.ja;

    state.files.forEach((file, index) => {
      try {
        const result = state.results[index];
        const item = document.createElement("article");
        item.className = "file-item unified-file-card";
        item.dataset.index = index;

        const originalExt = file.name ? file.name.split('.').pop().toLowerCase() : "";

        let previewSrc = "";
        if (result && result.previewUrl) {
          previewSrc = result.previewUrl;
        } else if (file.type && file.type.startsWith("image/")) {
          previewSrc = URL.createObjectURL(file);
        }

        const displayName = result ? result.name : file.name;
        const duplicateNoticeHtml = result?.duplicateOf
          ? `<div class="duplicate-upload-note" style="margin-top: 4px; font-size: 10.5px; color: #a5b4fc; line-height: 1.35;">♻️ 同一内容を検出: 再アップロードせず「${escapeHtml(result.duplicateOf)}」の別名URLを作成しました</div>`
          : "";

        let metaHtml = "";
        if (result && result.size) {
          if (result.isNonImage || !isConvertOn) {
            metaHtml = `${formatBytes(result.size)} · <span style="color: var(--muted);">${escapeHtml(dict.nonConverted || "非変換")}</span>`;
          } else {
            const diff = file.size - result.size;
            const savedRate = file.size ? Math.round((diff / file.size) * 100) : 0;
            let rateText = "";
            if (savedRate > 0) {
              rateText = `<span style="color: #22c55e; font-weight: bold;">${savedRate}% 削減</span>`;
            } else if (savedRate < 0) {
              rateText = `<span style="color: #f87171; font-weight: bold;">${Math.abs(savedRate)}% 増加</span>`;
            } else {
              rateText = `<span style="color: var(--muted);">±0%</span>`;
            }
            metaHtml = `${formatBytes(file.size)} ➔ <strong style="color: #fff;">${formatBytes(result.size)}</strong> (${rateText})`;
          }
        } else {
          metaHtml = `${formatBytes(file.size)} · <span style="color: var(--muted);">${escapeHtml(dict.statusWaiting || "待機中")}</span>`;
        }

        const hasPromptDetails = Boolean(file.metaStatus?.promptDetails?.prompt);
        const promptBtnHtml = hasPromptDetails
          ? `<button type="button" class="ghost-button copy-prompt-btn" data-index="${index}" style="height: 28px; font-size: 11px; padding: 0 8px; color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); display: inline-flex; align-items: center; gap: 3px;" title="AIプロンプトをコピー">📝 ${escapeHtml(dict.copyPrompt || "プロンプトコピー")}</button>`
          : "";

        item.innerHTML = `
          <div class="card-thumb-area">
            ${previewSrc ? `<img class="thumb" src="${previewSrc}" alt="" loading="lazy">` : `<div class="thumb format-badge">${escapeHtml(originalExt.toUpperCase() || "FILE")}</div>`}
          </div>
          <div class="card-main-area">
            <div class="card-title-row">
              <span class="file-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
            </div>
            <div class="card-meta-row">
              ${metaHtml}
            </div>
            ${createComfyBadgeHtml(file, result)}
            ${duplicateNoticeHtml}
          </div>
          <div class="card-actions-area item-actions-col" style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto;">
            ${promptBtnHtml}
            ${createCardActionHtml(file, result, index)}
            <button type="button" class="ghost-button delete-button danger-button" data-index="${index}" aria-label="削除" title="一覧から削除" style="min-width: 28px; height: 28px; padding: 0 6px; font-size: 14px; line-height: 1;">&times;</button>
          </div>
        `;
        fileList.append(item);
      } catch (err) {
        console.error("Card render error:", err);
      }
    });

    const totalPrompts = state.files.filter(f => f.metaStatus?.promptDetails?.prompt).length;
    if (copyAllPromptsBtn) {
      if (totalPrompts > 0) {
        copyAllPromptsBtn.style.display = "inline-flex";
        copyAllPromptsBtn.textContent = `📝 ${dict.copyAllPrompts || "プロンプト一括コピー"} (${totalPrompts})`;
      } else {
        copyAllPromptsBtn.style.display = "none";
      }
    }
  }
}

function createCardActionHtml(file, result, index) {
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;

  const isConvertOn = enableConvertCheck?.checked ?? true;
  const isRenameOn = enableRenameCheck?.checked ?? true;
  const canProcessLocal = isConvertOn || isRenameOn;
  const r2Ok = isR2Configured();
  const fbOk = isFilebaseConfigured();
  const upOk = r2Ok || fbOk;

  const dlBtnDisabled = (!canProcessLocal && !result) ? "disabled" : "";
  const dlBtnTitle = (!canProcessLocal && !result)
    ? "変換・リネームが両方オフのためダウンロード無効"
    : "ダウンロード";

  if (result && result.isUploading) {
    const pName = result.uploadingProvider === "filebase" ? "IPFS" : "R2";
    return `<span class="status-text saving" style="font-size: 11px;">${pName} UP中...</span>`;
  }

  const currentProviderName = (activeStorageTab === "filebase" && fbOk) ? "Filebase (IPFS)" : (r2Ok ? "Cloudflare R2" : (fbOk ? "Filebase (IPFS)" : "ストレージ"));
  const upBtnTitle = upOk
    ? `このファイルだけ変換して${currentProviderName}へアップロード`
    : "ストレージ未設定のためアップロード不可";
  const upBtnStyle = upOk
    ? "font-size: 11px; padding: 0 8px; height: 28px;"
    : "opacity: 0.35; font-size: 11px; padding: 0 8px; height: 28px; cursor: not-allowed;";

  const currentName = result ? result.name : file.name;
  const ext = currentName.split('.').pop().toLowerCase();
  const isCivitaiSupported = ["jpg", "jpeg", "png", "webp", "mp4", "webm"].includes(ext);
  const isProtected = Boolean(file.hasPassword || result?.hasPassword);
  const civitaiOk = upOk && isCivitaiSupported && !isProtected;
  const civitaiStyle = civitaiOk
    ? "color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); font-size: 11px; padding: 0 8px; height: 28px;"
    : "opacity: 0.35; font-size: 11px; padding: 0 8px; height: 28px; cursor: not-allowed;";
  let civitaiBtnTitle = "リネームを無視して変換・5分間だけ一時保存し、Civitaiの投稿画面を開く";
  if (!upOk) civitaiBtnTitle = "ストレージ未接続のためCivitai連携不可";
  else if (!isCivitaiSupported) civitaiBtnTitle = "Civitai非対応フォーマット";
  else if (isProtected) civitaiBtnTitle = "パスワード保護中のファイルはCivitai連携不可";

  if (result && result.isUploaded) {
    const isFb = result.uploadedProvider === "filebase";
    const deliveryUrl = getSelectedDeliveryUrl(result);
    const badgeHtml = isFb
      ? `<span style="font-size: 9.5px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); padding: 1px 5px; border-radius: 4px;">🪐 IPFS</span>`
      : `<span style="font-size: 9.5px; font-weight: 700; color: #fb923c; background: rgba(249, 115, 22, 0.15); border: 1px solid rgba(249, 115, 22, 0.4); padding: 1px 5px; border-radius: 4px;">⚡ R2</span>`;

    const pwdBadge = result.hasPassword
      ? `<span class="password-badge" style="font-size: 9.5px; font-weight: 600; color: #818cf8; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); padding: 1px 5px; border-radius: 4px;" title="合言葉: ${result.password ? escapeHtml(result.password) : '保護中'}">🔒 保護</span>`
      : "";

    return `
      ${badgeHtml}
      ${pwdBadge}
      <input type="text" class="url-output" value="${escapeHtml(deliveryUrl)}" readonly style="width: 140px; font-size: 11px; height: 28px; padding: 0 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(56,189,248,0.4); color: #38bdf8; border-radius: 4px;" title="クリックで全選択＆コピー" onclick="this.select()">
      <button type="button" class="ghost-button copy-button" style="font-size: 11px; padding: 0 8px; height: 28px;">${escapeHtml(dict.copyUrl || "コピー")}</button>
      <button type="button" class="ghost-button download-single-btn" data-index="${index}" style="font-size: 11px; padding: 0 8px; height: 28px;" title="${dlBtnTitle}" ${dlBtnDisabled}>📥 DL</button>
      ${!result.hasPassword ? `<button type="button" class="ghost-button civitai-post-btn" data-index="${index}" data-url="${escapeHtml(deliveryUrl)}" data-name="${escapeHtml(result.name)}" style="${civitaiStyle}" title="${civitaiBtnTitle}" ${civitaiOk ? '' : 'disabled'}>🎨 Civitai</button>` : ""}
    `;
  }

  // 待機中または変換完了時: [📥 DL] [⚡ R2] [🪐 IPFS] [🎨 Civitai]
  const r2Style = r2Ok
    ? "font-size: 11px; padding: 0 8px; height: 28px; color: #fb923c; border-color: rgba(249, 115, 22, 0.4);"
    : "opacity: 0.35; font-size: 11px; padding: 0 8px; height: 28px; cursor: not-allowed;";
  const fbStyle = fbOk
    ? "font-size: 11px; padding: 0 8px; height: 28px; color: #38bdf8; border-color: rgba(56, 189, 248, 0.4);"
    : "opacity: 0.35; font-size: 11px; padding: 0 8px; height: 28px; cursor: not-allowed;";

  return `
    <button type="button" class="ghost-button download-single-btn" data-index="${index}" style="font-size: 11px; padding: 0 8px; height: 28px;" title="${dlBtnTitle}" ${dlBtnDisabled}>📥 DL</button>
    <button type="button" class="ghost-button upload-r2-btn" data-index="${index}" style="${r2Style}" title="${r2Ok ? 'このファイルをCloudflare R2へアップロード' : 'R2接続設定が未完了'}" ${r2Ok ? '' : 'disabled'}>⚡ R2</button>
    <button type="button" class="ghost-button upload-filebase-btn" data-index="${index}" style="${fbStyle}" title="${fbOk ? 'このファイルをFilebase (IPFS)へアップロード' : 'Filebase接続設定が未完了'}" ${fbOk ? '' : 'disabled'}>🪐 IPFS</button>
    <button type="button" class="ghost-button civitai-post-btn" data-index="${index}" style="${civitaiStyle}" title="${civitaiBtnTitle}" ${civitaiOk ? '' : 'disabled'}>🎨 Civitai</button>
  `;
}

copyAllPromptsBtn?.addEventListener("click", async () => {
  const promptList = state.files
    .filter(f => f?.metaStatus?.promptDetails?.prompt)
    .map(f => {
      const p = f.metaStatus.promptDetails;
      let text = `【${f.name}】\n${p.prompt}`;
      if (p.negativePrompt) text += `\nNegative prompt: ${p.negativePrompt}`;
      if (p.params) text += `\n${p.params}`;
      return text;
    });
  if (promptList.length > 0) {
    const textToCopy = promptList.join("\n\n" + "=".repeat(30) + "\n\n");
    await copyToClipboard(textToCopy, copyAllPromptsBtn, "📋 全プロンプトコピー完了!");
  }
});

// ファイルリストイベント委譲
fileList?.addEventListener("click", async (event) => {
  const target = event.target;
  const card = target.closest(".unified-file-card");
  if (!card) return;

  const index = Number(target.dataset.index ?? card.dataset.index);

  // 0. プロンプト個別コピーボタン
  const promptBtn = target.closest(".copy-prompt-btn");
  if (promptBtn) {
    const idx = Number(promptBtn.dataset.index ?? card.dataset.index);
    const f = state.files[idx];
    const p = f?.metaStatus?.promptDetails;
    if (p && p.prompt) {
      let copyText = p.prompt;
      if (p.negativePrompt) copyText += `\nNegative prompt: ${p.negativePrompt}`;
      await copyToClipboard(copyText, promptBtn, "📋 コピー完了!");
    }
    return;
  }

  // 1. 削除ボタン
  if (target.classList.contains("delete-button")) {
    if (!isNaN(index) && index >= 0 && index < state.files.length) {
      const removedResult = state.results[index];
      if (removedResult) {
        if (removedResult.url) URL.revokeObjectURL(removedResult.url);
        if (removedResult.previewUrl) URL.revokeObjectURL(removedResult.previewUrl);
      }
      state.files.splice(index, 1);
      state.results.splice(index, 1);
      render();
    }
    return;
  }

  // 2. 単体ダウンロード
  if (target.classList.contains("download-single-btn")) {
    if (isNaN(index) || index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    let result = state.results[index];

    target.disabled = true;
    target.textContent = "...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        state.results[index] = result;
      }
      downloadUrl(result.url, result.name);
    } catch (e) {
      console.error(e);
      alert("ダウンロードに失敗しました: " + e.message);
    } finally {
      target.disabled = false;
      target.textContent = "📥 DL";
      render();
    }
    return;
  }

  // 3. 単体アップロード (☁️ UP: BYOC準拠・選択中ストレージへ自動アップロード)
  if (target.classList.contains("upload-single-btn")) {
    if (isNaN(index) || index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    let result = state.results[index];

    target.disabled = true;
    target.textContent = "UP中...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        state.results[index] = result;
      }
      const r2Ok = isR2Configured();
      const fbOk = isFilebaseConfigured();
      const targetProvider = (activeStorageTab === "filebase" && fbOk) ? "filebase" : (r2Ok ? "r2" : (fbOk ? "filebase" : "r2"));
      const success = await uploadImage(result, targetProvider);
      if (success) {
        await fetchAndRenderR2Files();
      }
    } catch (e) {
      console.error(e);
      alert("アップロードに失敗しました: " + e.message);
    } finally {
      render();
    }
    return;
  }

  // 3.1 単体アップロード (⚡ R2)
  if (target.classList.contains("upload-r2-btn")) {
    if (isNaN(index) || index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    let result = state.results[index];

    target.disabled = true;
    target.textContent = "UP中...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        state.results[index] = result;
      }
      const success = await uploadImage(result, "r2");
      if (success) {
        await fetchAndRenderR2Files();
      }
    } catch (e) {
      console.error(e);
      alert("R2 アップロードに失敗しました: " + e.message);
    } finally {
      render();
    }
    return;
  }

  // 3.1 単体アップロード (🪐 Filebase)
  if (target.classList.contains("upload-filebase-btn")) {
    if (isNaN(index) || index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    let result = state.results[index];

    target.disabled = true;
    target.textContent = "UP中...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        state.results[index] = result;
      }
      const success = await uploadImage(result, "filebase");
      if (success) {
        await fetchAndRenderR2Files();
      }
    } catch (e) {
      console.error(e);
      alert("Filebase アップロードに失敗しました: " + e.message);
    } finally {
      render();
    }
    return;
  }

  // 3.5 Civitai 転送
  if (target.classList.contains("civitai-post-btn")) {
    if (isNaN(index) || index < 0 || index >= state.files.length) return;
    const file = state.files[index];
    let result = state.results[index];

    // すでにアップロード済みの場合は直接開く
    if (result && result.isUploaded && result.proxyUrl) {
      openCivitaiIntent(result.proxyUrl, result.name);
      return;
    }

    // 🛡️ ポップアップブロック回避：クリック直後に空タブを先行オープン
    let preloadWindow = null;
    try {
      preloadWindow = window.open("about:blank", "_blank");
      if (preloadWindow) {
        preloadWindow.document.write(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>🎨 Civitai 転送準備中...</title></head>
          <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f8fafc;text-align:center;padding:20px;">
            <div style="font-size:42px;margin-bottom:16px;">🎨</div>
            <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:700;">Civitai 転送準備中...</h2>
            <p style="margin:0;color:#94a3b8;font-size:14px;max-width:380px;line-height:1.5;">画像を高速変換＆アップロードしています。<br>完了後に自動で Civitai の投稿画面が開きます。</p>
          </body>
          </html>
        `);
      }
    } catch (e) {
      console.warn("Preload window failed:", e);
    }

    target.disabled = true;
    target.textContent = "転送準備中...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        state.results[index] = result;
      }
      const targetProvider = isR2Configured() ? "r2" : "filebase";
      const success = await uploadImage(result, targetProvider, null, {
        // Civitai は intent を開いた時点でメディアを取り込むため、ここは共有用ではなく短期の踏み台にする。
        ttlSeconds: 5 * 60,
        civitaiTemporary: true,
      });
      if (success && result.proxyUrl) {
        await fetchAndRenderR2Files();
        openCivitaiIntent(result.proxyUrl, result.name, preloadWindow);
      } else {
        if (preloadWindow && !preloadWindow.closed) preloadWindow.close();
      }
    } catch (e) {
      console.error(e);
      if (preloadWindow && !preloadWindow.closed) preloadWindow.close();
      alert("Civitai 転送準備に失敗しました: " + e.message);
    } finally {
      render();
    }
    return;
  }

  // 4. URL コピー
  const copyBtn = target.closest(".copy-button");
  if (copyBtn) {
    const inputEl = card.querySelector(".url-output");
    const result = state.results[index];
    // 共有URLは常に選択中の配信ドメインとファイル名で構築する。CIDを含む
    // 内部リレーURLや、アップロード時に残った古いドメインはコピーしない。
    let urlToCopy = getSelectedDeliveryUrl(result) || inputEl?.value?.trim() || result?.proxyUrl || "";

    if (inputEl) {
      inputEl.value = urlToCopy;
      inputEl.select();
    }
    if (result && urlToCopy) result.proxyUrl = urlToCopy;
    await copyToClipboard(urlToCopy, copyBtn);
    return;
  }
});

// 🌐 変換結果カード内のドメイン着せ替えセレクト変更
fileList?.addEventListener("change", (e) => {
  if (e.target.classList.contains("result-card-domain-select")) {
    const card = e.target.closest(".unified-file-card");
    const index = Number(card?.dataset?.index);
    const newDomain = e.target.value;
    const inputEl = card?.querySelector(".url-output");
    const result = state.results[index];

    if (inputEl && newDomain) {
      const updatedUrl = switchUrlDomain(inputEl.value, newDomain);
      inputEl.value = updatedUrl;
      if (result) result.proxyUrl = updatedUrl;
      // Civitai ボタンの URL も更新
      const civitaiBtn = card?.querySelector(".civitai-post-btn");
      if (civitaiBtn) civitaiBtn.dataset.url = updatedUrl;

      // 🌐 KV台帳に登録済みの場合は allowedHost も非同期で自動更新
      if (result && result.name && hasAdminAccess()) {
        registerKvCid(
          result.name,
          result.ipfsCid || "",
          result.size || 0,
          result.mime || "",
          result.name,
          result.password || "",
          null,
          result.ttl || 0,
          result.expiresAt || null,
          false,
          null,
          newDomain
        ).catch(err => console.warn("Failed to update allowedHost on domain change:", err));
      }
    }
  }
});

// 🌐 R2/Filebaseファイル一覧カード内のイベント処理（TTL変更など）
r2FileList?.addEventListener("change", (e) => {

  // ⏳ R2/Filebaseファイル一覧カード内の有効期限プルダウン変更
  if (e.target.classList.contains("r2-file-ttl-select")) {
    const article = e.target.closest(".result-item");
    const ttlSeconds = Number(e.target.value || 0);
    const key = article?.dataset?.key;
    const s3Key = article?.dataset?.s3key || key;
    const cid = article?.dataset?.cid || "";
    const size = Number(article?.dataset?.size || 0);
    const currentDomain = article?.dataset?.allowedhost || article?.querySelector(".r2-file-domain-select")?.value || null;

    const expiresAt = ttlSeconds > 0 ? (Date.now() + ttlSeconds * 1000) : 0;
    article.dataset.expiresat = String(expiresAt);

    // UI上のバッジ表示を即座に更新
    let ttlBadge = article.querySelector(".ttl-countdown-badge");
    if (ttlSeconds > 0) {
      const hoursRemaining = Math.max(1, Math.ceil(ttlSeconds / 3600));
      const days = Math.floor(hoursRemaining / 24);
      const remHours = hoursRemaining % 24;
      const timeText = days > 0 ? `${days}日${remHours > 0 ? " " + remHours + "時間" : ""}` : `${hoursRemaining}時間`;
      if (!ttlBadge) {
        ttlBadge = document.createElement("span");
        ttlBadge.className = "ttl-countdown-badge";
        ttlBadge.style.cssText = "background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.5); font-size: 11px; padding: 2px 7px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;";
        const nameRow = article.querySelector(".item-name-row");
        if (nameRow) nameRow.appendChild(ttlBadge);
      }
      ttlBadge.textContent = `⏳ 残り ${timeText}`;
      ttlBadge.style.display = "inline-flex";
    } else {
      if (ttlBadge) ttlBadge.style.display = "none";
    }

    // 🌐 KV台帳の有効期限を即座に更新（既存ドメインallowedHostも維持して送信、0なら無期限化）
    if (key && hasAdminAccess()) {
      registerKvCid(
        key,
        cid,
        size,
        "",
        s3Key,
        "",
        null,
        ttlSeconds,
        expiresAt,
        false,
        null,
        currentDomain
      ).then(() => {
        // 成功フィードバック
        e.target.style.transition = "all 0.2s ease";
        e.target.style.borderColor = "#22c55e";
        setTimeout(() => { e.target.style.borderColor = ""; }, 600);
      }).catch(err => {
        console.warn("Failed to update TTL for " + key + ":", err);
        alert(`❌ 有効期限の更新に失敗しました: ${err.message}`);
      });
    }
  }
});

// ⏳ 変換結果カード内の有効期限プルダウン変更
fileList?.addEventListener("change", (e) => {
  if (e.target.classList.contains("result-card-ttl-select")) {
    const card = e.target.closest(".unified-file-card");
    const index = Number(card?.dataset?.index);
    const ttlSeconds = Number(e.target.value || 0);
    const result = state.results[index];

    if (result) {
      result.ttl = ttlSeconds;
      result.expiresAt = ttlSeconds > 0 ? (Date.now() + ttlSeconds * 1000) : null;

      if (result.name && hasAdminAccess()) {
        registerKvCid(
          result.name,
          result.ipfsCid || "",
          result.size || 0,
          result.mime || "",
          result.name,
          result.password || "",
          null,
          ttlSeconds,
          result.expiresAt,
          false,
          null,
          null
        ).then(() => {
          e.target.style.transition = "all 0.2s ease";
          e.target.style.borderColor = "#22c55e";
          setTimeout(() => { e.target.style.borderColor = ""; }, 600);
        }).catch(err => console.warn("Failed to update result TTL:", err));
      }
    }
  }
});

// --- 設定シグネチャ & スマートバイパス ---

let lastConvertedSignature = null;

function getCurrentConfigSignature() {
  const isConvertOn = enableConvertCheck?.checked ?? true;
  const format = formatSelect ? formatSelect.value : "image/webp";
  const quality = qualityRange ? qualityRange.value : "85";
  const isRenameOn = enableRenameCheck?.checked ?? true;
  const pattern = renamePattern ? renamePattern.value : "";
  const fileSig = state.files.map(f => `${f.name}:${f.size}:${f.lastModified}`).join("|");

  return `${isConvertOn}_${format}_${quality}_${isRenameOn}_${pattern}_${fileSig}`;
}

function isConversionCacheValid() {
  if (!state.files.length) return false;
  if (!state.results || state.results.length !== state.files.length) return false;
  if (state.results.some(r => !r || !r.blob)) return false;
  return lastConvertedSignature === getCurrentConfigSignature();
}

function invalidateConversionCache(clearResults = true) {
  lastConvertedSignature = null;
  if (clearResults && state.results.length > 0) {
    state.results.forEach(result => {
      if (result) {
        if (result.url) URL.revokeObjectURL(result.url);
        if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
      }
    });
    state.results = [];
    render();
  }
}

// --- 画像変換処理 ---
async function runConversion(force = false) {
  if (!state.files.length) return false;

  // 設定が変わっておらず、すでに変換済みBlobが揃っている場合は完全バイパス！
  if (!force && isConversionCacheValid()) {
    return true;
  }

  if (progressBar) progressBar.value = 0;
  if (statusText) {
    statusText.textContent = "変換中...";
    statusText.className = "status-text saving";
  }

  state.results.forEach((result) => {
    if (result) {
      if (result.url) URL.revokeObjectURL(result.url);
      if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
    }
  });
  state.results = [];
  render();
  setUiLock(true);

  try {
    state.results = new Array(state.files.length).fill(null);

    const conversionPromises = state.files.map((file, index) =>
      convertImage(file, index).then(result => {
        state.results[index] = result;
        const finishedCount = state.results.filter(r => r !== null).length;
        if (progressBar) progressBar.value = Math.round((finishedCount / state.files.length) * 100);
        render();
      })
    );
    await Promise.all(conversionPromises);
    lastConvertedSignature = getCurrentConfigSignature();
    if (statusText) {
      statusText.textContent = "変換完了";
      statusText.className = "status-text";
    }
    return true;
  } catch (error) {
    console.error("Conversion error:", error);
    lastConvertedSignature = null;
    if (statusText) {
      statusText.textContent = "変換失敗";
      statusText.className = "status-text error";
    }
    return false;
  } finally {
    setUiLock(false);
    render();
  }
}

async function convertImage(file, index = 0) {
  const dotIndex = file.name.lastIndexOf(".");
  const fileExt = dotIndex > 0 ? file.name.slice(dotIndex + 1).toLowerCase() : "";
  const isImageMime = file.type && file.type.startsWith("image/");
  const isImageExt = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "jxl"].includes(fileExt);
  const isImage = isImageMime || isImageExt;

  const isConvertOn = enableConvertCheck?.checked ?? true;

  if (!isImage || !isConvertOn) {
    const url = URL.createObjectURL(file);
    const outputName = createOutputName(file.name, null, index);
    return {
      id: crypto.randomUUID(),
      name: outputName,
      relativePath: file.relativePath || file.name,
      url,
      previewUrl: isImage ? url : "",
      blob: file,
      size: file.size,
      originalSize: file.size,
      isNonImage: !isImage,
    };
  }

  const options = {
    mimeType: formatSelect ? formatSelect.value : "image/webp",
    quality: qualityRange ? Number(qualityRange.value) / 100 : 0.85,
    name: createOutputName(file.name, formatSelect ? formatSelect.value : "image/webp", index),
  };

  let finalBlob = null;
  let previewSrc = "";

  try {
    const image = await loadImage(file);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext("2d", { alpha: true });
    context.drawImage(image, 0, 0);

    if (options.mimeType === "image/jxl") {
      await ensureJxl();
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const qualityVal = qualityRange ? Number(qualityRange.value) : 85;
      const jxlBuffer = await encodeJxl(imageData, { quality: qualityVal });
      finalBlob = new Blob([jxlBuffer], { type: "image/jxl" });
      try {
        previewSrc = canvas.toDataURL("image/webp", 0.7);
      } catch (e) {}
    } else {
      // Canvas変換（生写真のGPS位置情報・Exifは自動更地化）
      finalBlob = await canvasToBlob(canvas, options.mimeType, options.quality);
    }
  } catch (err) {
    console.error("Image conversion error:", err);
    alert(`画像変換エラー (${options.name}): ${err.message}`);
    finalBlob = file;
  }

  const finalUrl = URL.createObjectURL(finalBlob);

  return {
    id: crypto.randomUUID(),
    name: options.name,
    relativePath: file.relativePath || file.name,
    url: finalUrl,
    previewUrl: previewSrc || finalUrl,
    blob: finalBlob,
    size: finalBlob.size,
    originalSize: file.size,
    isNonImage: false,
    hasRescuedWf: Boolean(file.metaStatus?.hasWorkflow || file.metaStatus?.hasPrompt),
  };
}

// 🪐 Filebase FIFO（先入れ先出し）自動容量解放
async function ensureStorageCapacityFilebase(s3, bucketName, requiredBytes = 0) {
  const isAutoFifo = localStorage.getItem("autoFifo") !== "false";
  if (!isAutoFifo || !s3 || !bucketName) return;

  // 上限サイズ (MB単位、Filebase上限は専用のfilebaseStorageLimitを参照、デフォルト 5000MB = 5GB)
  const limitMb = Number(localStorage.getItem("filebaseStorageLimit") || "5000");
  const limitBytes = limitMb * 1024 * 1024;

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      MaxKeys: 1000,
    });
    const response = await s3.send(listCommand);
    const contents = response.Contents || [];
    if (contents.length === 0) return;

    let currentTotalBytes = contents.reduce((acc, cur) => acc + (cur.Size || 0), 0);

    // 🛡️ バッファ安全設計: 新規ファイルを足しても上限の 85% 未満なら解放不要（750MB以上のバッファを常時担保）
    // （※ 容量に余裕がある平常時は Kubo 疎通チェックを行わず即座に完了する）
    if (currentTotalBytes + requiredBytes <= limitBytes * 0.85) {
      return;
    }

    // 🏠 Kubo 自動ピン留め設定の確認（外出先・Kuboオフライン時はファイル消失防止のため安全に中断）
    const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";
    const isKuboPrioritizePinned = localStorage.getItem("kuboPrioritizePinned") !== "false";
    let isKuboAvailable = false;
    let kuboPinnedSet = null;

    if (isKuboAutoPin) {
      const kuboCheck = await checkKuboOnline(1500);
      isKuboAvailable = kuboCheck.online;
      if (!isKuboAvailable) {
        console.warn("⚠️ 自宅 Kubo がオフラインのため、Filebase FIFO 自動容量解放をスキップしました（ファイル消失防止フェイルセーフ）。");
        if (requiredBytes > 0) {
          const isEn = getAppLanguage() === "en";
          const errMsg = isEn
            ? "Filebase storage limit (85%) reached. Upload paused because local Kubo node is unreachable (prevents existing file loss). Please connect to Tailscale or start Kubo."
            : "Filebaseの容量上限（85%）に達しています。自宅Kuboノードへの接続が確認できないため、過去ファイルの消失を防ぐためにアップロードを中断しました。Tailscale接続またはKubo起動をご確認ください。";
          throw new Error(errMsg);
        }
        return;
      }
      console.log("🏠 自宅 Kubo ノード検出: アンピン対象ファイルをローカルKuboへ救出Pin開始");
      if (isKuboPrioritizePinned) {
        try {
          kuboPinnedSet = await getKuboPinnedCids(1500);
          if (kuboPinnedSet && kuboPinnedSet.size > 0) {
            console.log(`🏠 Kubo 保管済みCIDリスト取得成功 (${kuboPinnedSet.size} 件)。保管済みファイルを優先してFilebase容量解放します。`);
          }
        } catch (e) {
          console.warn("Kubo Pin済みリスト取得失敗（通常ソートにフォールバック）:", e);
        }
      }
    }

    console.log(`🪐 Filebase FIFO 発動: 現在容量 ${formatBytes(currentTotalBytes)} + 新規 ${formatBytes(requiredBytes)} > 上限 ${formatBytes(limitBytes)} (85%)`);

    // 保護対象（pinned_ で始まるもの）を除外し、ソート
    // isKuboPrioritizePinned が有効かつ kuboPinnedSet がある場合は、Kubo保管済みを最優先にし、それぞれ古い順（LastModified 昇順）にする
    const eligibleFiles = contents.filter(item => {
      if (item.Key?.startsWith("pinned_")) return false; // 📌永続化は保護
      if (isGeneratedVideoThumbnailKey(item.Key)) return false; // 親動画と一体でのみ回収する
      return true;
    }).sort((a, b) => {
      if (isKuboPrioritizePinned && kuboPinnedSet) {
        const cidA = getStoredIpfsCid(a.Key);
        const cidB = getStoredIpfsCid(b.Key);
        const isPinnedA = cidA ? (kuboPinnedSet.has(cidA) ? 1 : 0) : 0;
        const isPinnedB = cidB ? (kuboPinnedSet.has(cidB) ? 1 : 0) : 0;
        if (isPinnedA !== isPinnedB) {
          return isPinnedB - isPinnedA; // Kubo保管済み(1)を先頭にする
        }
      }
      return new Date(a.LastModified || 0) - new Date(b.LastModified || 0);
    });

    const candidates = [];
    let freedBytes = 0;
    let simulatedTotal = currentTotalBytes;

    for (const file of eligibleFiles) {
      candidates.push(file.Key);
      freedBytes += (file.Size || 0);
      simulatedTotal -= (file.Size || 0);

      // OGP 用サムネイルは親動画と同じ実体ライフサイクル。単独で FIFO 回収しない。
      const thumbnailKey = getVideoThumbnailKey(file.Key);
      const thumbnail = thumbnailKey ? contents.find(item => item.Key === thumbnailKey) : null;
      if (thumbnail) {
        candidates.push(thumbnail.Key);
        freedBytes += (thumbnail.Size || 0);
        simulatedTotal -= (thumbnail.Size || 0);
      }

      // 十分な空き容量（上限の70%以下までゆったり解放し、次回の連続アップロード用バッファを確保）
      if (simulatedTotal + requiredBytes <= limitBytes * 0.70) {
        break;
      }
    }

    if (candidates.length === 0) return;

    // 🛡️ 安全実行順序:
    // 1. Kubo自動Pin有効時: Filebaseから削除する「前」に、まずKuboへPin留めを成功させる！
    // 2. Pin成功確認後（またはKubo無効時、すでにKubo保管済み時）にのみ、Filebase S3 DeleteObject を実行する！
    const filesToUnpin = [];
    const kvUpdates = [];

    for (const targetKey of candidates) {
      let cid = null;
      let meta = {};
      let kuboStatus = "not_pinned";

      try {
        const kvData = await fetchKvRecord(targetKey);
        if (kvData && kvData.found) {
          cid = kvData.cid || null;
          meta = kvData.metadata || {};
          kuboStatus = meta.kuboStatus || "not_pinned";
        }
      } catch (kvErr) {
        console.warn(`KV record lookup failed for ${targetKey}:`, kvErr);
      }

      if (!cid) {
        cid = getStoredIpfsCid(targetKey);
      }

      const isThumb = isGeneratedVideoThumbnailKey(targetKey);
      const isAlreadyKuboPinned = cid && kuboPinnedSet && kuboPinnedSet.has(cid);

      // Kuboへ事前にPin留め（サムネイル以外かつ未Pinの場合）
      if (isKuboAvailable && isKuboAutoPin && cid && !isThumb && kuboStatus !== "pinned" && !isAlreadyKuboPinned) {
        activeKuboPins.add(cid);
        try {
          const pinRes = await pinToKubo(cid);
          if (pinRes.success) {
            kuboStatus = "pinned";
            console.log(`🏠 Kubo 事前救出Pin成功: ${targetKey} (${cid})`);
          } else {
            console.warn(`🏠 Kubo Pin失敗: ${targetKey}:`, pinRes.error);
            if (requiredBytes > 0) {
              throw new Error(`自宅KuboへのPin退避に失敗したため、ファイル消失を防ぐためアンピンを中断しました: ${targetKey} (${pinRes.error})`);
            }
            continue; // 一覧自動チェック時はこのファイルをスキップして保護
          }
        } catch (pErr) {
          console.warn(`🏠 Kubo Pin通信エラー:`, pErr);
          if (requiredBytes > 0) {
            throw new Error(`自宅KuboへのPin通信エラーのためアンピンを中断しました: ${targetKey} (${pErr.message})`);
          }
          continue;
        } finally {
          activeKuboPins.delete(cid);
        }
      } else if (isAlreadyKuboPinned) {
        kuboStatus = "pinned";
        console.log(`🏠 Kubo 保管済み確認（Pinスキップ）: ${targetKey} (${cid})`);
      }

      filesToUnpin.push(targetKey);
      if (cid) {
        kvUpdates.push({ key: targetKey, cid, meta, kuboStatus });
      }
    }

    if (filesToUnpin.length > 0) {
      console.log(`🪐 Filebase FIFO 自動アンピン実行: ${filesToUnpin.join(", ")} (${formatBytes(freedBytes)} 解放)`);
      await safeDeleteS3Objects(s3, bucketName, filesToUnpin);

      // KV 側のメタデータを unpinned: true に更新（マルチゲートウェイ配信へ切り替え）
      for (const update of kvUpdates) {
        try {
          await registerKvCid(
            update.key,
            update.cid,
            update.meta?.size || 0,
            update.meta?.mime || "",
            update.meta?.s3Key || update.key,
            "",
            null,
            update.meta?.ttl || 0,
            update.meta?.expiresAt || null,
            true, // unpinned: true
            update.kuboStatus
          );
        } catch (kvErr) {
          console.warn(`Failed to update unpinned status in KV for ${update.key}:`, kvErr);
        }
      }
    }
  } catch (err) {
    console.warn("Filebase FIFO ensureStorageCapacity error:", err);
    if (requiredBytes > 0) {
      throw err;
    }
  }
}

// ⚡ R2 FIFO: R2 側の上限到達時に古い実体を自動回収。
// 自宅 Kubo への自動 Pin（kuboAutoPinR2）が有効な場合、消去前に Kubo へ実体を保存し、
// 公開 URL を IPFS / 自宅 Kubo 経由で維持したまま R2 バケット容量を安全に解放する。
async function ensureStorageCapacityR2(s3, bucketName, requiredBytes = 0) {
  if (localStorage.getItem("r2AutoFifo") === "false" || !s3 || !bucketName) return;

  const limitMb = Number(localStorage.getItem("r2StorageLimit") || localStorage.getItem("storageLimit") || "5000");
  const limitBytes = limitMb * 1024 * 1024;
  try {
    const contents = [];
    let continuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: 1000,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }));
      contents.push(...(page.Contents || []));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    let totalBytes = contents.reduce((sum, item) => sum + (item.Size || 0), 0);
    if (totalBytes + requiredBytes <= limitBytes * 0.85) return;

    // 🏠 Kubo 自動 Pin が有効な場合の接続確認＆フェイルセーフ
    const isKuboAutoPinR2 = localStorage.getItem("kuboAutoPinR2") !== "false";
    if (isKuboAutoPinR2) {
      const kuboStatus = await checkKuboOnline(1500);
      if (!kuboStatus.online) {
        console.warn("⚠️ 自宅 Kubo がオフラインのため、R2 FIFO 自動容量解放をスキップしました（ファイル消失防止フェイルセーフ）。");
        return;
      }
    }

    const candidates = contents
      .filter(item => !item.Key?.startsWith("pinned_"))
      .sort((a, b) => new Date(a.LastModified || 0) - new Date(b.LastModified || 0));
    const itemsToDelete = [];
    for (const item of candidates) {
      itemsToDelete.push(item);
      totalBytes -= item.Size || 0;
      if (totalBytes + requiredBytes <= limitBytes * 0.70) break;
    }
    if (itemsToDelete.length === 0) return;

    const kvFiles = await fetchKvFiles();
    const preservedInKuboKeys = new Set();

    // 🏠 Kubo への自動実体保存（Pin留め）
    if (isKuboAutoPinR2) {
      for (const item of itemsToDelete) {
        try {
          const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: item.Key }));
          const bytes = await res.Body.transformToByteArray();
          const blob = new Blob([bytes]);
          const addRes = await addFileToKubo(blob, item.Key);
          if (addRes.success && addRes.cid) {
            storeIpfsCid(item.Key, addRes.cid);
            storeR2Hash(item.Key, addRes.cid);
            preservedInKuboKeys.add(item.Key);

            // KV 台帳の kuboStatus を "pinned"、contentCid を更新（リンクは維持）
            const matchedKv = kvFiles.find(kv => (kv.metadata?.s3Key || kv.metadata?.k_s3 || kv.name) === item.Key);
            if (matchedKv) {
              const meta = matchedKv.metadata || {};
              await registerKvCid(
                matchedKv.name,
                "r2",
                meta.size || item.Size || 0,
                meta.mime || blob.type || "",
                item.Key,
                "",
                null,
                meta.ttl || 0,
                meta.expiresAt || null,
                Boolean(meta.unpinned),
                "pinned",
                meta.allowedHost || null,
                false,
                meta.thumbnailKey || null,
                meta.width || null,
                meta.height || null,
                Boolean(meta.civitaiTemporary),
                addRes.cid,
                "r2"
              );
            }
          }
        } catch (pinErr) {
          console.warn(`Kubo auto-pin for R2 FIFO failed on ${item.Key}:`, pinErr);
        }
      }
    }

    const keysToDelete = itemsToDelete.map(i => i.Key);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: { Objects: keysToDelete.map(Key => ({ Key })) },
    }));
    keysToDelete.forEach(deleteR2Hash);

    // Kubo に保全されなかったもの（Kubo未設定時など）のみ、実体消去後の死んだリンクを KV から削除
    const linksToDelete = new Set();
    for (const item of kvFiles) {
      const linkedS3Key = item.metadata?.s3Key || item.metadata?.k_s3 || item.name;
      if (keysToDelete.includes(linkedS3Key) && !preservedInKuboKeys.has(linkedS3Key)) {
        linksToDelete.add(item.name);
      }
    }
    for (const key of linksToDelete) await deleteKvCid(key);

    console.log(`⚡ R2 FIFO 自動容量解放: ${keysToDelete.length}件削除 (うちKubo保全: ${preservedInKuboKeys.size}件)`);
  } catch (err) {
    console.warn("R2 FIFO ensureStorageCapacity error:", err);
  }
}

// --- S3 アップロード処理 (R2 / Filebase 独立対応) ---
async function uploadImage(result, targetProvider = "r2", customPassword = null, uploadOptions = {}) {
  if (!result || !result.blob) return false;

  const isFilebase = targetProvider === "filebase";
  const s3 = getS3Client(targetProvider);
  const bucketName = getBucketName(targetProvider);

  if (!s3 || !bucketName) {
    alert(`⚠️ ${isFilebase ? "Filebase" : "R2"} 接続設定を完了してください`);
    return false;
  }

  result.isUploading = true;
  result.uploadingProvider = targetProvider;
  render();

  try {
    const pwdInput = document.querySelector("#tempPasswordInput");
    const password = (typeof customPassword !== "undefined" && customPassword !== null)
      ? customPassword
      : (pwdInput ? pwdInput.value.trim() : "");

    const ttlSelect = document.querySelector("#tempTtlSelect");
    const requestedTtl = ttlSelect ? Number(ttlSelect.value || 0) : 0;
    const ttlSeconds = Number.isFinite(Number(uploadOptions.ttlSeconds))
      ? Math.max(0, Number(uploadOptions.ttlSeconds))
      : requestedTtl;
    const expiresAt = ttlSeconds > 0 ? (Date.now() + ttlSeconds * 1000) : null;
    const civitaiTemporary = Boolean(uploadOptions.civitaiTemporary);

    const arrayBuffer = await result.blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // 個別ファイルサイズ制限: スマホのメモリ安全性(OOMクラッシュ防止)とCloudflareエッジキャッシュ上限を考慮し、128MB未満に設定
    // See: [INV-FRONT-003] (単一ファイルアップロード上限 128MB)
    const MAX_SINGLE_FILE_BYTES = 128 * 1024 * 1024; // 128MB
    if (bytes.length >= MAX_SINGLE_FILE_BYTES) {
      const sizeMb = (bytes.length / (1024 * 1024)).toFixed(1);
      await showCustomAlert(
        `ファイルサイズ (${sizeMb} MB) が上限（128MB未満）に達しています。<br>128MB未満のファイルをアップロードしてください。`,
        "⚠️ 容量オーバー"
      );
      result.isUploading = false;
      result.uploadingProvider = null;
      render();
      return false;
    }

    // 🛡️ アップロード前同名ファイル衝突チェック:
    // 同名キーがKVに既に存在し、かつ既存のCIDと異なる（別画像）場合は上書き破壊を防ぐ
    if (hasAdminAccess()) {
      try {
        const kvFiles = await fetchKvFiles();
        const existingKv = kvFiles.find(f => f.name === result.name);
        if (existingKv) {
          const existingCid = existingKv.metadata?.cid || existingKv.metadata?.c;
          // アップロード前時点ではまだ新CIDが確定していない場合もあるが、既存ファイルがある場合は念のため警告
          // （同一内容のリトライであればそのまま許可）
          if (existingCid && result.ipfsCid && existingCid !== result.ipfsCid) {
            await showCustomAlert(
              `同名ファイル「${escapeHtml(result.name)}」が既に異なる内容で登録されています。<br>ファイル名変更（リネーム）を行ってからアップロードしてください。`,
              "⚠️ ファイル名の衝突"
            );
            result.isUploading = false;
            result.uploadingProvider = null;
            render();
            return false;
          }
        }
      } catch (err) {
        console.debug("KV pre-check skipped:", err);
      }
    }

    let uploadBlob = result.blob;
    let uploadBytes = bytes;

    const ext = result.name ? result.name.split('.').pop().toLowerCase() : "";

    // 🎬 MP4 FastStart 最適化:
    // moov atom を先頭に引っ越しさせ、リンクを開いた瞬間の即座シーク再生を可能にする
    if (ext === "mp4" || (result.blob.type && result.blob.type === "video/mp4")) {
      try {
        const optimizedBlob = await applyFastStartToMp4(uploadBlob);
        if (optimizedBlob && optimizedBlob !== uploadBlob) {
          uploadBlob = optimizedBlob;
          uploadBytes = new Uint8Array(await uploadBlob.arrayBuffer());
        }
      } catch (fastStartErr) {
        console.warn("FastStart optimization error:", fastStartErr);
      }
    }

    let contentType = uploadBlob.type || "";
    if (!contentType || contentType === "application/octet-stream") {
      contentType = getContentTypeFromFilename(result.name);
    }
    const imageDimensions = await getImageDimensions(uploadBlob, contentType);
    const isAttachment = ["zip", "7z", "rar", "tar", "gz"].includes(ext);
    const contentDisposition = isAttachment
      ? `attachment; filename="${encodeURIComponent(result.name)}"`
      : "inline";

    // 🧬 Filebase / R2 重複検査: 変換後のバイト列からCID/ハッシュを算出し、同じ中身の
    // 既存実体があればPutObjectを実行しない。新しい公開名だけをKV台帳に追加する（スマートエイリアス）。
    let calculatedCid = null;
    let calculatedHash = null;

    if (isFilebase) {
      calculatedCid = await calculateFilebaseCid(uploadBytes);
      if (calculatedCid) {
        const duplicate = await findFilebaseObjectByCid(s3, bucketName, calculatedCid);
        if (duplicate) {
          if (!hasAdminAccess()) {
            throw new Error("同一CIDのファイルを検出しました。別名URLの作成にはKV Worker URLとAdmin API Tokenの設定が必要です。");
          }

          const baseDomain = (getSelectedR2Domain("filebase") || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
          result.isUploaded = true;
          result.uploadedProvider = "filebase";
          result.storageKey = duplicate.key;
          result.duplicateOf = duplicate.key;
          result.ipfsCid = duplicate.cid;
          result.mime = contentType;
          result.password = password;
          result.hasPassword = Boolean(password);
          result.ttl = ttlSeconds;
          result.expiresAt = expiresAt;
          result.civitaiTemporary = civitaiTemporary;

          // 新名 -> 既存のS3実体キー、という別名マッピングを作る。旧URLは維持される。
          await registerKvCid(
            result.name,
            duplicate.cid,
            uploadBytes.length,
            contentType,
            duplicate.key,
            password,
            null,
            ttlSeconds,
            expiresAt,
            false,
            null,
            baseDomain,
            true,
            getVideoThumbnailKey(duplicate.key),
            imageDimensions?.width,
            imageDimensions?.height,
            civitaiTemporary
          );
          if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);
          storeIpfsCid(result.name, duplicate.cid);
          storeIpfsCid(duplicate.key, duplicate.cid);
          result.proxyUrl = getSelectedDeliveryUrl(result);
          setFileStoredDomain(result.name, baseDomain);
          paletteFiles.unshift({ key: result.name, url: result.proxyUrl });
          renderUrlPalette();

          return true;
        }
      }
    } else {
      // ⚡ R2 IPFS UnixFS CID 重複検査:
      // Filebase と同一の UnixFS CID を計算し、同一 CID の既存実体があれば PutObject をスキップしてスマートエイリアス化
      calculatedCid = await calculateFilebaseCid(uploadBytes);
      if (calculatedCid) {
        const duplicate = await findR2ObjectByHash(s3, bucketName, calculatedCid, uploadBytes.length);
        if (duplicate) {
          if (!hasAdminAccess()) {
            throw new Error("同一内容のファイルを検出しました。別名URLの作成にはKV Worker URLとAdmin API Tokenの設定が必要です。");
          }

          const baseDomain = (getSelectedR2Domain("r2") || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
          result.isUploaded = true;
          result.uploadedProvider = "r2";
          result.storageKey = duplicate.key;
          result.duplicateOf = duplicate.key;
          result.ipfsCid = calculatedCid;
          result.mime = contentType;
          result.password = password;
          result.hasPassword = Boolean(password);
          result.ttl = ttlSeconds;
          result.expiresAt = expiresAt;
          result.civitaiTemporary = civitaiTemporary;

          // 新名 -> 既存の R2 実体キー、という別名マッピングを登録（R2 容量を消費しない）
          await registerKvCid(
            result.name,
            "r2",
            uploadBytes.length,
            contentType,
            duplicate.key,
            password,
            null,
            ttlSeconds,
            expiresAt,
            false,
            null,
            baseDomain,
            true,
            getVideoThumbnailKey(duplicate.key),
            imageDimensions?.width,
            imageDimensions?.height,
            civitaiTemporary,
            calculatedCid,
            "r2"
          );
          if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);
          storeR2Hash(result.name, calculatedCid);
          storeR2Hash(duplicate.key, calculatedCid);
          storeIpfsCid(result.name, calculatedCid);
          storeIpfsCid(duplicate.key, calculatedCid);
          result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
          setFileStoredDomain(result.name, baseDomain);
          paletteFiles.unshift({ key: result.name, url: result.proxyUrl });
          renderUrlPalette();

          console.log(`⚡ R2 重複排除（UnixFS CID照合: ${calculatedCid}）: 既存実体「${duplicate.key}」を検知したため PutObject をスキップしスマートエイリアスを作成しました。`);
          return true;
        }
      }
    }

    // 🪐 Filebase (IPFS): 容量上限に近づいている場合、最も古い実体を自動アンピン (FIFO)
    if (isFilebase) {
      await ensureStorageCapacityFilebase(s3, bucketName, uploadBytes.length);
    } else {
      await ensureStorageCapacityR2(s3, bucketName, uploadBytes.length);
    }

    const s3Metadata = {
      size: String(uploadBytes.length),
    };
    if (expiresAt) {
      s3Metadata["expires-at"] = String(expiresAt);
      s3Metadata["ttl"] = String(ttlSeconds);
    }
    if (calculatedCid) {
      s3Metadata["cid"] = calculatedCid;
      s3Metadata["hash"] = calculatedCid;
    }

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: result.name,
      Body: uploadBytes,
      ContentType: contentType,
      ContentDisposition: contentDisposition,
      Metadata: s3Metadata,
    });

    const putOutput = await s3.send(command);

    let ipfsCid = null;
    if (isFilebase) {
      const checkAndValidateCid = (raw) => {
        if (!raw || typeof raw !== "string") return null;
        const candidate = raw.trim();
        return isValidIpfsCid(candidate) ? candidate : null;
      };

      // PutObject レスポンスヘッダーから CID を探索
      const headers = putOutput?.$metadata?.httpHeaders || {};
      ipfsCid = checkAndValidateCid(headers["x-amz-meta-cid"] || headers["x-amz-meta-ipfs-hash"]);

      // レスポンスヘッダーに無ければ HeadObject を最大8回リトライして確実にCIDを取得
      for (let attempt = 0; attempt < 8 && !ipfsCid; attempt++) {
        try {
          await new Promise(r => setTimeout(r, 600 + attempt * 500));
          const headOutput = await s3.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: result.name,
          }));
          const hHeaders = headOutput?.$metadata?.httpHeaders || {};
          const candidate = hHeaders["x-amz-meta-cid"] ||
                            hHeaders["x-amz-meta-ipfs-hash"] ||
                            headOutput?.Metadata?.cid ||
                            headOutput?.Metadata?.["ipfs-hash"];
          ipfsCid = checkAndValidateCid(candidate);
        } catch (hErr) {
          console.warn(`HeadObject CID lookup attempt ${attempt + 1} failed:`, hErr);
        }
      }
    }

    result.isUploaded = true;
    result.uploadedProvider = targetProvider;
    result.storageKey = result.name;
    result.password = password;
    result.hasPassword = Boolean(password);
    result.ttl = ttlSeconds;
    result.expiresAt = expiresAt;
    result.civitaiTemporary = civitaiTemporary;

    const baseDomain = (getSelectedR2Domain(targetProvider) || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");

    if (isFilebase) {
      if (ipfsCid && isValidIpfsCid(ipfsCid)) {
        result.ipfsCid = ipfsCid;
        storeIpfsCid(result.name, ipfsCid);
      }
      if (calculatedCid && ipfsCid && calculatedCid !== ipfsCid) {
        console.warn("Filebase returned a CID different from the local UnixFS calculation; duplicate detection will be retried with Filebase's CID on future uploads.", { calculatedCid, ipfsCid });
      }
      // CID の有無に関わらず、KV にメタデータ（パスワード含む）を登録（※一般ユーザー時は自動スキップ）
      // 🌐 選択されている配信ドメインのみを allowedHost として渡し、指定ドメイン外からのアクセスを404遮断
      await registerKvCid(result.name, ipfsCid || "", uploadBytes.length, contentType, result.name, password, uploadBlob || uploadBytes, ttlSeconds, expiresAt, false, null, baseDomain, true, null, imageDimensions?.width, imageDimensions?.height, civitaiTemporary);
      
      if (hasAdminAccess()) {
        const deliveryBase = getKvDeliveryBaseDomain();
        result.proxyUrl = `${deliveryBase}/${encodeURIComponent(result.name)}`;
        console.log(`🪐 cividge-kv-worker URL 生成完了: CID=${ipfsCid} -> ${result.proxyUrl}`);
      } else {
        // 一般ユーザーモードでも共有URLは配信ドメイン + ファイル名に統一する。
        result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
        console.log(`🪐 Filebase URL 生成完了: CID=${ipfsCid} -> ${result.proxyUrl}`);
      }
      result.proxyUrl = getSelectedDeliveryUrl(result) || result.proxyUrl;

      // 🛡️ Filebase 帯域保護（Egress 温存）:
      // アップロード直後の全量ウォームアップフェッチは Filebase のダウンロード帯域を
      // 無条件に100%消費するため行わない。実際の初回アクセス時にオンデマンドでエッジキャッシュさせる。
      setFileStoredDomain(result.name, baseDomain);
    } else {
      let initialKuboStatus = null;
      if (calculatedCid) {
        try {
          if (await checkKuboPinned(calculatedCid, 500)) {
            initialKuboStatus = "pinned";
          }
        } catch (e) {}
      }
      await registerKvCid(
        result.name,
        "r2",
        uploadBytes.length,
        contentType,
        result.name,
        password,
        uploadBlob || uploadBytes,
        ttlSeconds,
        expiresAt,
        false,
        initialKuboStatus,
        baseDomain,
        true,
        null,
        imageDimensions?.width,
        imageDimensions?.height,
        civitaiTemporary,
        calculatedCid,
        "r2"
      );
      result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
      setFileStoredDomain(result.name, baseDomain);
      if (calculatedCid) {
        result.ipfsCid = calculatedCid;
        storeR2Hash(result.name, calculatedCid);
        storeIpfsCid(result.name, calculatedCid);
      }
    }

    if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);

    // 🎬 動画の場合は先頭フレームサムネイル（.thumb.webp）を裏で自動生成・保存
    // Misskey / Twitter / Discord 等の OGP カード用ポスター画像として活用
    const isVideoFile = isVideoThumbnailParentKey(result.name);
    if (isVideoFile && uploadBlob) {
      (async () => {
        try {
          const thumbBlob = await captureVideoFirstFrame(uploadBlob);
          if (thumbBlob) {
            const thumbKey = getVideoThumbnailKey(result.name);
            const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());
            const thumbnailDimensions = await getImageDimensions(thumbBlob, "image/webp");
            const thumbCommand = new PutObjectCommand({
              Bucket: bucketName,
              Key: thumbKey,
              Body: thumbBytes,
              ContentType: "image/webp",
              ContentDisposition: "inline",
              Metadata: expiresAt ? {
                size: String(thumbBytes.length),
                "expires-at": String(expiresAt),
                ttl: String(ttlSeconds),
              } : { size: String(thumbBytes.length) },
            });
            const thumbPut = await s3.send(thumbCommand);
            const tHeaders = thumbPut?.$metadata?.httpHeaders || {};
            const thumbCid = isFilebase ? (tHeaders["x-amz-meta-cid"] || tHeaders["x-amz-meta-ipfs-hash"] || "") : "";
            // サムネイル自身も親動画と同じ期限で台帳登録し、OGP 配信時に解決できるようにする。
            await registerKvCid(thumbKey, thumbCid, thumbBytes.length, "image/webp", thumbKey, "", thumbBlob, ttlSeconds, expiresAt, false, null, baseDomain, true, null, thumbnailDimensions?.width, thumbnailDimensions?.height);
            // 別名 URL でも元動画のサムネイルを参照できるよう、親レコードへ派生キーを保存する。
            await registerKvCid(result.name, isFilebase ? (ipfsCid || "") : "r2", uploadBytes.length, contentType, result.name, "", null, ttlSeconds, expiresAt, false, null, baseDomain, true, thumbKey, imageDimensions?.width, imageDimensions?.height);
            console.log(`🎬 動画サムネイル自動アップロード完了: ${thumbKey} (${thumbBytes.length} bytes)`);
          }
        } catch (thumbErr) {
          console.warn("Auto video thumbnail upload failed:", thumbErr);
        }
      })();
    }

    // 🧬 アップロードされたファイルのワークフロー有無をローカルストレージに記録
    // （※画像変換ONの画像はCanvasでExif/WFが削除されるため、非変換時または動画のみ保持）
    try {
      const isConvertOn = enableConvertCheck?.checked ?? true;
      const fileExt = (result.name || "").split('.').pop().toLowerCase();
      const isVideo = ["mp4", "webm", "mov"].includes(fileExt);
      const retainsWorkflow = (!isConvertOn || isVideo) && (result.metaStatus?.hasWorkflow || result.metaStatus?.hasPrompt);

      const wfStore = JSON.parse(localStorage.getItem("comfyWfMap") || "{}");
      if (retainsWorkflow) {
        wfStore[result.name] = true;
        localStorage.setItem("comfyWfMap", JSON.stringify(wfStore));
      } else if (wfStore[result.name]) {
        delete wfStore[result.name];
        localStorage.setItem("comfyWfMap", JSON.stringify(wfStore));
      }
    } catch (wfSaveErr) {}

    paletteFiles.unshift({ key: result.name, url: result.proxyUrl });
    renderUrlPalette();

    return true;
  } catch (error) {
    result.error = error.message;
    console.error("Upload failed:", error);
    alert(`アップロード失敗 (${targetProvider}): ${error.message}`);
    return false;
  } finally {
    result.isUploading = false;
    render();
  }
}

// --- 一括アップロード共通処理 ---
async function handleBatchUpload(targetProvider) {
  if (!state.files.length) return;
  const success = await runConversion();
  if (!success) return;

  const targets = state.results.filter(r => r && !r.isUploaded && !r.isUploading);
  if (targets.length === 0) return;

  setUiLock(true);
  const providerLabel = targetProvider === "filebase" ? "Filebase" : "R2";
  if (statusText) {
    statusText.className = "status-text saving";
    statusText.textContent = `${providerLabel} アップロード中 (0/${targets.length})`;
  }
  if (progressBar) progressBar.value = 0;

  try {
    for (let i = 0; i < targets.length; i++) {
      const result = targets[i];
      if (statusText) statusText.textContent = `${providerLabel} アップロード中 (${i + 1}/${targets.length})`;
      const uploadSuccess = await uploadImage(result, targetProvider);
      if (!uploadSuccess) {
        break;
      }
      if (progressBar) progressBar.value = Math.round(((i + 1) / targets.length) * 100);
    }
    if (statusText) {
      statusText.textContent = `${providerLabel} 一括アップロード完了`;
      statusText.className = "status-text";
    }
  } catch (error) {
    console.error("Upload failed:", error);
    if (statusText) {
      statusText.textContent = `アップロード失敗: ${error.message}`;
      statusText.className = "status-text error";
    }
  } finally {
    setUiLock(false);
    await fetchAndRenderR2Files();
  }
}

convertUploadR2Button?.addEventListener("click", () => handleBatchUpload("r2"));
convertUploadFilebaseButton?.addEventListener("click", () => handleBatchUpload("filebase"));

convertDownloadButton?.addEventListener("click", async () => {
  const success = await runConversion();
  if (!success) return;

  const isZipOn = enableZipCheck?.checked ?? false;
  const validResults = state.results.filter(r => r && r.blob);

  if (isZipOn && validResults.length > 0) {
    if (statusText) statusText.textContent = "ZIP作成中...";
    try {
      const zipEntries = [];
      for (const result of validResults) {
        const arrayBuffer = await result.blob.arrayBuffer();
        zipEntries.push({
          name: result.name,
          data: new Uint8Array(arrayBuffer),
        });
      }
      const zipBlob = createZip(zipEntries);
      const zipUrl = URL.createObjectURL(zipBlob);
      downloadUrl(zipUrl, "converted-images.zip");
      setTimeout(() => URL.revokeObjectURL(zipUrl), 2000);
      if (statusText) statusText.textContent = "ZIP一括ダウンロード完了";
    } catch (err) {
      console.error("ZIP creation error:", err);
      alert("ZIP作成に失敗しました。個別ダウンロードに切り替えます。");
      for (const result of validResults) {
        if (result && result.url) {
          downloadUrl(result.url, result.name);
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }
    }
  } else {
    if (statusText) statusText.textContent = "ダウンロード中...";
    for (const result of state.results) {
      if (result && result.url) {
        downloadUrl(result.url, result.name);
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (statusText) statusText.textContent = "ダウンロード完了";
  }
});

// --- R2 / Filebase ストレージ一覧 & タブ管理 ---
function getStorageListLabels() {
  if (getAppLanguage() !== "en") {
    return {
      all: "全", items: "件", updated: "更新日:", expires: "期限切れ", remaining: "残り",
      day: "日", hour: "時間", minute: "分", protected: "パスワード保護", passphrase: "合言葉:",
      filebaseStored: "☁️ Filebase: 保持中", filebaseRemoved: "☁️ Filebase: 未保持",
      filebaseRemovedTooltip: "Filebase実体は削除（アンピン）済みです。再保管するには元ファイルを再アップロードしてください",
      r2Stored: "⚡ R2: 保管中", r2StoredProtected: "⚡ R2: 保管中 (保護)", r2Removed: "⚡ R2: 未保持 (Kubo保全中)",
      r2ProtectedTooltip: "自宅Kuboに保全されるまで、誤消去を防ぐためR2実体は削除できません",
      kuboOff: "🏠 Kubo: 未設定", kuboStored: "🏠 Kubo: 保持中", kuboMissing: "🏠 Kubo: 未保持",
      ipfsDrifting: "🌊 IPFS: 漂流中", ipfsDriftingAlive: "🌊 漂流中 (生存確認)", ipfsDriftingMiss: "⚠️ 漂流中 (応答なし {n}/3)", delete: "削除", rename: "ファイル名を変更",
      nodeCheck: "🌐 ノード確認 ↗", workflow: "🧬 ワークフローあり", connectionError: "通信エラー:",
      neverDelete: "⏳ 削除しない（無期限）", deleteAfter: "後に削除",
    };
  }
  return {
    all: "All", items: "items", updated: "Updated:", expires: "Expired", remaining: "Remaining",
    day: "d", hour: "h", minute: "m", protected: "Password protected", passphrase: "Passphrase:",
    filebaseStored: "☁️ Filebase: Stored", filebaseRemoved: "☁️ Filebase: Unpinned",
    filebaseRemovedTooltip: "Object is unpinned from Filebase. Re-upload the original file to re-store.",
    r2Stored: "⚡ R2: Stored", r2StoredProtected: "⚡ R2: Stored (Locked)", r2Removed: "⚡ R2: Unstored (On Kubo)",
    r2ProtectedTooltip: "Cannot remove R2 object until it is pinned on your home Kubo node to prevent data loss.",
    kuboOff: "🏠 Kubo: Disabled", kuboStored: "🏠 Kubo: Pinned", kuboMissing: "🏠 Kubo: Not pinned",
    ipfsDrifting: "🌊 IPFS: Drifting", ipfsDriftingAlive: "🌊 Drifting (Alive)", ipfsDriftingMiss: "⚠️ Drifting (Miss {n}/3)", delete: "Delete", rename: "Rename file",
    nodeCheck: "🌐 Check nodes ↗", workflow: "🧬 Workflow found", connectionError: "Connection error:",
    neverDelete: "⏳ Keep forever", deleteAfter: "delete after",
  };
}

function updateStorageTabsUi() {
  if (storageTabR2 && storageTabFilebase) {
    if (activeStorageTab === "filebase") {
      storageTabFilebase.style.border = "1px solid #38bdf8";
      storageTabFilebase.style.background = "rgba(56, 189, 248, 0.15)";
      storageTabFilebase.style.color = "#38bdf8";
      storageTabFilebase.style.fontWeight = "700";

      storageTabR2.style.border = "1px solid var(--border)";
      storageTabR2.style.background = "rgba(255, 255, 255, 0.04)";
      storageTabR2.style.color = "var(--muted)";
      storageTabR2.style.fontWeight = "600";

    } else {
      storageTabR2.style.border = "1px solid #f97316";
      storageTabR2.style.background = "rgba(249, 115, 22, 0.15)";
      storageTabR2.style.color = "#fb923c";
      storageTabR2.style.fontWeight = "700";

      storageTabFilebase.style.border = "1px solid var(--border)";
      storageTabFilebase.style.background = "rgba(255, 255, 255, 0.04)";
      storageTabFilebase.style.color = "var(--muted)";
      storageTabFilebase.style.fontWeight = "600";

    }
  }
  const r2WarningBadge = document.querySelector("#r2BillingWarningBadge");
  if (r2WarningBadge) {
    r2WarningBadge.style.display = activeStorageTab === "filebase" ? "none" : "inline-flex";
  }
  syncAutoFifoControl();
}

function syncAutoFifoControl() {
  if (!autoFifoCheckbox || !autoFifoLabel) return;
  const isFilebase = activeStorageTab === "filebase";
  // Filebase/R2 共に互換と安全マージンのため既定ON（明示的に OFF にされた場合のみ false）。
  const enabled = isFilebase
    ? localStorage.getItem("autoFifo") !== "false"
    : localStorage.getItem("r2AutoFifo") !== "false";
  autoFifoCheckbox.checked = enabled;
  const isEnglish = getAppLanguage() === "en";
  const labelText = isFilebase
    ? (isEnglish ? "📦 Filebase automatic capacity release (FIFO)" : "📦 Filebase 自動容量解放 (FIFO)")
    : (isEnglish ? "📦 R2 automatic capacity release (FIFO)" : "📦 R2 自動容量解放 (FIFO)");
  const titleText = isFilebase
    ? (isEnglish ? "When Filebase nears its storage limit, unpin old objects to make space while keeping their URLs." : "Filebase の容量上限に近づいたとき、古い実体をアンピンして空きを確保します（URLは維持）")
    : (isEnglish ? "When R2 nears its storage limit, delete old files to make space." : "R2 の容量上限に近づいたとき、古いファイルを削除して空きを確保します");
  autoFifoLabel.title = titleText;
  const text = autoFifoLabel.querySelector("span");
  if (text) text.textContent = labelText;
}

// 📄 ストレージ一覧 ページネーション描画 & UI更新
function updateStoragePaginationUI(totalItems) {
  if (!r2PaginationControls || !r2PageInfo || !r2PrevPageBtn || !r2NextPageBtn) return;
  const labels = getStorageListLabels();

  if (storagePerPage <= 0) {
    // 「すべて」表示
    storageCurrentPage = 1;
    r2PageInfo.textContent = getAppLanguage() === "en" ? `${labels.all} ${totalItems} ${labels.items}` : `${labels.all} ${totalItems} ${labels.items}`;
    r2PrevPageBtn.disabled = true;
    r2NextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / storagePerPage));
  if (storageCurrentPage > totalPages) {
    storageCurrentPage = totalPages;
  }
  if (storageCurrentPage < 1) {
    storageCurrentPage = 1;
  }

  r2PageInfo.textContent = `${storageCurrentPage} / ${totalPages} (${totalItems}${getAppLanguage() === "en" ? ` ${labels.items}` : labels.items})`;
  r2PrevPageBtn.disabled = storageCurrentPage <= 1;
  r2NextPageBtn.disabled = storageCurrentPage >= totalPages;

  if (r2PerPageSelect) {
    r2PerPageSelect.value = String(storagePerPage);
  }
}

// ◀ 前へ
r2PrevPageBtn?.addEventListener("click", () => {
  if (storageCurrentPage > 1) {
    storageCurrentPage--;
    renderCurrentStoragePage();
  }
});

// ▶ 次へ
r2NextPageBtn?.addEventListener("click", () => {
  const visibleCount = storageCachedContents.filter(item => item.storageProvider === activeStorageTab).length;
  const totalPages = Math.max(1, Math.ceil(visibleCount / (storagePerPage || 1)));
  if (storageCurrentPage < totalPages) {
    storageCurrentPage++;
    renderCurrentStoragePage();
  }
});

// 表示件数変更
r2PerPageSelect?.addEventListener("change", (e) => {
  storagePerPage = parseInt(e.target.value, 10);
  localStorage.setItem("storagePerPage", String(storagePerPage));
  storageCurrentPage = 1;
  renderCurrentStoragePage();
});

storageTabR2?.addEventListener("click", () => {
  activeStorageTab = "r2";
  localStorage.setItem("activeStorageTab", "r2");
  storageCurrentPage = 1;
  updateStorageTabsUi();
  syncStorageLimitControl();
  renderR2DomainSelect("r2");
  const cached = loadLedgerFromLocalStorage("r2");
  if (cached && cached.length > 0) {
    storageCachedContents = cached;
    renderCurrentStoragePage();
  } else {
    fetchAndRenderR2Files();
  }
});

storageTabFilebase?.addEventListener("click", () => {
  activeStorageTab = "filebase";
  localStorage.setItem("activeStorageTab", "filebase");
  storageCurrentPage = 1;
  updateStorageTabsUi();
  syncStorageLimitControl();
  renderR2DomainSelect("filebase");
  const cached = loadLedgerFromLocalStorage("filebase");
  if (cached && cached.length > 0) {
    storageCachedContents = cached;
    renderCurrentStoragePage();
  } else {
    fetchAndRenderR2Files();
  }
});

reloadR2FilesButton?.addEventListener("click", () => {
  storageCurrentPage = 1;
  fetchAndRenderR2Files({ cleanupExpiredCivitaiTransfers: true });
  const s3 = getS3Client(activeStorageTab);
  const bucketName = getBucketName(activeStorageTab);
  maybeDrainTombstonesDaily(s3, bucketName);
});

// 🚀 初回オンボーディング（設定・接続案内カード）の描画
function renderStorageOnboardingCard() {
  if (!r2FileList) return;

  const isFb = activeStorageTab === "filebase";
  const isEnglish = getAppLanguage() === "en";
  // R2 CORS の案内文（日本語版）で展開するため、翻訳オブジェクトを
  // 構築する前に確定させる。
  const frontendOrigin = (typeof window !== "undefined" ? window.location.origin : "https://your-app.pages.dev").replace(/\/$/, "");
  const onboarding = isEnglish ? {
    title: `Connect ${isFb ? "🪐 Filebase (IPFS)" : "⚡ Cloudflare R2"} to get started`,
    intro: "Connect your KV Worker first, then use a dedicated pages.dev relay as the public delivery URL. This keeps the URL you share separate from the delivery backend.",
    kvStep: "STEP 1: KV Registry Worker (required: short URLs, expiry, and protection)",
    kvIntro: "Deploy the <code>kv-worker</code> to your own Cloudflare account for short URLs, expiry, password gates, and safe edge-cached delivery.",
    kvAfterDeploy: "Enter the Worker URL issued after deployment and the ADMIN_TOKEN you configured.",
    kvUrl: "KV Registry Worker URL", connectKv: "🔌 Save and connect KV",
    kvSetupGuide: "First-time Worker setup from GitHub",
    kvSetupIntro: "Only needed when you have not deployed your own Worker yet. Keep the API tokens private; do not commit them.",
    kvClone: "Clone or update the Worker source",
    kvUpdateComment: "# later updates: git pull --ff-only",
    kvNamespace: "Create a KV namespace and copy its id into wrangler.toml",
    kvSecrets: "Register the secrets (enter the same ADMIN_API_TOKEN below)",
    kvDeploy: "Deploy, then copy the Workers URL shown by Wrangler",
    storageStep: `STEP 2: ${isFb ? "🪐 Filebase (IPFS) and custom delivery edge" : "⚡ Cloudflare R2 and custom delivery edge"}`,
    storageIntro: isFb ? "The default Worker URL can already deliver IPFS files as delivery-domain/file-name. To use a dedicated delivery URL, deploy Pages or configure a Worker custom domain, then enter that URL." : "The default Worker URL can already deliver files. To use a dedicated delivery URL, deploy Pages or configure a Worker custom domain, then enter that URL.",
    pagesGuide: "Create a public pages.dev relay (required for public sharing)",
    pagesIntro: "This is the board-facing URL. It is a static redirect layer: it has no storage credentials, KV binding, or application Function.",
    pagesTemplate: "Copy the matching relay template and set its backend origin",
    pagesCopyComment: "# copy _redirects.template into an empty folder as _redirects",
    pagesOriginComment: "# replace the placeholder with your delivery backend URL",
    pagesDeploy: "Deploy the relay directory as its own Pages project",
    pagesLastStep: "Enter the resulting <code>https://my-content-cache.pages.dev</code> below as the public / delivery domain.",
    filebaseCorsSummary: "Filebase bucket CORS setup (once after connecting)",
    filebaseCorsBody: "CORS is required for browser uploads and IPFS CID lookup. After connecting to Filebase, open <strong>Cloud Storage Settings</strong> above and run <strong>⚙️ Configure CORS</strong> once in the Filebase (IPFS) section. No manual JSON is required.",
    r2CorsSummary: "R2 bucket CORS setup (required for browser access)",
    r2CorsBody: "In Cloudflare Dashboard → R2 → your bucket → <strong>Settings</strong> → <strong>CORS Policy</strong> → Edit, paste and save the policy below.<br>The first URL is the frontend URL currently opening this app (<code>${escapeHtml(frontendOrigin)}</code>), not the delivery domain.",
    deliveryDomain: "Public / delivery domain", requiredWorkerDomain: "(required: public pages.dev relay URL)",
    filebaseBucket: "Filebase bucket name", r2Bucket: "R2 bucket name",
    locked: "🔒 Complete and verify Step 1 before entering these fields", connectStorage: `💾 Save and connect ${isFb ? "Filebase" : "R2"}`,
    copiedCors: "📋 CORS policy copied",
    adminToken: "Admin API Token", required: "(required)",
  } : {
    title: `${isFb ? "🪐 Filebase (IPFS)" : "⚡ Cloudflare R2"} へ接続して開始しましょう`,
    intro: "まず KV 台帳 Worker を接続し、公開・配信URLには専用の pages.dev リレーを登録します。掲示板へ貼るURLと実際の配信バックエンドを分ける構成です。",
    kvStep: "STEP 1: KV 台帳 Worker 連携 (必須: 高速短縮URL・時限削除・保護)",
    kvIntro: "短縮URL・時限削除・パスワード保護・安全なエッジキャッシュ配信を行うため、各自の Cloudflare に <code>kv-worker</code> をデプロイします。",
    kvAfterDeploy: "デプロイ後に発行された Worker URL と設定した ADMIN_TOKEN を入力してください。",
    kvUrl: "KV 台帳 Worker URL", connectKv: "🔌 保存して KV に接続",
    kvSetupGuide: "GitHub から初回セットアップする",
    kvSetupIntro: "自分用の Worker をまだデプロイしていない場合だけ実行します。APIトークンは秘密情報なので、Gitへコミット・共有しないでください。",
    kvClone: "Worker ソースを取得／更新する",
    kvUpdateComment: "# 更新時: git pull --ff-only",
    kvNamespace: "KV 名前空間を作成し、表示された id を wrangler.toml へ貼る",
    kvSecrets: "秘密値を登録する（下欄へ入力する ADMIN_API_TOKEN と同じ値を設定）",
    kvDeploy: "デプロイ後、Wrangler が表示した Workers URL をコピーする",
    storageStep: `STEP 2: ${isFb ? "🪐 Filebase (IPFS) & 独自配信エッジ設定" : "⚡ Cloudflare R2 & 独自配信エッジ設定"}`,
    storageIntro: isFb ? "初期値の Worker URL のままでも、IPFSファイルを「配信ドメイン/ファイル名」で配信できます。独自の配信 URL に変えたい場合は Pages のデプロイまたは Worker の独自ドメイン設定後、その URL を入力してください。" : "初期値の Worker URL のままでもファイルを配信できます。独自の配信 URL に変えたい場合は Pages のデプロイまたは Worker の独自ドメイン設定後、その URL を入力してください。",
    pagesGuide: "公開用 pages.dev リレーを作る（公開・掲示板運用では必須）",
    pagesIntro: "掲示板へ貼る公開URLです。静的リダイレクトだけを行い、ストレージ資格情報・KV・Functionは持ちません。",
    pagesTemplate: "対応するリレーテンプレートをコピーし、配信バックエンドURLを設定する",
    pagesCopyComment: "# _redirects.template を空フォルダ内の _redirects としてコピー",
    pagesOriginComment: "# プレースホルダーを自分の配信バックエンドURLへ置換",
    pagesDeploy: "そのフォルダを専用の Pages プロジェクトとしてデプロイする",
    pagesLastStep: "発行された <code>https://my-content-cache.pages.dev</code> を下の「公開・配信ドメイン」へ入力",
    filebaseCorsSummary: "Filebase バケットの CORS 設定（接続後に一度だけ）",
    filebaseCorsBody: "ブラウザからアップロードし、IPFS CID を取得するため CORS が必要です。Filebase への接続が成功したら、画面上部の <strong>☁️ クラウドストレージ接続設定</strong> を開き、Filebase (IPFS) 欄の <strong>⚙️ CORS自動設定</strong> を一度実行してください。手動で JSON を貼り付ける必要はありません。",
    r2CorsSummary: "R2 バケットの CORS 設定（ブラウザから接続するため必須）",
    r2CorsBody: `Cloudflare Dashboard → R2 → 対象バケット → <strong>Settings</strong> → <strong>CORS Policy</strong> → Edit に、次を貼り付けて保存してください。<br>先頭の URL は、現在このアプリを開いているフロントエンド URL（<code>${escapeHtml(frontendOrigin)}</code>）です。配信ドメインではありません。`,
    deliveryDomain: "公開・配信ドメイン", requiredWorkerDomain: "(必須: 公開用 pages.dev リレーURL)",
    filebaseBucket: "Filebase バケット名", r2Bucket: "R2 バケット名",
    locked: "🔒 STEP 1 の接続確認後に入力できます", connectStorage: `💾 保存して ${isFb ? "Filebase" : "R2"} に接続`,
    copiedCors: "📋 CORS 設定をコピーしました",
    adminToken: "Admin API Token", required: "(必須)",
  };
  // 接続テストに通るまでは次の段階を開かない。画面を閉じた際にも
  // 中途半端な認証情報だけで次段階へ進まないよう、現在のタブ内だけで保持する。
  const kvConnected = sessionStorage.getItem("onboardingKvConnected") === "true";
  const kvSuccessMessage = sessionStorage.getItem("onboardingKvSuccessMessage") || "";
  const currentDomain = getSelectedR2Domain() || (typeof window !== "undefined" ? window.location.origin : "");
  const fbBucketVal = (localStorage.getItem("filebaseBucket") || filebaseBucket?.value || "").trim();
  const fbKeyVal = (localStorage.getItem("filebaseApiKey") || filebaseApiKey?.value || "").trim();
  const fbSecretVal = (localStorage.getItem("filebaseSecretKey") || filebaseSecretKey?.value || "").trim();

  const r2AccountVal = (localStorage.getItem("r2AccountId") || r2AccountId?.value || "").trim();
  const r2BucketVal = (localStorage.getItem("r2BucketName") || r2BucketName?.value || "").trim();
  const r2KeyVal = (localStorage.getItem("r2AccessKeyId") || r2AccessKeyId?.value || "").trim();
  const r2SecretVal = (localStorage.getItem("r2SecretAccessKey") || r2SecretAccessKey?.value || "").trim();

  const kvUrlVal = (localStorage.getItem("kvWorkerUrl") || kvWorkerUrl?.value || "").trim();
  const adminTokenVal = (localStorage.getItem("adminApiToken") || adminApiToken?.value || "").trim();
  // R2 の S3 API をブラウザから直接呼ぶため、CORS では「配信先」ではなく
  // このフロントエンドを開いている Origin を許可する。
  const r2CorsOrigins = [...new Set([frontendOrigin, "http://127.0.0.1:5173", "http://localhost:5173"])];
  const r2CorsPolicy = JSON.stringify([{
    AllowedOrigins: r2CorsOrigins,
    AllowedMethods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Type"],
    MaxAgeSeconds: 3600,
  }], null, 2);

  r2FileList.innerHTML = `
    <div class="storage-onboarding-card">
      <div class="onboarding-header">
        <div>
          <h3 class="onboarding-title">✨ ${onboarding.title}</h3>
          <p class="onboarding-desc">${onboarding.intro}</p>
        </div>
      </div>

      <!-- ステップガイド＆入力フォーム -->
      <div class="onboarding-step-grid">
        <!-- STEP 1: cividge-kv-worker デプロイ & 連携案内 -->
        <div class="onboarding-step-box">
          <span class="onboarding-step-badge" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b;">${onboarding.kvStep}</span>
          <div style="font-size: 11.5px; color: var(--muted); line-height: 1.5;">
            ${onboarding.kvIntro}
            <details class="onboarding-guide-details">
              <summary>${onboarding.kvSetupGuide}</summary>
              <p style="margin: 8px 0;">${onboarding.kvSetupIntro}</p>
              <ol>
                <li><strong>${onboarding.kvClone}</strong>
                  <pre><code>git clone https://github.com/OKPN/cividge-kv-worker.git
cd cividge-kv-worker
${onboarding.kvUpdateComment}</code></pre>
                </li>
                <li><strong>${onboarding.kvNamespace}</strong>
                  <pre><code>npx wrangler login
npx wrangler kv namespace create CIVIDGE_KV</code></pre>
                </li>
                <li><strong>${onboarding.kvSecrets}</strong>
                  <pre><code>npx wrangler secret put ADMIN_API_TOKEN
npx wrangler secret put UPLOAD_TOKEN</code></pre>
                </li>
                <li><strong>${onboarding.kvDeploy}</strong>
                  <pre><code>npx wrangler deploy</code></pre>
                </li>
              </ol>
            </details>
            ${onboarding.kvAfterDeploy}
          </div>

          <div class="onboarding-input-field">
            <label>${onboarding.kvUrl} <span style="color: #ef4444; font-weight: bold;">${isEnglish ? "(required)" : "(必須)"}</span></label>
            <input type="text" id="obKvUrl" placeholder="例: https://cividge-kv-worker.yourname.workers.dev" value="${escapeHtml(kvUrlVal)}">
          </div>
          <div class="onboarding-input-field">
            <label>${onboarding.adminToken} <span style="color: #ef4444; font-weight: bold;">${onboarding.required}</span></label>
            <input type="password" id="obAdminToken" placeholder="${isEnglish ? "e.g. your-secret-token" : "例: your-secret-token"}" value="${escapeHtml(adminTokenVal)}">
          </div>
          <div class="onboarding-step-action">
            <span id="obKvStatus" class="onboarding-step-status" style="color: ${kvSuccessMessage ? "#4ade80" : "#fcd34d"};">${escapeHtml(kvSuccessMessage)}</span>
            <button type="button" class="ghost-button" id="obKvConnectBtn">${onboarding.connectKv}</button>
          </div>
        </div>

        <!-- STEP 2: ストレージ認証情報 (R2またはFilebase個別画面) -->
        <div class="onboarding-step-box">
          <span class="onboarding-step-badge" style="background: ${isFb ? 'rgba(56, 189, 248, 0.2); color: #38bdf8;' : 'rgba(249, 115, 22, 0.2); color: #fb923c;'}">
            ${onboarding.storageStep}
          </span>
          <div style="font-size: 11.5px; color: var(--muted); line-height: 1.5; margin-bottom: 8px;">
            ${onboarding.storageIntro}
            <details class="onboarding-guide-details">
              <summary>${onboarding.pagesGuide}</summary>
              <p style="margin: 8px 0;">${onboarding.pagesIntro}</p>
              <ol>
                <li><strong>${onboarding.pagesTemplate}</strong>
                  <pre><code>git clone https://github.com/OKPN/cividge.git
cd cividge/compatibility-layer/${isFb ? "filebase" : "r2"}
mkdir ../../my-content-cache
cp _redirects.template ../../my-content-cache/_redirects
${onboarding.pagesCopyComment}
${onboarding.pagesOriginComment}: __${isFb ? "FILEBASE" : "R2"}_COMPATIBILITY_ORIGIN__</code></pre>
                </li>
                <li><strong>${onboarding.pagesDeploy}</strong>
                  <pre><code>cd ../../my-content-cache
npx wrangler login
npx wrangler pages deploy . --project-name=my-content-cache</code></pre>
                </li>
                <li>${onboarding.pagesLastStep}</li>
              </ol>
            </details>
            ${isFb ? `
            <details class="onboarding-guide-details" style="margin-top: 8px;">
              <summary>${onboarding.filebaseCorsSummary}</summary>
              <p style="margin: 8px 0;">${onboarding.filebaseCorsBody}</p>
            </details>` : ""}
            ${isFb ? "" : `
            <details class="onboarding-guide-details" style="margin-top: 8px;">
              <summary>${onboarding.r2CorsSummary}</summary>
              <p style="margin: 8px 0;">${onboarding.r2CorsBody}</p>
              <pre style="margin: 0; padding: 9px; overflow: auto; border-radius: 6px; background: rgba(0,0,0,.38); font-size: 10px; line-height: 1.4; white-space: pre-wrap;"><code>${escapeHtml(r2CorsPolicy)}</code></pre>
              <button type="button" class="ghost-button" id="obCopyR2CorsBtn" style="margin-top: 8px; font-size: 11px;">📋 CORS 設定をコピー</button>
            </details>`}
          </div>

          <fieldset id="obStorageStep" ${kvConnected ? "" : "disabled"} style="border: 0; padding: 0; margin: 0; min-width: 0; opacity: ${kvConnected ? "1" : "0.5"};">
          ${isFb ? `
          <!-- Filebase 専用設定フォーム -->
          <div id="obFbFields" style="display: flex; flex-direction: column; gap: 8px;">
            <div class="onboarding-input-field">
              <label>${onboarding.deliveryDomain} <span style="color: #ef4444; font-weight: bold;">${onboarding.requiredWorkerDomain}</span></label>
              <input type="text" id="obDomainInput" placeholder="例: https://my-media.pages.dev" value="${escapeHtml(currentDomain)}">
            </div>
            <div class="onboarding-input-field">
              <label>${onboarding.filebaseBucket}</label>
              <input type="text" id="obFbBucket" placeholder="例: my-ipfs-bucket" value="${escapeHtml(fbBucketVal)}">
            </div>
            <div class="onboarding-input-field">
              <label>Filebase API Key (Access Key)</label>
              <input type="text" id="obFbKey" placeholder="例: E39D98762..." value="${escapeHtml(fbKeyVal)}">
            </div>
            <div class="onboarding-input-field">
              <label>Filebase Secret Key</label>
              <input type="password" id="obFbSecret" placeholder="例: WkH18302..." value="${escapeHtml(fbSecretVal)}">
            </div>
          </div>
          ` : `
          <!-- R2 専用設定フォーム -->
          <div id="obR2Fields" style="display: flex; flex-direction: column; gap: 8px;">
            <div class="onboarding-input-field">
              <label>${onboarding.deliveryDomain} <span style="color: #ef4444; font-weight: bold;">${onboarding.requiredWorkerDomain}</span></label>
              <input type="text" id="obR2DomainInput" placeholder="例: https://my-media.pages.dev" value="${escapeHtml(currentDomain)}">
            </div>
            <div class="onboarding-input-field">
              <label>Cloudflare Account ID</label>
              <input type="text" id="obR2Account" placeholder="例: 0123456789abcdef..." value="${escapeHtml(r2AccountVal)}">
            </div>
            <div class="onboarding-input-field">
              <label>${onboarding.r2Bucket}</label>
              <input type="text" id="obR2Bucket" placeholder="例: my-bucket" value="${escapeHtml(r2BucketVal)}">
            </div>
            <div class="onboarding-input-field">
              <label>Access Key ID</label>
              <input type="text" id="obR2Key" placeholder="例: c8a1928374..." value="${escapeHtml(r2KeyVal)}">
            </div>
            <div class="onboarding-input-field">
              <label>Secret Access Key</label>
              <input type="password" id="obR2Secret" placeholder="例: 99f87654..." value="${escapeHtml(r2SecretVal)}">
            </div>
          </div>
          `}
          </fieldset>
          <div class="onboarding-step-action">
            <span id="obStorageStatus" class="onboarding-step-status">${kvConnected ? "" : onboarding.locked}</span>
            <button type="button" class="primary-button" id="obStorageConnectBtn" ${kvConnected ? "" : "disabled"}>${onboarding.connectStorage}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const copyR2CorsButton = document.querySelector("#obCopyR2CorsBtn");
  copyR2CorsButton?.addEventListener("click", async () => {
    await copyToClipboard(r2CorsPolicy, copyR2CorsButton, onboarding.copiedCors);
  });

  const readDraftDomain = () => {
    const input = isFb ? document.querySelector("#obDomainInput") : document.querySelector("#obR2DomainInput");
    const value = input?.value?.trim().replace(/\/$/, "") || "";
    return value && !/^https?:\/\//i.test(value) ? `https://${value}` : value;
  };

  // 接続テスト成功後だけ、下書きを通常設定と localStorage に確定する。
  const saveStorageDraft = () => {
    const domain = readDraftDomain();
    if (domain) {
      const list = getR2DomainList();
      if (!list.includes(domain)) {
        list.push(domain);
        saveR2DomainList(list);
      }
      setSelectedR2Domain(domain);
      renderR2DomainSelect();
    }
    if (isFb) {
      const fbBucketInput = document.querySelector("#obFbBucket");
      const fbKeyInput = document.querySelector("#obFbKey");
      const fbSecretInput = document.querySelector("#obFbSecret");
      if (filebaseBucket && fbBucketInput) filebaseBucket.value = fbBucketInput.value.trim();
      if (filebaseApiKey && fbKeyInput) filebaseApiKey.value = fbKeyInput.value.trim();
      if (filebaseSecretKey && fbSecretInput) filebaseSecretKey.value = fbSecretInput.value.trim();
    } else {
      const r2AccInput = document.querySelector("#obR2Account");
      const r2BktInput = document.querySelector("#obR2Bucket");
      const r2KeyInput = document.querySelector("#obR2Key");
      const r2SecInput = document.querySelector("#obR2Secret");
      if (r2AccountId && r2AccInput) r2AccountId.value = r2AccInput.value.trim();
      if (r2BucketName && r2BktInput) r2BucketName.value = r2BktInput.value.trim();
      if (r2AccessKeyId && r2KeyInput) r2AccessKeyId.value = r2KeyInput.value.trim();
      if (r2SecretAccessKey && r2SecInput) r2SecretAccessKey.value = r2SecInput.value.trim();
    }

    saveR2SettingsAuto();
    updateR2Status();
  };

  const obKvConnectBtn = document.querySelector("#obKvConnectBtn");
  const obKvStatus = document.querySelector("#obKvStatus");
  const obStorageConnectBtn = document.querySelector("#obStorageConnectBtn");
  const obStorageStatus = document.querySelector("#obStorageStatus");

  obKvConnectBtn?.addEventListener("click", async () => {
    const rawKvUrl = document.querySelector("#obKvUrl")?.value?.trim().replace(/\/$/, "") || "";
    const kvUrl = rawKvUrl && !/^https?:\/\//i.test(rawKvUrl) ? `https://${rawKvUrl}` : rawKvUrl;
    const adminTok = document.querySelector("#obAdminToken")?.value?.trim() || "";

    if (!kvUrl || !adminTok) {
      if (obKvStatus) obKvStatus.textContent = "⚠️ Worker URL と Admin API Token を入力してください。";
      return;
    }
    const apiEndpoint = (kvUrl.endsWith("/api/cividge-kv") || kvUrl.endsWith("/api/ipfs-kv")) ? kvUrl : `${kvUrl}/api/cividge-kv`;
    const originalText = obKvConnectBtn.textContent;
    obKvConnectBtn.disabled = true;
    obKvConnectBtn.textContent = "🔄 KV 接続を確認中...";
    if (obKvStatus) obKvStatus.textContent = "";
    try {
      const response = await fetch(apiEndpoint, { headers: { Authorization: `Bearer ${adminTok}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.json();
      if (kvWorkerUrl) kvWorkerUrl.value = kvUrl;
      if (adminApiToken) adminApiToken.value = adminTok;
      // 初回は同じ Worker をそのまま配信エッジとして利用できる。
      // 利用者が既に選んだ独自ドメインがある場合は上書きしない。
      if (!getSelectedR2Domain()) {
        const workerDeliveryDomain = kvUrl.replace(/\/api\/(cividge-kv|ipfs-kv)\/?$/, "");
        const domains = getR2DomainList();
        if (!domains.includes(workerDeliveryDomain)) {
          domains.push(workerDeliveryDomain);
          saveR2DomainList(domains);
        }
        setSelectedR2Domain(workerDeliveryDomain);
        renderR2DomainSelect();
      }
      saveR2SettingsAuto();
      updateR2Status();
      sessionStorage.setItem("onboardingKvConnected", "true");
      sessionStorage.setItem("onboardingKvSuccessMessage", "✅ KV 接続に成功しました。STEP 2 を入力できます。");
      renderStorageOnboardingCard();
    } catch (error) {
      if (obKvStatus) obKvStatus.textContent = `⚠️ KV 接続に失敗しました: ${error.message}`;
      obKvConnectBtn.disabled = false;
      obKvConnectBtn.textContent = originalText;
    }
  });

  obStorageConnectBtn?.addEventListener("click", async () => {
    const domain = readDraftDomain();
    const bucket = (isFb ? document.querySelector("#obFbBucket") : document.querySelector("#obR2Bucket"))?.value?.trim() || "";
    const accessKey = (isFb ? document.querySelector("#obFbKey") : document.querySelector("#obR2Key"))?.value?.trim() || "";
    const secretKey = (isFb ? document.querySelector("#obFbSecret") : document.querySelector("#obR2Secret"))?.value?.trim() || "";
    const accountId = isFb ? "" : (document.querySelector("#obR2Account")?.value?.trim() || "");
    if (!domain || !bucket || !accessKey || !secretKey || (!isFb && !accountId)) {
      if (obStorageStatus) obStorageStatus.textContent = "⚠️ 公開・配信ドメインとストレージ認証情報をすべて入力してください。";
      return;
    }
    const client = new S3Client(isFb ? {
      region: "us-east-1", endpoint: "https://s3.filebase.io", forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    } : {
      region: "auto", endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
    const originalText = obStorageConnectBtn.textContent;
    obStorageConnectBtn.disabled = true;
    obStorageConnectBtn.textContent = "🔄 ストレージ接続を確認中...";
    if (obStorageStatus) obStorageStatus.textContent = "";
    try {
      await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
      saveStorageDraft();
      storageCurrentPage = 1;
      await fetchAndRenderR2Files();
      if (r2FileList) {
        const notice = document.createElement("div");
        notice.className = "storage-connection-success";
        notice.textContent = `✅ ${isFb ? "Filebase" : "Cloudflare R2"} への接続に成功しました。設定を保存し、ファイル一覧を読み込みました。`;
        notice.style.cssText = "margin: 0 0 12px; padding: 10px 12px; border: 1px solid rgba(74, 222, 128, 0.45); border-radius: 7px; background: rgba(22, 163, 74, 0.12); color: #86efac; font-size: 12px;";
        r2FileList.prepend(notice);
      }
    } catch (error) {
      if (obStorageStatus) obStorageStatus.textContent = `⚠️ ${isFb ? "Filebase" : "R2"} 接続に失敗しました: ${error.message}`;
      obStorageConnectBtn.disabled = false;
      obStorageConnectBtn.textContent = originalText;
    }
  });
}

async function fetchAndRenderR2Files({ cleanupExpiredCivitaiTransfers = false } = {}) {
  if (!r2FileList) return;
  const fetchGeneration = ++storageFetchGeneration;
  const requestedProvider = activeStorageTab;
  updateStorageTabsUi();

  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  const isFilebase = requestedProvider === "filebase";
  const s3 = getS3Client(requestedProvider);
  const bucketName = getBucketName(requestedProvider);
  const providerLabel = isFilebase ? "Filebase (IPFS)" : "Cloudflare R2";
  const isStorageConfigured = isFilebase ? isFilebaseConfigured() : isR2Configured();
  const hasKvAccess = hasAdminAccess();

  // 🌟 ストレージ未設定、かつ KV台帳連携もない場合のみオンボーディングカードを描画。
  // KV台帳連携がある場合は、S3秘密鍵が端末に入っていなくてもKV台帳ビュー（閲覧・共有専用）として一覧を表示！
  if ((!isStorageConfigured || !s3 || !bucketName) && !hasKvAccess) {
    storageCachedContents = [];
    storageCurrentPage = 1;
    updateStoragePaginationUI(0);
    renderStorageOnboardingCard();
    state.r2TotalSize = 0;
    updateStorageUsageUI();
    return;
  }

  const isViewerMode = (!isStorageConfigured || !s3 || !bucketName) && hasKvAccess;
  if (!storageCachedContents || storageCachedContents.length === 0) {
    const localLedger = loadLedgerFromLocalStorage(requestedProvider);
    if (localLedger && localLedger.length > 0) {
      storageCachedContents = localLedger;
      renderCurrentStoragePage();
    } else {
      r2FileList.innerHTML = `<span class="status-text saving" style="padding: 18px; display: block;">${providerLabel}${isViewerMode ? " (KV台帳モード)" : ""} ファイル一覧を取得中...</span>`;
    }
  }

  try {
    let s3RawList = [];
    if (s3 && bucketName) {
      try {
        const command = new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
        });
        const response = await s3.send(command);
        s3RawList = (response.Contents || []).map(item => ({
          Key: item.Key,
          Size: item.Size || 0,
          LastModified: item.LastModified,
        }));
      } catch (s3Err) {
        console.warn("S3 ListObjectsV2 error:", s3Err);
        if (!hasKvAccess) throw s3Err;
      }
    }

    if (fetchGeneration !== storageFetchGeneration || activeStorageTab !== requestedProvider) return;
    let contents = [];
    const baseDomain = (getSelectedR2Domain(requestedProvider) || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");

    if (isFilebase) {
      // 🪐 Filebase (IPFS) モード: S3実体とKV名札をスマートマッチング


      const s3KeyToItem = new Map();
      const s3CidToItem = new Map();
      for (const s3Item of s3RawList) {
        s3KeyToItem.set(s3Item.Key, s3Item);
        const cid = getStoredIpfsCid(s3Item.Key);
        if (cid) s3CidToItem.set(cid, s3Item);
      }

      let kvFiles = [];
      try {
        kvFiles = await fetchKvFiles();
      } catch (kvErr) {
        console.warn("fetchKvFiles merge error:", kvErr);
      }

      // KV アイテムの CID 補完と S3 実体キーの紐付け学習
      for (const kvItem of kvFiles) {
        if (!kvItem.metadata) kvItem.metadata = {};
        if (!kvItem.metadata.cid) {
          kvItem.metadata.cid = getStoredIpfsCid(kvItem.name);
        }
        const recordedS3Key = kvItem.metadata.s3Key;
        const cid = kvItem.metadata.cid;
        if (cid) {
          if (recordedS3Key) {
            storeIpfsCid(recordedS3Key, cid);
            if (s3KeyToItem.has(recordedS3Key)) {
              s3CidToItem.set(cid, s3KeyToItem.get(recordedS3Key));
            }
          }
          if (s3KeyToItem.has(kvItem.name)) {
            s3CidToItem.set(cid, s3KeyToItem.get(kvItem.name));
          }
        }
      }


      const consumedS3Keys = new Set();

      // 1. KV に登録されている名前（公開URL名）を最優先でリスト構築
      for (const kvItem of kvFiles) {
        const rawKey = kvItem.name;
        // hostname:filename の形式（別ドメイン個別キー）なら表示ファイル名を抽出
        const colonIdx = rawKey.indexOf(":");
        const displayName = (colonIdx > 0 && !rawKey.startsWith("tombstone_") && !rawKey.startsWith("blob_"))
          ? rawKey.substring(colonIdx + 1)
          : rawKey;

        const kvCid = kvItem.metadata?.cid || getStoredIpfsCid(rawKey) || getStoredIpfsCid(displayName);
        const recordedS3Key = kvItem.metadata?.s3Key;

        // 🪐 Filebase タブ: R2 ストレージ専用レコードは除外する [INV-FRONT-005]
        const isExplicitFilebase = kvItem.metadata?.backend === "filebase" || kvItem.metadata?.b === "filebase";
        const isExplicitR2 = kvCid === "r2" ||
          kvItem.metadata?.backend === "r2" ||
          kvItem.metadata?.b === "r2" ||
          kvItem.value === "r2";
        
        if (isExplicitR2) {
          continue;
        }
        if (!isExplicitFilebase) {
          const hasMatchingS3 = s3KeyToItem.has(recordedS3Key) || s3KeyToItem.has(rawKey) || s3KeyToItem.has(displayName);
          if (!kvCid && !hasMatchingS3) {
            continue;
          }
        }

        let matchedS3 = null;
        if (recordedS3Key && s3KeyToItem.has(recordedS3Key)) {
          matchedS3 = s3KeyToItem.get(recordedS3Key);
        } else if (s3KeyToItem.has(rawKey)) {
          matchedS3 = s3KeyToItem.get(rawKey);
        } else if (s3KeyToItem.has(displayName)) {
          matchedS3 = s3KeyToItem.get(displayName);
        } else if (kvCid && s3CidToItem.has(kvCid)) {
          matchedS3 = s3CidToItem.get(kvCid);
        }

        if (matchedS3) {
          consumedS3Keys.add(matchedS3.Key);
          contents.push({
            storageProvider: "filebase",
            Key: displayName,
            rawKey: rawKey,
            s3Key: matchedS3.Key,
            Size: matchedS3.Size || kvItem.metadata?.size || 0,
            LastModified: matchedS3.LastModified || (kvItem.metadata?.lastModified ? new Date(kvItem.metadata.lastModified) : null),
            isFromS3: true,
            cid: kvCid || getStoredIpfsCid(matchedS3.Key),
            password: kvItem.metadata?.password || null,
            passwordHash: kvItem.metadata?.passwordHash || null,
            expiresAt: kvItem.metadata?.expiresAt || getCivitaiTemporaryTransfer("filebase", matchedS3.Key)?.expiresAt || null,
            ttl: kvItem.metadata?.ttl || 0,
            civitaiTemporary: Boolean(kvItem.metadata?.civitaiTemporary || kvItem.metadata?.ct || getCivitaiTemporaryTransfer("filebase", matchedS3.Key)),
            metadata: kvItem.metadata || {},
          });
          if (kvCid) {
            storeIpfsCid(rawKey, kvCid);
            storeIpfsCid(displayName, kvCid);
            storeIpfsCid(matchedS3.Key, kvCid);
          }
        } else {
          // S3 に実体がない（アンピン後など）
          contents.push({
            storageProvider: "filebase",
            Key: displayName,
            rawKey: rawKey,
            s3Key: null,
            Size: kvItem.metadata?.size || 0,
            LastModified: kvItem.metadata?.lastModified ? new Date(kvItem.metadata.lastModified) : null,
            isFromS3: false,
            cid: kvCid,
            password: kvItem.metadata?.password || null,
            passwordHash: kvItem.metadata?.passwordHash || null,
            expiresAt: kvItem.metadata?.expiresAt || getCivitaiTemporaryTransfer("filebase", rawKey)?.expiresAt || null,
            ttl: kvItem.metadata?.ttl || 0,
            civitaiTemporary: Boolean(kvItem.metadata?.civitaiTemporary || kvItem.metadata?.ct || getCivitaiTemporaryTransfer("filebase", rawKey)),
            metadata: kvItem.metadata || {},
          });
          if (kvCid) {
            storeIpfsCid(rawKey, kvCid);
            storeIpfsCid(displayName, kvCid);
          }
        }
      }

      // 2. S3 にあるが KV に未登録のアイテムを追加
      for (const s3Item of s3RawList) {
        if (!consumedS3Keys.has(s3Item.Key)) {
          contents.push({
            storageProvider: "filebase",
            Key: s3Item.Key,
            s3Key: s3Item.Key,
            Size: s3Item.Size || 0,
            LastModified: s3Item.LastModified,
            isFromS3: true,
            cid: getStoredIpfsCid(s3Item.Key),
            expiresAt: getCivitaiTemporaryTransfer("filebase", s3Item.Key)?.expiresAt || null,
            civitaiTemporary: Boolean(getCivitaiTemporaryTransfer("filebase", s3Item.Key)),
            metadata: {},
          });
        }
      }
    } else {
      // ⚡ Cloudflare R2 モード: S3 実体と KV エイリアスを結合して各ドメインのカードを構築
      const s3KeyToItem = new Map();
      for (const s3Item of s3RawList) {
        s3KeyToItem.set(s3Item.Key, s3Item);
      }

      let kvFiles = [];
      try {
        kvFiles = await fetchKvFiles();
      } catch (e) {
        console.warn("fetchKvFiles error in R2 mode:", e);
      }

      const consumedS3Keys = new Set();

      // 1. R2 に属する KV レコード（ドメイン別エイリアスを含む）を走査してカード化
      for (const kvItem of kvFiles) {
        const rawKey = kvItem.name;
        if (!rawKey || rawKey.startsWith("tombstone_") || rawKey.startsWith("blob_")) continue;

        const colonIdx = rawKey.indexOf(":");
        const displayName = (colonIdx > 0)
          ? rawKey.substring(colonIdx + 1)
          : rawKey;

        const kvCid = kvItem.metadata?.cid || kvItem.metadata?.c || kvItem.value || getStoredIpfsCid(rawKey) || getStoredIpfsCid(displayName) || "";
        const isExplicitFilebase = kvItem.metadata?.backend === "filebase" || kvItem.metadata?.b === "filebase";
        if (isExplicitFilebase) {
          continue; // 🚨 [INV-FRONT-005] Filebase レコードは絶対に R2 一覧に混入させない！
        }

        const isExplicitR2 = kvItem.metadata?.backend === "r2" || kvItem.metadata?.b === "r2" || kvCid === "r2";
        const hasIpfsCid = kvCid && kvCid !== "r2" && (kvCid.startsWith("Qm") || kvCid.startsWith("baf") || kvCid.length > 20);
        if (hasIpfsCid && !isExplicitR2) continue; // Filebase 専用レコードのみ除外

        const recordedS3Key = kvItem.metadata?.s3Key || kvItem.metadata?.k_s3;
        let matchedS3 = null;
        if (recordedS3Key && s3KeyToItem.has(recordedS3Key)) {
          matchedS3 = s3KeyToItem.get(recordedS3Key);
        } else if (s3KeyToItem.has(rawKey)) {
          matchedS3 = s3KeyToItem.get(rawKey);
        } else if (s3KeyToItem.has(displayName)) {
          matchedS3 = s3KeyToItem.get(displayName);
        }

        // R2 明示レコード、または R2 バケット内の実体とマッチするレコードのみ対象（Viewerモード時はS3実体なしでも表示）
        const isR2Record = isExplicitR2 || Boolean(matchedS3) || (isViewerMode && !isExplicitFilebase);
        if (!isR2Record) continue;

        if (matchedS3) {
          consumedS3Keys.add(matchedS3.Key);
        }

        const rawCandidate = kvItem.metadata?.contentCid || kvItem.metadata?.c_cid || getStoredIpfsCid(matchedS3 ? matchedS3.Key : displayName) || (hasIpfsCid ? kvCid : null);
        const itemContentCid = isValidIpfsCid(rawCandidate) ? rawCandidate : null;
        if (itemContentCid) {
          storeIpfsCid(displayName, itemContentCid);
          storeR2Hash(displayName, itemContentCid);
          if (matchedS3) {
            storeIpfsCid(matchedS3.Key, itemContentCid);
            storeR2Hash(matchedS3.Key, itemContentCid);
          }
        }

        contents.push({
          storageProvider: "r2",
          Key: displayName,
          rawKey: rawKey,
          s3Key: matchedS3 ? matchedS3.Key : (recordedS3Key || displayName),
          Size: (matchedS3 && matchedS3.Size) || kvItem.metadata?.size || kvItem.metadata?.s || 0,
          LastModified: (matchedS3 && matchedS3.LastModified) || (kvItem.metadata?.lastModified ? new Date(kvItem.metadata.lastModified) : null),
          isFromS3: Boolean(matchedS3),
          cid: itemContentCid,
          contentCid: itemContentCid,
          password: kvItem.metadata?.password || null,
          passwordHash: kvItem.metadata?.passwordHash || null,
          expiresAt: kvItem.metadata?.expiresAt || (kvItem.metadata?.e ? kvItem.metadata.e * 1000 : null) || getCivitaiTemporaryTransfer("r2", matchedS3 ? matchedS3.Key : displayName)?.expiresAt || null,
          ttl: kvItem.metadata?.ttl || 0,
          civitaiTemporary: Boolean(kvItem.metadata?.civitaiTemporary || kvItem.metadata?.ct || getCivitaiTemporaryTransfer("r2", matchedS3 ? matchedS3.Key : displayName)),
          metadata: kvItem.metadata || {},
        });
      }

      // 2. R2 バケットに存在するが KV に未登録の物理ファイルを追加＆自動KV同期
      for (const s3Item of s3RawList) {
        if (!consumedS3Keys.has(s3Item.Key)) {
          const rawS3Cid = getStoredIpfsCid(s3Item.Key);
          const s3Cid = isValidIpfsCid(rawS3Cid) ? rawS3Cid : null;
          contents.push({
            storageProvider: "r2",
            Key: s3Item.Key,
            rawKey: s3Item.Key,
            s3Key: s3Item.Key,
            Size: s3Item.Size || 0,
            LastModified: s3Item.LastModified,
            isFromS3: true,
            cid: s3Cid,
            contentCid: s3Cid,
            password: null,
            passwordHash: null,
            expiresAt: getCivitaiTemporaryTransfer("r2", s3Item.Key)?.expiresAt || null,
            ttl: 0,
            civitaiTemporary: Boolean(getCivitaiTemporaryTransfer("r2", s3Item.Key)),
            metadata: {},
          });
          // [INV-CORE-001] [INV-CORE-003] 未同期ファイルを画面表示時に裏で勝手に registerKvCid() 連打して
          // 書き込み上限枠（1日1,000回）を自爆枯渇させる過保護コードを完全排除。未登録ファイルは表示のみに留める。
        }
      }
    }

    // Civitai転送専用の踏み台は、利用者が押す「更新」の時だけ後始末する。
    // 起動・タブ切替・再描画では削除しないため、通常の一覧更新に追加の書き込みはない。
    if (cleanupExpiredCivitaiTransfers) {
      const nowMs = Date.now();
      const expiredCivitaiItems = contents
        .filter(item => item.civitaiTemporary && item.expiresAt && nowMs > Number(item.expiresAt))
        .slice(0, 20);
      if (expiredCivitaiItems.length > 0) {
        const cleanedKeys = await cleanupExpiredCivitaiTransferItems(expiredCivitaiItems, contents, s3, bucketName, requestedProvider);
        if (cleanedKeys.size > 0) {
          contents = contents.filter(item => !cleanedKeys.has(item.rawKey || item.Key));
        }
      }
    }

    // ⏳ 期限切れアイテムの自動回収（最後のリンクなら S3 実体も削除し、一覧から非表示化）
    if (contents.length > 0) {
      const nowMs = Date.now();
      const expiredItems = contents.filter(item => item.expiresAt && nowMs > Number(item.expiresAt));
      if (expiredItems.length > 0) {
        console.log("⏳ 期限切れファイルを検知・回収開始:", expiredItems.map(i => i.Key));
        cleanupExpiredStorageItems(expiredItems, contents, s3, bucketName, requestedProvider);
        const expiredKeySet = new Set(expiredItems.map(i => i.rawKey || i.Key));
        contents = contents.filter(i => !expiredKeySet.has(i.rawKey || i.Key));
      }
    }

    // Filebase FIFO 自動容量解放チェック (一覧更新時に現在容量が上限を超えている場合)
    const isAutoFifo = localStorage.getItem("autoFifo") !== "false";
    if (isFilebase && isAutoFifo && contents.length > 0) {
      const limitMb = Number(localStorage.getItem("filebaseStorageLimit") || "5000");
      const limitBytes = limitMb * 1024 * 1024;
      const countedFifoKeys = new Set();
      let currentOriginBytes = 0;
      for (const c of contents) {
        if (!c.isFromS3) continue;
        const eKey = isFilebase ? (c.cid || getStoredIpfsCid(c.Key) || c.s3Key || c.Key) : (c.s3Key || c.Key);
        if (eKey && countedFifoKeys.has(eKey)) continue;
        if (eKey) countedFifoKeys.add(eKey);
        currentOriginBytes += (c.Size || 0);
      }
      if (currentOriginBytes > limitBytes) {
        try {
          await ensureStorageCapacityFilebase(s3, bucketName, 0);
        } catch (fifoErr) {
          console.debug("Passive FIFO check skipped:", fifoErr);
        }
      }
    }

    // 動画の OGP 用ポスターは派生データであり、通常ファイルとして操作させない。
    // 使用量計算と FIFO の対象には残すが、一覧・URL パレットからは隠す。
    contents = contents.filter(item => !isGeneratedVideoThumbnailKey(item.s3Key || item.Key));

    // （※ 自宅 Kubo 遅延マイグレーションは一覧描画後に実行します）

    paletteFiles = contents.map(item => {
      const itemKey = item.rawKey || item.Key || "";
      const itemDisplayName = item.Key || "";
      const rawAllowedHost = item.metadata?.allowedHost || item.metadata?.d || "";
      const fileDomain = getFileStoredDomain(itemKey, itemDisplayName, rawAllowedHost).replace(/\/$/, "");
      return {
        key: item.Key,
        url: `${fileDomain}/${encodeURIComponent(item.Key)}`,
      };
    });
    renderUrlPalette();

    r2FileList.innerHTML = "";
    if (contents.length === 0) {
      r2FileList.innerHTML = `<span class="item-meta" style="padding: 18px; color: var(--muted); display: block; text-align: center;">${escapeHtml(dict.noFilesR2)}</span>`;
      state.r2TotalSize = 0;
      updateStorageUsageUI();
      return;
    }

    // 🏠 Kubo の連携設定とオンライン状態を事前チェック（未設定時・オフライン時のUI制御用）
    const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";
    let isKuboOnline = false;
    let actualKuboPinnedSet = null;
    if (isKuboAutoPin) {
      const checkRes = await checkKuboOnline(800);
      isKuboOnline = checkRes.online;
      if (isKuboOnline) {
        // 🏠 Kubo がオンラインの場合、現在の実際の Pin リストを取得して KV 側の誤認（Pin されていないのに保持中表示）を訂正
        actualKuboPinnedSet = await getKuboPinnedCids(2500);
      }
    }

    // 更新日時の降順ソート
    contents.sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0));

    // 使用容量は Filebase / S3 に実体があるもののみカウント（アンピン済みは容量 0、同一実体エイリアスは重複排除して1回のみ合算）
    const countedKeys = new Set();
    let uniqueTotalSize = 0;
    for (const c of contents) {
      if (!c.isFromS3) continue;
      const eKey = isFilebase ? (c.cid || getStoredIpfsCid(c.Key) || c.s3Key || c.Key) : (c.s3Key || c.Key);
      if (eKey && countedKeys.has(eKey)) continue;
      if (eKey) countedKeys.add(eKey);
      uniqueTotalSize += (c.Size || 0);
    }
    state.r2TotalSize = uniqueTotalSize;
    updateStorageUsageUI();

    // 🔗 同一 CID 状態統合（CID State Unification） & 実体 Kubo 状態同期:
    // IPFSでは同一CID＝同一実体。同じCIDを持つ別名ファイル同士で Filebase保持状態・Kubo保持状態を完全同期
    if (contents.length > 0) {
      const cidStatusMap = new Map();
      for (const item of contents) {
        const c = item.contentCid || item.cid || getStoredIpfsCid(item.Key) || (item.s3Key ? getStoredIpfsCid(item.s3Key) : null);
        if (!c) continue;

        // Kuboがオンラインかつ実Pinリストが取得できている場合、実際のKubo実態を優先（手元表示を自動同期）
        if (actualKuboPinnedSet) {
          const reallyPinnedOnKubo = actualKuboPinnedSet.has(c);
          if (item.metadata) {
            item.metadata.kuboStatus = reallyPinnedOnKubo ? "pinned" : "not_pinned";
          }
        }

        const current = cidStatusMap.get(c) || { hasS3: false, isKuboPinned: false };
        if (item.isFromS3) current.hasS3 = true;
        if (item.metadata?.kuboStatus === "pinned") current.isKuboPinned = true;
        cidStatusMap.set(c, current);
      }

      // 同一CIDの全アイテムに統合ステータスを伝播
      for (const item of contents) {
        const c = item.contentCid || item.cid || getStoredIpfsCid(item.Key) || (item.s3Key ? getStoredIpfsCid(item.s3Key) : null);
        if (!c || !cidStatusMap.has(c)) continue;
        const unified = cidStatusMap.get(c);
        if (isFilebase) {
          item.isFromS3 = unified.hasS3;
        }
        if (!item.metadata) item.metadata = {};
        item.metadata.kuboStatus = unified.isKuboPinned ? "pinned" : "not_pinned";
      }
    }

    // 全件キャッシュとページネーションUI更新
    if (fetchGeneration !== storageFetchGeneration || activeStorageTab !== requestedProvider) return;
    storageCachedContents = contents;
    saveLedgerToLocalStorage(requestedProvider, contents);
    renderCurrentStoragePage();

    // 🌊 IPFS 漂流中ファイルの安否確認＆3ストライク自動整理（Filebase / R2 共通）
    auditDriftingFiles(contents);
  } catch (error) {
    if (fetchGeneration !== storageFetchGeneration || activeStorageTab !== requestedProvider) return;
    console.error("Storage fetch error:", error);
    r2FileList.innerHTML = `<span class="item-meta error" style="padding: 18px; color: var(--danger); display: block; text-align: center;">${escapeHtml(getStorageListLabels().connectionError)} ${escapeHtml(error.message)}</span>`;
  }
}

async function cleanupExpiredCivitaiTransferItems(expiredItems, allItems, s3, bucketName, provider) {
  const cleanedKeys = new Set();
  const targetProvider = normalizeDeliveryProvider(provider);
  const isFilebase = targetProvider === "filebase";

  for (const item of expiredItems) {
    const key = item.rawKey || item.Key;
    const s3Key = item.s3Key || item.Key;
    const cid = item.cid || item.metadata?.cid || item.metadata?.c || "";
    if (!key) continue;

    // 🛡️ ストレージ分離ガード: 現在開いているストレージ（provider）とアイテムの所属が不一致なら絶対にKV削除しない
    const itemProvider = item.storageProvider
      ? normalizeDeliveryProvider(item.storageProvider)
      : ((item.metadata?.backend === "r2" || item.metadata?.b === "r2" || cid === "r2") ? "r2" : "filebase");
    if (itemProvider !== targetProvider) {
      continue;
    }

    try {
      // Filebaseでは別名/CID共有中の実体を消さない。R2も同じキーを使う別リンクがあれば保守的に残す。
      const hasSibling = isFilebase && allItems.some(other => {
        const otherKey = other.rawKey || other.Key;
        if (otherKey === key) return false;
        return (s3Key && other.s3Key === s3Key) || (cid && other.cid === cid);
      });

      const thumbnailKey = getVideoThumbnailKey(s3Key);
      await deleteKvCid(key);
      if (!hasSibling && s3 && bucketName && s3Key && item.isFromS3) {
        if (thumbnailKey) await deleteKvCid(thumbnailKey);
        await safeDeleteS3Objects(s3, bucketName, [s3Key, thumbnailKey]);
      }
      clearCivitaiTemporaryTransfer(provider, s3Key);
      clearCivitaiTemporaryTransfer(provider, key);
      cleanedKeys.add(key);
    } catch (err) {
      console.warn("Civitai temporary transfer cleanup failed:", key, err);
    }
  }
  return cleanedKeys;
}

// ⏳ 有効期限切れストレージアイテムの安全な回収（最後のリンクなら S3 実体も削除）
async function cleanupExpiredStorageItems(expiredItems, allItems, s3, bucketName, provider) {
  const cleanedKeys = new Set();
  const targetProvider = normalizeDeliveryProvider(provider);
  const isFilebase = targetProvider === "filebase";

  for (const item of expiredItems) {
    const key = item.rawKey || item.Key;
    const s3Key = item.s3Key || item.Key;
    const cid = item.cid || item.metadata?.cid || item.metadata?.c || "";
    if (!key) continue;

    // 🛡️ ストレージ分離ガード: 現在開いているストレージ（provider）とアイテムの所属が不一致なら絶対にKV削除しない
    const itemProvider = item.storageProvider
      ? normalizeDeliveryProvider(item.storageProvider)
      : ((item.metadata?.backend === "r2" || item.metadata?.b === "r2" || cid === "r2") ? "r2" : "filebase");
    if (itemProvider !== targetProvider) {
      continue;
    }

    try {
      // Filebaseでは別名/CID共有中の実体を消さない。R2も同じキーを使う別リンクがあれば保守的に残す。
      const hasSibling = isFilebase && allItems.some(other => {
        const otherKey = other.rawKey || other.Key;
        if (otherKey === key) return false;
        return (s3Key && other.s3Key === s3Key) || (cid && other.cid === cid);
      });

      console.log(`⏳ 期限切れアイテムを回収: ${key} (別名リンク有無: ${hasSibling})`);
      const thumbnailKey = getVideoThumbnailKey(s3Key);
      await deleteKvCid(key);

      // 最後のリンク（hasSibling なし）なら、S3 実体およびサムネイルも削除
      if (!hasSibling && s3 && bucketName && s3Key && item.isFromS3) {
        if (thumbnailKey) await deleteKvCid(thumbnailKey);
        await safeDeleteS3Objects(s3, bucketName, [s3Key, thumbnailKey]);
        console.log(`🗑️ 最後のリンクが期限切れのため S3 実体も削除しました: ${s3Key}`);
      }
      cleanedKeys.add(key);
    } catch (err) {
      console.warn("Expired storage item cleanup failed:", key, err);
    }
  }
  return cleanedKeys;
}

// [INV-CORE-001] [INV-CORE-003] 画面表示時にR2ファイルを全ダウンロードして裏でCID計算・KV書き込み連打する
// 過剰自己修復コード（resolveR2CardCidAuto）は帯域・CPU・書き込み枠浪費防止のため完全撤去。


// 📄 現在のページに該当するストレージカード群をDOM描画
function renderCurrentStoragePage() {
  if (!r2FileList) return;
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  // 取得元が現在タブと一致するカードだけを描画する。非同期取得中の旧タブ
  // データや、旧バージョンがメモリに残した未分類データを表示しない。
  const visibleContents = storageCachedContents.filter(item => item.storageProvider === activeStorageTab);
  const totalItems = visibleContents.length;
  const labels = getStorageListLabels();

  updateStoragePaginationUI(totalItems);

  r2FileList.innerHTML = "";
  if (totalItems === 0) {
    r2FileList.innerHTML = `<span class="item-meta" style="padding: 18px; color: var(--muted); display: block; text-align: center;">${escapeHtml(dict.noFilesR2)}</span>`;
    return;
  }

  // 表示件数に合わせてスライス
  let pageItems = visibleContents;
  if (storagePerPage > 0) {
    const startIdx = (storageCurrentPage - 1) * storagePerPage;
    pageItems = visibleContents.slice(startIdx, startIdx + storagePerPage);
  }

  const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";

  pageItems.forEach(item => {
    const isFilebase = item.storageProvider === "filebase";
    const baseDomain = (getSelectedR2Domain(item.storageProvider) || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
    const article = document.createElement("article");
    article.className = "result-item";
    const ext = item.Key ? item.Key.split('.').pop().toLowerCase() : "";
    const isVideo = ["mp4", "webm", "ogv", "mov", "m4v"].includes(ext);
    const isImage = ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext);
    
    const rawCid = isFilebase
      ? (item.cid || getStoredIpfsCid(item.Key) || (item.s3Key ? getStoredIpfsCid(item.s3Key) : null))
      : (item.contentCid || item.cid || item.metadata?.contentCid || item.metadata?.c_cid || getStoredIpfsCid(item.Key) || (item.s3Key ? getStoredIpfsCid(item.s3Key) : null));
    const itemCid = isValidIpfsCid(rawCid) ? rawCid : null;

    const itemKey = item.rawKey || item.Key || "";
    const itemDisplayName = item.Key || "";

    article.dataset.key = itemKey;
    article.dataset.displayname = itemDisplayName;
    article.dataset.s3key = item.s3Key || itemDisplayName || itemKey;
    article.dataset.size = String(item.Size || 0);
    article.dataset.cid = itemCid || "";
    article.dataset.expiresat = item.expiresAt ? String(item.expiresAt) : "0";
    article.dataset.allowedhost = (item.metadata?.allowedHost || item.metadata?.d || "") || "";
    article.dataset.provider = item.storageProvider || (isFilebase ? "filebase" : "r2");

    // 🌐 このファイルカード専用の固定配信ドメイン（プルダウン切り替えで絶対に釣られない）
    const rawAllowedHost = item.metadata?.allowedHost || item.metadata?.d || "";
    const fileDomain = getFileStoredDomain(itemKey, itemDisplayName, rawAllowedHost).replace(/\/$/, "");
    article.dataset.allowedhost = fileDomain;

    // 公開・コピー用URLはストレージ種別やCIDの有無にかかわらず常に配信ドメイン + ファイル名。
    const publicUrl = getPublicDeliveryUrl(item.Key, isFilebase ? "filebase" : "r2", fileDomain);

    const hasPassword = Boolean(item.password || item.metadata?.passwordHash || item.metadata?.password);
    const plainPwd = item.password || item.metadata?.password;
    const pwdBadgeHtml = hasPassword
      ? `<span class="password-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.5); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;" title="${escapeHtml(labels.protected)}">🔒 ${plainPwd ? `${labels.passphrase} ${escapeHtml(plainPwd)}` : labels.protected}</span>`
      : "";

    let ttlBadgeHtml = "";
    if (item.expiresAt) {
      const msRemaining = Number(item.expiresAt) - Date.now();
      if (msRemaining <= 0) {
        ttlBadgeHtml = `<span style="background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.5); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;" title="${escapeHtml(labels.expires)}">⚠️ ${escapeHtml(labels.expires)}</span>`;
      } else {
        const totalSeconds = Math.max(1, Math.floor(msRemaining / 1000));
        let timeText = "";
        if (totalSeconds >= 86400) {
          // 1日以上: ◯日 ◯時間
          const days = Math.floor(totalSeconds / 86400);
          const remHours = Math.floor((totalSeconds % 86400) / 3600);
          timeText = `${days}${labels.day}${remHours > 0 ? " " + remHours + labels.hour : ""}`;
        } else if (totalSeconds >= 3600) {
          // 1時間以上 24時間未満: ◯時間
          const hours = Math.floor(totalSeconds / 3600);
          timeText = `${hours}${labels.hour}`;
        } else {
          // 1時間未満: 59分からカウントダウン（1分未満は1分）
          const minutes = Math.max(1, Math.floor(totalSeconds / 60));
          timeText = `${minutes}${labels.minute}`;
        }
        ttlBadgeHtml = `<span class="ttl-countdown-badge" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d; border: 1px solid rgba(245, 158, 11, 0.5); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;">⏳ ${escapeHtml(labels.remaining)} ${timeText}</span>`;
      }
    }

    let thumbHtml = "";
    if (hasPassword) {
      thumbHtml = `
        <div class="thumb format-badge" style="background: rgba(99, 102, 241, 0.12); color: #818cf8; border: 1px dashed rgba(99, 102, 241, 0.4); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;">
          <span style="font-size: 20px;">🔒</span>
          <span style="font-size: 9px; font-weight: 700; letter-spacing: 0.5px;">PROTECTED</span>
        </div>
      `;
    } else if (isImage) {
      const s3TargetKey = item.s3Key || item.Key || "";
      const s3Provider = isFilebase ? "filebase" : "r2";
      thumbHtml = `<img class="thumb" alt="" src="${escapeHtml(publicUrl)}" loading="lazy" onerror="this.onerror=null; if(window.loadFallbackImageFromS3){window.loadFallbackImageFromS3(this, '${escapeHtml(itemKey)}', '${escapeHtml(s3TargetKey)}', '${s3Provider}');}else{this.parentElement.innerHTML='<div class=\\'thumb format-badge\\'>${escapeHtml(ext.toUpperCase() || 'IMG')}</div>';}">`;
    } else if (isVideo) {
      // See: [INV-FRONT-001] (動画サムネイル描画のため preload="metadata" を必須とする。404事故防止はWorker側のINV-DELIVERY-001で担保)
      thumbHtml = `<video class="thumb" src="${escapeHtml(publicUrl)}#t=0.5" preload="metadata" muted playsinline style="object-fit: cover; pointer-events: none;"></video>`;
    } else {
      thumbHtml = `<div class="thumb format-badge">${escapeHtml(ext.toUpperCase() || "FILE")}</div>`;
    }

    const dateStr = item.LastModified ? new Date(item.LastModified).toLocaleDateString() : "";

    let storageTierHtml = "";
    let actionButtonsHtml = "";

    if (isFilebase) {
      const isFromS3 = Boolean(item.isFromS3);
      const isKuboPinned = item.metadata?.kuboStatus === "pinned";

      const fbBadgeHtml = isFromS3
        ? `<button type="button" class="unpin-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${labels.filebaseStored}</button>`
        : `<span style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; cursor: help;" title="${escapeHtml(labels.filebaseRemovedTooltip || "")}">${labels.filebaseRemoved}</span>`;

      let kuboBadgeHtml = "";
      if (!isKuboAutoPin) {
        kuboBadgeHtml = `<span class="kubo-badge-${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.08); color: #64748b; border: 1px dashed rgba(148,163,184,0.25); font-weight: 500; cursor: not-allowed; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboOff}</span>`;
      } else if (isKuboPinned) {
        kuboBadgeHtml = `<button type="button" class="kubo-unpin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboStored}</button>`;
      } else if (itemCid) {
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboMissing}</button>`;
      }

      let driftingBadgeHtml = "";
      const hasKuboRecord = isKuboPinned || item.metadata?.kuboStatus === "pinned" || item.kuboStatus === "pinned";
      if (!isFromS3 && !hasKuboRecord) {
        const driftCounts = getDriftFailCounts();
        const currentDriftCount = driftCounts[itemKey]?.count || 0;
        const driftText = currentDriftCount > 0
          ? labels.ipfsDriftingMiss.replace("{n}", currentDriftCount)
          : labels.ipfsDrifting;
        const driftBg = currentDriftCount > 0 ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)";
        const driftColor = currentDriftCount > 0 ? "#f87171" : "#fbbf24";
        const driftBorder = currentDriftCount > 0 ? "rgba(239, 68, 68, 0.4)" : "rgba(245, 158, 11, 0.4)";
        driftingBadgeHtml = `<span class="drifting-badge-${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: ${driftBg}; color: ${driftColor}; border: 1px solid ${driftBorder}; font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${driftText}</span>`;
      }

      storageTierHtml = `
        <div style="display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          ${fbBadgeHtml}
          ${kuboBadgeHtml}
          ${driftingBadgeHtml}
        </div>
      `;

      const r2CardDomainBadge = createCardDomainBadgeHtml(publicUrl, "r2-file-domain-badge");
      const r2CardTtlSelect = createCardTtlSelectHtml(item.expiresAt, "r2-file-ttl-select");
      actionButtonsHtml = `
        ${r2CardTtlSelect}
        ${r2CardDomainBadge}
        ${!hasPassword ? `<button type="button" class="ghost-button civitai-r2-post-btn" data-url="${escapeHtml(publicUrl)}" data-name="${escapeHtml(itemDisplayName)}" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4);" title="Civitai の投稿画面を開く">🎨 Civitai</button>` : ""}
        <button type="button" class="ghost-button danger-button delete-r2-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" data-origin="${isFromS3 ? '1' : '0'}">${labels.delete}</button>
      `;
    } else {
      const isFromS3 = Boolean(item.isFromS3);
      const isKuboPinned = item.metadata?.kuboStatus === "pinned";

      let r2BadgeHtml = "";
      if (isFromS3) {
        if (isKuboPinned) {
          // Kuboに保全済みなので、クリックして安全にR2実体を消去（容量解放）可能
          r2BadgeHtml = `<button type="button" class="unpin-r2-origin-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;" title="自宅Kuboに保全されているため、クリックしてR2実体を消去（容量解放）できます">${labels.r2Stored}</button>`;
        } else {
          // Kubo未保全のため、誤消去を防ぐ安全ロック（クリック不可）
          r2BadgeHtml = `<span style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(245,158,11,0.1); color: #f59e0b; border: 1px dashed rgba(245,158,11,0.3); font-weight: 500; cursor: not-allowed; display: inline-flex; align-items: center; gap: 3px;" title="${escapeHtml(labels.r2ProtectedTooltip)}">${labels.r2StoredProtected}</span>`;
        }
      } else {
        r2BadgeHtml = `<span style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; cursor: help;" title="R2実体は解放済みで、自宅Kuboから配信されます">${labels.r2Removed}</span>`;
      }

      let kuboBadgeHtml = "";
      if (!isKuboAutoPin) {
        kuboBadgeHtml = `<span class="kubo-badge-${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.08); color: #64748b; border: 1px dashed rgba(148,163,184,0.25); font-weight: 500; cursor: not-allowed; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboOff}</span>`;
      } else if (isKuboPinned) {
        kuboBadgeHtml = `<button type="button" class="kubo-unpin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboStored}</button>`;
      } else if (itemCid) {
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-provider="r2" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboMissing}</button>`;
      } else {
        kuboBadgeHtml = `<span class="r2-kubo-badge-placeholder kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.08); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.25); display: inline-flex; align-items: center; gap: 3px;">⏳ CID確認中...</span>`;
      }

      let r2DriftingBadgeHtml = "";
      const hasR2KuboRecord = isKuboPinned || item.metadata?.kuboStatus === "pinned" || item.kuboStatus === "pinned";
      if (!isFromS3 && !hasR2KuboRecord) {
        const driftCounts = getDriftFailCounts();
        const currentDriftCount = driftCounts[itemKey]?.count || 0;
        const driftText = currentDriftCount > 0
          ? labels.ipfsDriftingMiss.replace("{n}", currentDriftCount)
          : labels.ipfsDrifting;
        const driftBg = currentDriftCount > 0 ? "rgba(239, 68, 68, 0.15)" : "rgba(245, 158, 11, 0.15)";
        const driftColor = currentDriftCount > 0 ? "#f87171" : "#fbbf24";
        const driftBorder = currentDriftCount > 0 ? "rgba(239, 68, 68, 0.4)" : "rgba(245, 158, 11, 0.4)";
        r2DriftingBadgeHtml = `<span class="drifting-badge-${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: ${driftBg}; color: ${driftColor}; border: 1px solid ${driftBorder}; font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${driftText}</span>`;
      }

      storageTierHtml = `
        <div style="display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          ${r2BadgeHtml}
          ${kuboBadgeHtml}
          ${r2DriftingBadgeHtml}
        </div>
      `;

      const r2CardDomainBadge = createCardDomainBadgeHtml(publicUrl, "r2-file-domain-badge");
      const r2CardTtlSelect = createCardTtlSelectHtml(item.expiresAt, "r2-file-ttl-select");
      actionButtonsHtml = `
        ${r2CardTtlSelect}
        ${r2CardDomainBadge}
        ${!hasPassword ? `<button type="button" class="ghost-button civitai-r2-post-btn" data-url="${escapeHtml(publicUrl)}" data-name="${escapeHtml(itemDisplayName)}" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4);" title="Civitai の投稿画面を開く">🎨 Civitai</button>` : ""}
        <button type="button" class="ghost-button danger-button delete-r2-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" data-origin="${item.isFromS3 ? '1' : '0'}">${escapeHtml(dict.deleteNow)}</button>
      `;
    }

    const renameBtnHtml = `<button type="button" class="rename-file-btn" data-key="${escapeHtml(itemKey)}" data-displayname="${escapeHtml(itemDisplayName)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-size="${item.Size || 0}" data-cid="${escapeHtml(itemCid || "r2")}" title="${escapeHtml(labels.rename)}" style="background: none; border: none; cursor: pointer; padding: 2px 4px; font-size: 14px; opacity: 0.8; transition: opacity 0.15s; line-height: 1;">✏️</button>`;

    let cidBadgeHtml = "";
    if (itemCid) {
      const shortCid = itemCid.length > 12 ? `${itemCid.slice(0, 6)}...${itemCid.slice(-4)}` : itemCid;
      const indexerUrl = `https://cid.contact/cid/${encodeURIComponent(itemCid)}`;
      cidBadgeHtml = `
        <div style="display: inline-flex; align-items: center; gap: 3px;">
          <button type="button" class="copy-cid-btn" data-cid="${escapeHtml(itemCid)}" style="cursor: pointer; font-size: 10px; font-family: monospace; padding: 1px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); line-height: 1.4;" title="IPFS CID: ${escapeHtml(itemCid)} (クリックでコピー)">📦 ${escapeHtml(shortCid)} 📋</button>
          <a href="${escapeHtml(indexerUrl)}" target="_blank" rel="noopener noreferrer" style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(148, 163, 184, 0.1); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25); text-decoration: none; display: inline-flex; align-items: center; gap: 2px; line-height: 1.4;">${labels.nodeCheck}</a>
        </div>
      `;
    } else if (!isFilebase) {
      cidBadgeHtml = `
        <div class="r2-cid-badge-placeholder" data-key="${escapeHtml(itemKey)}" style="display: inline-flex; align-items: center; gap: 3px;">
          <span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.08); color: #38bdf8; border: 1px dashed rgba(56, 189, 248, 0.25); line-height: 1.4;">📦 CID計算中...</span>
        </div>
      `;
    }

    article.innerHTML = `
      <input type="checkbox" class="r2-file-checkbox" data-key="${escapeHtml(itemKey)}" style="width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent); align-self: center; margin-right: 4px;">
      <a href="${escapeHtml(publicUrl)}" target="_blank" rel="noopener noreferrer" class="thumb-link" title="別タブで開く">
        ${thumbHtml}
      </a>
      <div class="item-details-col" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px;">
        <!-- 上段: ファイル名 ＆ 容量・日時 -->
        <div class="item-details-row1" style="display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap;">
          <div class="item-name-group" style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span class="item-name" style="font-weight: 600; word-break: break-all;">${escapeHtml(itemDisplayName)}</span>
            ${renameBtnHtml}
            <span class="r2-wf-badge-placeholder" data-key="${escapeHtml(itemKey)}"></span>
            ${pwdBadgeHtml}
          </div>
          <div class="item-meta item-basic-meta" style="color: var(--muted); font-size: 11px; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span style="color: #94a3b8; font-weight: 600;">${formatBytes(item.Size || 0)}</span>
            <span style="opacity: 0.5;">•</span>
            <span>${escapeHtml(labels.updated)} ${escapeHtml(dateStr)}</span>
            ${ttlBadgeHtml ? `<span style="opacity: 0.5;">•</span>${ttlBadgeHtml}` : ""}
          </div>
        </div>
        <!-- 下段: 保管ステータス (FB/Kubo) ＆ CID・ノード確認 -->
        <div class="item-details-row2" style="display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap;">
          ${storageTierHtml ? `<div class="item-storage-tier" style="display: inline-flex;">${storageTierHtml}</div>` : ""}
          ${cidBadgeHtml ? `<div class="item-cid-group" style="display: inline-flex;">${cidBadgeHtml}</div>` : ""}
        </div>
      </div>
      <div class="result-actions" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        ${actionButtonsHtml}
      </div>
    `;

    r2FileList.append(article);

    checkRemoteFileWf(item.Key, publicUrl).then(hasWf => {
      if (hasWf) {
        const placeholder = article.querySelector('.r2-wf-badge-placeholder');
        if (placeholder) {
          placeholder.innerHTML = `<span class="meta-badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10px; padding: 1px 5px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 2px;" title="${escapeHtml(labels.workflow)}">🧬 WF</span>`;
        }
      }
    });

    // 🪐 画像・サムネイルが 404 / 読み込み失敗した際、S3 から直接 Blob を取得して確実に即座表示するフォールバック
    if (isImage) {
      const thumbImg = article.querySelector("img.thumb");
      if (thumbImg) {
        thumbImg.addEventListener("error", async function onThumbError() {
          this.removeEventListener("error", onThumbError);
          try {
            const provider = isFilebase ? "filebase" : "r2";
            const s3 = getS3Client(provider);
            const bucket = getBucketName(provider);
            const s3Key = item.s3Key || item.Key;
            if (s3 && bucket && s3Key) {
              const res = await s3.send(new GetObjectCommand({
                Bucket: bucket,
                Key: s3Key,
              }));
              if (res && res.Body) {
                const blob = res.Body instanceof Blob ? res.Body : new Blob([await res.Body.transformToByteArray()]);
                const objUrl = URL.createObjectURL(blob);
                this.src = objUrl;
                return;
              }
            }
          } catch (e) {
            // S3 直接取得も失敗した場合はバッジ表示
          }
          if (this.parentElement) {
            this.parentElement.innerHTML = `<div class="thumb format-badge">${escapeHtml(ext.toUpperCase() || 'IMG')}</div>`;
          }
        }, { once: true });
      }
    }


    // 🪐 Filebase かつ CID が未取得のアイテムについて、バックグラウンドで S3 から CID を自動解決して即時反映
    if (isFilebase && !itemCid && item.isFromS3) {
      (async () => {
        try {
          const s3 = getS3Client("filebase");
          const bucket = getBucketName("filebase");
          const s3TargetKey = item.s3Key || item.Key;
          if (s3 && bucket && s3TargetKey) {
            const headOutput = await s3.send(new HeadObjectCommand({
              Bucket: bucket,
              Key: s3TargetKey,
            }));
            const hHeaders = headOutput?.$metadata?.httpHeaders || {};
            const rawCid = hHeaders["x-amz-meta-cid"] ||
                           hHeaders["x-amz-meta-ipfs-hash"] ||
                           headOutput?.Metadata?.cid ||
                           headOutput?.Metadata?.["ipfs-hash"];
            const resolvedCid = isValidIpfsCid(rawCid) ? rawCid.trim() : null;
            if (resolvedCid) {
              storeIpfsCid(itemKey, resolvedCid);
              storeIpfsCid(itemDisplayName, resolvedCid);
              storeIpfsCid(s3TargetKey, resolvedCid);
              item.cid = resolvedCid;
              article.dataset.cid = resolvedCid;

              // CID解決後も公開URLはカード固有の固定配信ドメインを確実に維持する。
              const targetDomain = fileDomain || (rawAllowedHost ? (rawAllowedHost.startsWith("http") ? rawAllowedHost : `https://${rawAllowedHost}`) : baseDomain);
              const newPublicUrl = getPublicDeliveryUrl(item.Key, "filebase", targetDomain);

              const thumbImg = article.querySelector("img.thumb");
              if (thumbImg) thumbImg.src = newPublicUrl;
              const thumbLink = article.querySelector("a.thumb-link");
              if (thumbLink) thumbLink.href = newPublicUrl;

              // コピー用 URL を最新化
              const domainBtn = article.querySelector(".copy-card-url-btn");
              if (domainBtn) {
                domainBtn.dataset.url = newPublicUrl;
                domainBtn.title = `クリックして配信URLをコピー: ${newPublicUrl}`;
              }

              // CID バッジを動的挿入（新レイアウト item-cid-group / item-details-row2 に対応）
              if (!article.querySelector(".copy-cid-btn")) {
                const shortCid = resolvedCid.length > 12 ? `${resolvedCid.slice(0, 6)}...${resolvedCid.slice(-4)}` : resolvedCid;
                const badgeWrap = document.createElement("div");
                badgeWrap.className = "item-cid-group";
                badgeWrap.style.cssText = "display: inline-flex; align-items: center; gap: 3px;";
                badgeWrap.innerHTML = `
                  <button type="button" class="copy-cid-btn" data-cid="${escapeHtml(resolvedCid)}" style="cursor: pointer; font-size: 10px; font-family: monospace; padding: 1px 6px; border-radius: 4px; background: rgba(56, 189, 248, 0.1); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); line-height: 1.4;" title="IPFS CID: ${escapeHtml(resolvedCid)} (クリックでコピー)">📦 ${escapeHtml(shortCid)} 📋</button>
                  <a href="https://cid.contact/cid/${encodeURIComponent(resolvedCid)}" target="_blank" rel="noopener noreferrer" style="font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(148, 163, 184, 0.1); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.25); text-decoration: none; display: inline-flex; align-items: center; gap: 2px; line-height: 1.4;" title="CID.contact でノード確認">🌐 ノード確認 ↗</a>
                `;
                const row2 = article.querySelector(".item-details-row2");
                if (row2) {
                  row2.appendChild(badgeWrap);
                } else {
                  const nameRow = article.querySelector(".item-name-group") || article.querySelector(".item-name-row");
                  if (nameRow) nameRow.appendChild(badgeWrap);
                }
              }
              // [INV-CORE-001] [INV-CORE-003] カード描画時に勝手に registerKvCid() を連打して
              // 書き込み枠を浪費する処理を排除。ローカル台帳/キャッシュの更新のみで安全に完結させる。
            }
          }
        } catch (resolveErr) {
          // ignore background lookup error
        }
      })();
    }
  });

  updateSelectedR2ActionButtonsState();
}

// --- 🌊 IPFS漂流ファイル（全アンピン）安否監査＆3ストライク自動整理ユーティリティ ---
const DRIFT_STORAGE_KEY = "cividge_drift_fail_counts";
const DRIFT_FAIL_COOLDOWN_MS = 60 * 60 * 1000; // 1時間（連打防止クールダウン）

function getDriftFailCounts() {
  try {
    return JSON.parse(localStorage.getItem(DRIFT_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function recordDriftCheckResult(rawKey, isAlive) {
  const counts = getDriftFailCounts();
  const now = Date.now();

  if (isAlive) {
    // 【生存確認】エッジやIPFSから取得できたため、失敗カウントを完全リセット
    if (counts[rawKey]) {
      delete counts[rawKey];
      localStorage.setItem(DRIFT_STORAGE_KEY, JSON.stringify(counts));
    }
    return { shouldDelete: false, count: 0 };
  }

  // 【失敗時】前回の失敗から1時間未満ならカウント加算をスキップ（連打ガード）
  const entry = counts[rawKey] || { count: 0, lastChecked: 0 };
  if (now - entry.lastChecked < DRIFT_FAIL_COOLDOWN_MS && entry.count > 0) {
    return { shouldDelete: false, count: entry.count, skipped: true };
  }

  entry.count += 1;
  entry.lastChecked = now;
  counts[rawKey] = entry;
  localStorage.setItem(DRIFT_STORAGE_KEY, JSON.stringify(counts));

  // 3回連続失敗 ➔ ゾンビ化確定（KV削除対象）
  if (entry.count >= 3) {
    delete counts[rawKey];
    localStorage.setItem(DRIFT_STORAGE_KEY, JSON.stringify(counts));
    return { shouldDelete: true, count: 3 };
  }

  return { shouldDelete: false, count: entry.count };
}

/**
 * 実体データをダウンロードせず、HTTP HEAD で軽量に安否確認 (4秒タイムアウト)
 * [INV-CORE-001] cache: "no-store" を外し、エッジキャッシュを優先照会（エッジ生存中はKV消費0回）
 */
async function checkDriftSurvival(url) {
  if (!url) return false;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    return res.ok || res.status === 206 || res.status === 304;
  } catch (e) {
    return false;
  }
}

/**
 * 漂流ファイル（Filebase/R2なし ＋ Kuboなし）を順次安否確認
 */
async function auditDriftingFiles(contents) {
  if (!contents || contents.length === 0) return;

  // 漂流ファイルのみを抽出（S3実体なし ＋ Kubo実体なし）
  const driftingItems = contents.filter(item => {
    const isFromS3 = Boolean(item.isFromS3);
    const hasKuboRecord = item.isKuboPinned || item.metadata?.kuboStatus === "pinned" || item.kuboStatus === "pinned";
    return !isFromS3 && !hasKuboRecord;
  });

  if (driftingItems.length === 0) return;

  const labels = getStorageListLabels();
  const now = Date.now();

  for (const item of driftingItems) {
    const rawKey = item.rawKey || item.Key;
    const publicUrl = item.publicUrl || item.proxyUrl;
    if (!rawKey || !publicUrl) continue;

    // 🛡️ クールダウン先行ガード: 前回失敗から1時間以内なら HEAD 通信自体を完全にスキップ（通信無駄打ちゼロ）
    const counts = getDriftFailCounts();
    const entry = counts[rawKey];
    if (entry && entry.count > 0 && (now - entry.lastChecked < DRIFT_FAIL_COOLDOWN_MS)) {
      continue;
    }

    const isAlive = await checkDriftSurvival(publicUrl);
    const result = recordDriftCheckResult(rawKey, isAlive);

    const elem = r2FileList?.querySelector(`.result-item[data-key="${CSS.escape(rawKey)}"]`);
    const badge = elem?.querySelector(`.drifting-badge-${CSS.escape(rawKey)}`);

    if (result.shouldDelete) {
      console.warn(`💀 漂流ファイルが3回連続で見つからないためKV台帳から自動整理: ${rawKey}`);
      try {
        await deleteKvCid(rawKey);
        if (elem) {
          elem.style.transition = "opacity 0.4s ease, transform 0.4s ease";
          elem.style.opacity = "0";
          elem.style.transform = "scale(0.95)";
          setTimeout(() => {
            elem.remove();
            if (r2FileList.querySelectorAll(".result-item").length === 0) {
              const lang = getAppLanguage();
              const dict = i18nDict[lang] || i18nDict.ja;
              r2FileList.innerHTML = `<span class="item-meta" style="padding: 18px; color: var(--muted); display: block; text-align: center;">${escapeHtml(dict.noFilesR2)}</span>`;
            }
          }, 400);
        }
      } catch (err) {
        console.warn("Auto drift cleanup error:", err);
      }
    } else if (isAlive) {
      if (badge) {
        badge.textContent = labels.ipfsDriftingAlive;
        badge.style.background = "rgba(56, 189, 248, 0.15)";
        badge.style.color = "#38bdf8";
        badge.style.border = "1px solid rgba(56, 189, 248, 0.4)";
      }
    } else {
      if (badge) {
        badge.textContent = labels.ipfsDriftingMiss.replace("{n}", result.count);
        badge.style.background = "rgba(239, 68, 68, 0.15)";
        badge.style.color = "#f87171";
        badge.style.border = "1px solid rgba(239, 68, 68, 0.4)";
      }
    }
  }
}

// ストレージファイル操作イベント委譲
r2FileList?.addEventListener("click", async (e) => {
  const target = e.target;
  const isFilebase = activeStorageTab === "filebase";
  const s3 = getS3Client(activeStorageTab);
  const bucketName = getBucketName(activeStorageTab);

  // 📋 配信ドメインバッジ（＋の左）クリックで直接クリップボードにコピー
  if (target.classList.contains("copy-card-url-btn") || target.closest(".copy-card-url-btn")) {
    const btn = target.classList.contains("copy-card-url-btn") ? target : target.closest(".copy-card-url-btn");
    const url = btn?.dataset?.url;
    if (url) {
      await copyToClipboard(url);
      const origHtml = btn.innerHTML;
      btn.innerHTML = "📋 コピー完了！";
      btn.style.color = "#34d399";
      btn.style.borderColor = "#34d399";
      setTimeout(() => {
        btn.innerHTML = origHtml;
        btn.style.color = "";
        btn.style.borderColor = "";
      }, 1400);
    }
    return;
  }

  // 🪐 ファイル名（URL）変更（インライン編集: byoc スタイル）
  if (target.classList.contains("rename-file-btn") || target.closest(".rename-file-btn")) {
    const btn = target.classList.contains("rename-file-btn") ? target : target.closest(".rename-file-btn");
    const oldKey = btn.dataset.key;
    if (!oldKey) return;

    const row = btn.closest(".item-name-row");
    if (!row) return;

    const article = btn.closest(".result-item");
    const originalS3Key = btn.dataset.s3key || article?.dataset?.s3key || oldKey;
    // oldKey は KV の内部キーで、ドメイン別レコードでは
    // "hostname:filename.ext" になる。編集欄には公開ファイル名だけを使う。
    const displayName = btn.dataset.displayname || article?.dataset?.displayname ||
      (oldKey.includes(":") ? oldKey.split(":").slice(1).join(":") : oldKey);

    const lastDotIndex = displayName.lastIndexOf(".");
    const baseName = lastDotIndex > 0 ? displayName.substring(0, lastDotIndex) : displayName;
    const ext = lastDotIndex > 0 ? displayName.substring(lastDotIndex) : "";

    const originalHtml = row.innerHTML;

    row.innerHTML = `
      <div class="rename-inline-form" style="display: flex; align-items: center; gap: 6px; flex: 1; flex-wrap: wrap;">
        <input type="text" class="rename-input" value="${escapeHtml(baseName)}" style="flex: 1; min-width: 120px; height: 28px; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,0.4); color: var(--text); padding: 0 8px; font-size: 12px; outline: none;">
        <span class="rename-ext" style="font-size: 12px; color: var(--muted); font-weight: bold;">${escapeHtml(ext)}</span>
        <button type="button" class="primary-button rename-save-btn" data-key="${escapeHtml(oldKey)}" style="min-height: 28px; padding: 0 10px; font-size: 11.5px; font-weight: bold;">保存</button>
        <button type="button" class="ghost-button rename-cancel-btn" style="min-height: 28px; padding: 0 10px; font-size: 11.5px;">戻る</button>
      </div>
    `;

    const input = row.querySelector(".rename-input");
    const saveBtn = row.querySelector(".rename-save-btn");
    const cancelBtn = row.querySelector(".rename-cancel-btn");

    if (input) {
      input.focus();
      input.select();

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBtn?.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelBtn?.click();
        }
      });
    }

    cancelBtn?.addEventListener("click", () => {
      row.innerHTML = originalHtml;
    });

    saveBtn?.addEventListener("click", async () => {
      const newBaseName = input?.value?.trim()?.replace(/[\\/:*?"<>|]/g, "-");
      if (!newBaseName || newBaseName === baseName) {
        row.innerHTML = originalHtml;
        return;
      }

      const newKey = ext ? `${newBaseName}${ext}` : newBaseName;

      const isFilebase = activeStorageTab === "filebase";
      const currentSize = parseInt(btn.dataset.size || article?.dataset?.size || "0", 10);
      let cid = btn.dataset.cid || article?.dataset?.cid || getStoredIpfsCid(oldKey) || getStoredIpfsCid(originalS3Key);
      if (!isFilebase && (!cid || cid === "")) {
        cid = "r2";
      }
      let size = currentSize;
      let mime = "";

      let existingKvFiles = [];
      try {
        existingKvFiles = await fetchKvFiles();
        const currentKv = existingKvFiles.find(f => f.name === oldKey || f.name.endsWith(`:${oldKey}`));
        if (currentKv) {
          if (!cid) cid = currentKv.metadata?.cid;
          if (!size) size = currentKv.metadata?.size || 0;
          mime = currentKv.metadata?.mime || "";
        }
      } catch (err) {
        console.warn("KV fetch error during rename:", err);
      }

      if (isFilebase && !cid) {
        alert("⚠️ このファイルの CID が見つからないためリネームできません。");
        row.innerHTML = originalHtml;
        return;
      }
      if (!isFilebase && !cid) {
        cid = "r2";
      }

      // ドメインプレフィックス付きキー（例: testunko.pages.dev:file.png）の場合、プレフィックスを維持
      let targetNewKey = newKey;
      if (oldKey && oldKey.includes(":")) {
        const colonIdx = oldKey.indexOf(":");
        const prefix = oldKey.substring(0, colonIdx + 1);
        targetNewKey = `${prefix}${newKey}`;
      }

      // 🛡️ 同名ファイル存在チェック:
      // 変更先 targetNewKey が既に存在し、かつ実体が異なる場合は上書き破壊を防ぐため中断
      const conflictingFile = existingKvFiles.find(f => f.name === targetNewKey);
      if (conflictingFile) {
        const targetCid = conflictingFile.metadata?.cid || conflictingFile.metadata?.c;
        const targetS3 = conflictingFile.metadata?.s3Key || conflictingFile.metadata?.k_s3;
        const isSameEntity = isFilebase
          ? (targetCid && targetCid === cid)
          : (targetS3 && targetS3 === originalS3Key);
        if (!isSameEntity) {
          alert(`⚠️ 同名の別ファイル「${newKey}」が既に存在します。\n別のファイル名を指定してください。`);
          row.innerHTML = originalHtml;
          return;
        }
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "...";

      try {
        // 1. 新キーで登録（実体 S3 キー名 originalS3Key を引き継ぐ）
        // unpinned / kuboStatus などの状態もそのまま継承
        let unpinned = false;
        let kuboStatus = null;
        let ttl = 0;
        let expiresAt = null;
        let password = "";
        // 🌐 元カードのDOM設定（allowedHost, expiresAt）をまず最優先で取得
        const domAllowedHost = article?.dataset?.allowedhost || null;
        const domExpiresAt = Number(article?.dataset?.expiresat || 0) || null;
        let allowedHost = domAllowedHost;
        if (domExpiresAt && domExpiresAt > Date.now()) {
          expiresAt = domExpiresAt;
          ttl = Math.round((domExpiresAt - Date.now()) / 1000);
        }

        try {
          const kvFiles = await fetchKvFiles();
          const currentKv = kvFiles.find(f => f.name === oldKey || f.name.endsWith(`:${oldKey}`));
          if (currentKv && currentKv.metadata) {
            unpinned = Boolean(currentKv.metadata.unpinned);
            kuboStatus = currentKv.metadata.kuboStatus || null;
            if (!expiresAt) {
              ttl = currentKv.metadata.ttl || 0;
              expiresAt = currentKv.metadata.expiresAt || null;
            }
            password = currentKv.metadata.password || "";
            if (!allowedHost) {
              allowedHost = currentKv.metadata.allowedHost || currentKv.metadata.d || null;
            }
          }
        } catch (e) {
          console.warn("fetchKvFiles error during metadata fallback:", e);
        }

        const targetCid = isFilebase ? cid : "r2";
        await registerKvCid(
          targetNewKey, targetCid, size, mime, originalS3Key, password, null, ttl, expiresAt,
          unpinned, kuboStatus, allowedHost, false, getVideoThumbnailKey(originalS3Key)
        );

        if (isFilebase) {
          storeIpfsCid(targetNewKey, cid);
          storeIpfsCid(originalS3Key, cid);
          storeIpfsCid(oldKey, cid);

          try {
            const map = JSON.parse(localStorage.getItem("ipfsCidMap") || "{}");
            map[originalS3Key] = cid;
            map[oldKey] = cid;
            map[targetNewKey] = cid;
            localStorage.setItem("ipfsCidMap", JSON.stringify(map));
          } catch (e) {}
        }

        if (allowedHost) {
          setFileStoredDomain(targetNewKey, allowedHost);
        }

        // 2. 以前の名前のリンクも維持（即404化させず、実体共通エイリアスとして永続両立）
        // ※ deleteKvCid(oldKey) は実行せず、古いURLを踏んだ人も引き続き閲覧可能にする

        await fetchAndRenderR2Files();
      } catch (err) {
        console.error("Rename failed:", err);
        alert(`❌ リネームに失敗しました: ${err.message}`);
        row.innerHTML = originalHtml;
      }
    });

    return;
  }

  if (target.classList.contains("civitai-r2-post-btn")) {
    const url = target.dataset.url;
    const name = target.dataset.name;
    openCivitaiIntent(url, name);
    return;
  }

  // 🌐 配信ドメイン追加（＋ボタン）: 同一CID・同一ファイル名で別ドメイン用のKV配信カードを作成
  if (target.classList.contains("add-domain-alias-btn") || target.closest(".add-domain-alias-btn")) {
    const btn = target.classList.contains("add-domain-alias-btn") ? target : target.closest(".add-domain-alias-btn");
    const article = btn.closest(".result-item");
    const oldKey = article?.dataset?.key;
    const displayName = article?.dataset?.displayname || (oldKey && oldKey.includes(":") ? oldKey.split(":").slice(1).join(":") : oldKey);
    const s3Key = article?.dataset?.s3key || displayName || oldKey;
    const cid = article?.dataset?.cid || "";
    const size = Number(article?.dataset?.size || 0);
    const itemProvider = article?.dataset?.provider || activeStorageTab;
    const isFilebase = itemProvider === "filebase";
    const currentDomain = (article?.dataset?.allowedhost || "").replace(/^https?:\/\//, "").replace(/\/$/, "").split(":")[0];

    const availableDomains = getR2DomainList(itemProvider).filter(d => {
      const clean = d.replace(/^https?:\/\//, "").replace(/\/$/, "").split(":")[0];
      return clean.toLowerCase() !== currentDomain.toLowerCase();
    });

    if (availableDomains.length === 0) {
      await showCustomAlert("追加可能な他の配信ドメインが設定されていません。\nクラウドストレージ接続設定から配信ドメインを追加してください。", "ℹ️ ドメイン追加");
      return;
    }

    const modal = document.getElementById("aliasCreateModal");
    const filenameInput = document.getElementById("aliasTargetFilenameInput");
    const domainSelect = document.getElementById("aliasTargetDomainSelect");
    const cancelBtn = document.getElementById("cancelAliasBtn");
    const submitBtn = document.getElementById("submitAliasBtn");

    if (!modal || !domainSelect || !submitBtn) return;

    filenameInput.value = displayName;
    domainSelect.innerHTML = "";
    availableDomains.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      let icon = "🌐 ";
      if (d.includes(".pages.dev")) icon = "⚡ ";
      else if (d.includes(".r2.dev")) icon = "📦 ";
      opt.textContent = `${icon}${d}`;
      domainSelect.appendChild(opt);
    });

    // モーダルを完全に画面中央に表示
    modal.style.display = "flex";

    const closeModal = () => {
      modal.style.display = "none";
      submitBtn.onclick = null;
      cancelBtn.onclick = null;
    };

    cancelBtn.onclick = () => closeModal();

    submitBtn.onclick = async () => {
      const targetDomainUrl = domainSelect.value;
      if (!targetDomainUrl) return;

      const cleanHost = targetDomainUrl.replace(/^https?:\/\//, "").replace(/\/$/, "").split(":")[0];
      const newDomainKey = `${cleanHost}:${displayName}`;

      submitBtn.disabled = true;
      submitBtn.textContent = "作成中...";

      try {
        let unpinned = false;
        let kuboStatus = null;
        let ttl = 0;
        let expiresAt = null;
        let password = "";

        const domExpiresAt = Number(article?.dataset?.expiresat || 0) || null;
        if (domExpiresAt && domExpiresAt > Date.now()) {
          expiresAt = domExpiresAt;
          ttl = Math.round((domExpiresAt - Date.now()) / 1000);
        }

        try {
          const kvFiles = await fetchKvFiles();
          const currentKv = kvFiles.find(f => f.name === oldKey || f.name.endsWith(`:${oldKey}`));
          if (currentKv && currentKv.metadata) {
            unpinned = Boolean(currentKv.metadata.unpinned);
            kuboStatus = currentKv.metadata.kuboStatus || null;
            if (!expiresAt) {
              ttl = currentKv.metadata.ttl || 0;
              expiresAt = currentKv.metadata.expiresAt || null;
            }
            password = currentKv.metadata.password || "";
          }
        } catch (e) {}

        const resolvedCid = cid || getStoredIpfsCid(oldKey) || getStoredIpfsCid(displayName) || getStoredIpfsCid(s3Key) || "";
        const targetCid = isFilebase ? (resolvedCid || cid) : "r2";
        const targetBackend = isFilebase ? "filebase" : "r2";

        await registerKvCid(
          newDomainKey,
          targetCid,
          size,
          "",
          s3Key,
          password,
          null,
          ttl,
          expiresAt,
          unpinned,
          kuboStatus,
          cleanHost,
          true, // overwriteAllowedHost: この新ドメインのみ許可
          getVideoThumbnailKey(s3Key),
          null,
          null,
          undefined,
          resolvedCid || null, // contentCid
          targetBackend // backend: [INV-FRONT-005] 帰属ストレージの完全固定
        );

        if (resolvedCid) {
          storeIpfsCid(newDomainKey, resolvedCid);
        }
        setFileStoredDomain(newDomainKey, targetDomainUrl);

        // 新URLのウォームアップ
        const newUrl = `${targetDomainUrl.replace(/\/$/, "")}/${encodeURIComponent(displayName)}`;
        fetch(newUrl, { method: "HEAD", mode: "no-cors" }).catch(() => {});

        closeModal();
        await fetchAndRenderR2Files();
      } catch (err) {
        console.error("Failed to add domain alias:", err);
        alert(`❌ ドメイン追加に失敗しました: ${err.message}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "エイリアス作成";
      }
    };
    return;
  }



  // 📋 小型 CID コピーボタン
  if (target.classList.contains("copy-cid-btn")) {
    const cid = target.dataset.cid;
    if (cid) {
      await copyToClipboard(cid, target, "📋 コピー完了");
    }
    return;
  }

  // 🏠 自宅 Kubo からの Pin 解除ボタン（Tailscale / ローカル連携時）
  if (target.classList.contains("kubo-unpin-manual-btn")) {
    const key = target.dataset.key;
    const cid = target.dataset.cid;
    if (!cid) return;

    const endpoint = getKuboRpcEndpoint();
    const isLocal = endpoint.includes("127.0.0.1") || endpoint.includes("localhost");
    const isTailscale = endpoint.includes(".ts.net") || endpoint.startsWith("https://");
    if (!isLocal && !isTailscale && !endpoint.startsWith("http://")) {
      await showCustomAlert("Kuboノードへの接続エンドポイントが設定されていません。\n\n設定画面からKubo RPCエンドポイント（http://127.0.0.1:5001等）を設定してください。", "⚠️ 未接続");
      return;
    }

    const ok = await showCustomConfirm(
      `自宅Kuboノードから '${key}' のPinを解除しますか？\n\n（Filebase上の保存状態やIPFS配信には影響しません）`,
      "🏠 Kubo Pin解除の確認"
    );
    if (!ok) return;

    target.disabled = true;
    const origText = target.textContent;
    target.textContent = "解除中...";

    try {
      const res = await unpinFromKubo(cid);
      if (res.success) {
        const kvData = await fetchKvRecord(key);
        if (kvData) {
          const meta = kvData.metadata || {};
          const isR2 = meta.backend === "r2" || meta.b === "r2" || kvData.value === "r2" || activeStorageTab === "r2";
          await registerKvCid(
            key,
            isR2 ? "r2" : cid,
            meta.size || 0,
            meta.mime || "",
            meta.s3Key || key,
            "",
            null,
            meta.ttl || 0,
            meta.expiresAt || null,
            Boolean(meta.unpinned),
            "not_pinned",
            meta.allowedHost || null,
            false,
            meta.thumbnailKey || null,
            meta.width || null,
            meta.height || null,
            Boolean(meta.civitaiTemporary),
            meta.contentCid || meta.c_cid || (isR2 ? cid : null),
            isR2 ? "r2" : null
          );
        }
        await fetchAndRenderR2Files();
      } else {
        await showCustomAlert(`Kubo Pin解除に失敗しました: ${res.error}`, "❌ エラー");
        target.disabled = false;
        target.textContent = origText;
      }
    } catch (err) {
      await showCustomAlert(`エラー: ${err.message}`, "❌ エラー");
      target.disabled = false;
      target.textContent = origText;
    }
    return;
  }

  // 🏠 自宅 Kubo への Pin 再実行ボタン（Tailscale / ローカル連携時）
  if (target.classList.contains("kubo-pin-manual-btn")) {
    const key = target.dataset.key;
    const cid = target.dataset.cid;
    const provider = target.dataset.provider || activeStorageTab;
    if (!cid && provider !== "r2") return;

    const endpoint = getKuboRpcEndpoint();
    const isLocal = endpoint.includes("127.0.0.1") || endpoint.includes("localhost");
    const isTailscale = endpoint.includes(".ts.net") || endpoint.startsWith("https://");
    if (!isLocal && !isTailscale && !endpoint.startsWith("http://")) {
      await showCustomAlert("Kuboノードへの接続エンドポイントが設定されていません。\n\n設定画面からKubo RPCエンドポイント（http://127.0.0.1:5001等）を設定してください。", "⚠️ 未接続");
      return;
    }

    if (provider === "r2") {
      const s3Key = target.dataset.s3key || key;
      const ok = await showCustomConfirm(
        `自宅Kuboノードへ '${key}' を実体送信してPin留め（保持）しますか？\n\n（Kuboノード内にファイルを直接保存し、IPFSネットワークへ公開告知します）`,
        "🏠 Kubo Pin留め（実体保存）"
      );
      if (!ok) return;

      target.disabled = true;
      const origText = target.textContent;
      target.textContent = "送信中...";

      const online = await checkKuboOnline(1500);
      if (!online.online) {
        await showCustomAlert(
          `自宅 Kubo ノードに接続できませんでした（${online.error}）。\nWSL/Docker上でKuboが稼働しているか確認してください。`,
          "❌ ノード未検出"
        );
        target.disabled = false;
        target.textContent = origText;
        return;
      }

      try {
        // R2 から Blob を取得
        const r2S3 = getS3Client("r2");
        const r2Bucket = getBucketName("r2");
        let blob = null;
        if (r2S3 && r2Bucket) {
          const getRes = await r2S3.send(new GetObjectCommand({ Bucket: r2Bucket, Key: s3Key }));
          blob = await getRes.Body.transformToByteArray().then(bytes => new Blob([bytes]));
        } else {
          // フォールバック: 公開URLから fetch
          const article = target.closest(".result-item");
          const domain = article?.dataset?.allowedhost || (typeof window !== "undefined" ? window.location.origin : "");
          const publicUrl = `${domain}/${encodeURIComponent(key)}`;
          blob = await fetch(publicUrl).then(r => r.blob());
        }

        if (!blob) throw new Error("実体データの取得に失敗しました");

        // Kubo RPC /api/v0/add?pin=true で実体を直接注入
        const addRes = await addFileToKubo(blob, key);
        if (!addRes.success) {
          throw new Error(`Kuboへの実体注入に失敗しました: ${addRes.error}`);
        }

        const realCid = addRes.cid || (await calculateFilebaseCid(new Uint8Array(await blob.arrayBuffer())));
        if (realCid) {
          storeIpfsCid(key, realCid);
          storeIpfsCid(s3Key, realCid);
          storeR2Hash(key, realCid);
          storeR2Hash(s3Key, realCid);
        }

        // KV 台帳の kuboStatus を "pinned" に更新
        const kvData = await fetchKvRecord(key);
        if (kvData) {
          const meta = kvData.metadata || {};
          await registerKvCid(
            key,
            "r2",
            meta.size || blob.size || 0,
            meta.mime || blob.type || "",
            meta.s3Key || key,
            "",
            null,
            meta.ttl || 0,
            meta.expiresAt || null,
            Boolean(meta.unpinned),
            "pinned",
            meta.allowedHost || null,
            false,
            meta.thumbnailKey || null,
            meta.width || null,
            meta.height || null,
            Boolean(meta.civitaiTemporary),
            realCid || (isValidIpfsCid(cid) ? cid : null),
            "r2"
          );
        }

        await fetchAndRenderR2Files();
        await showCustomAlert(`✅ 自宅 Kubo ノードへの実体保存と Pin 留めに成功しました！\n\nCID: ${realCid || addRes.cid}`, "🎉 保全完了");
      } catch (err) {
        await showCustomAlert(`エラー: ${err.message}`, "❌ エラー");
        target.disabled = false;
        target.textContent = origText;
      }
      return;
    }

    const ok = await showCustomConfirm(
      `自宅Kuboノードへ '${key}' をPin留め（保持）しますか？\n\n（P2Pネットワーク経由でデータをノード内にダウンロード・固定保持します）`,
      "🏠 Kubo Pin留めの確認"
    );
    if (!ok) return;

    target.disabled = true;
    const origText = target.textContent;
    target.textContent = "確認中...";

    const online = await checkKuboOnline(1500);
    if (!online.online) {
      await showCustomAlert(
        `自宅 Kubo ノードに接続できませんでした（${online.error}）。\nWSL/Docker上でKuboが稼働しているか確認してください。`,
        "❌ ノード未検出"
      );
      target.disabled = false;
      target.textContent = origText;
      return;
    }

    try {
      activeKuboPins.add(cid);
      const pinRes = await pinToKubo(cid);
      if (pinRes.success) {
        target.textContent = "同期中...";
        target.title = "KuboがP2Pでブロックをダウンロード中...";

        // バックグラウンドで完了をポーリング検知
        const pollInterval = setInterval(async () => {
          try {
            const isPinned = await checkKuboPinned(cid, 1000);
            if (isPinned) {
              clearInterval(pollInterval);
              activeKuboPins.delete(cid);
              console.log(`🏠 Kubo P2P同期完了を検知: ${key}`);
              const kvData = await fetchKvRecord(key);
              if (kvData) {
                const meta = kvData.metadata || {};
                await registerKvCid(
                  key,
                  cid,
                  meta.size || 0,
                  meta.mime || "",
                  meta.s3Key || key,
                  "",
                  null,
                  meta.ttl || 0,
                  meta.expiresAt || null,
                  Boolean(meta.unpinned),
                  "pinned"
                );
              }
              await fetchAndRenderR2Files();
            }
          } catch (pErr) {
            console.warn(`Kubo poll error for ${cid}:`, pErr);
          }
        }, 3000);

        // 3分経過したら定期ポーリング停止（タイムアウト時もガード解除＆UI復元）
        setTimeout(() => {
          clearInterval(pollInterval);
          activeKuboPins.delete(cid);
          if (target && target.textContent === "同期中...") {
            target.disabled = false;
            target.textContent = origText;
            target.title = "同期に時間がかかっています。後ほど一覧を更新してください";
          }
        }, 180000);

        await showCustomAlert(
          `自宅 Kubo ノードへ P2P Pin留め要求を送信しました！\n\nKuboがバックグラウンドで世界中のIPFSノードからブロックを取得・同期しています。\n完了すると自動的に『🏠 Kubo: 保持中』へ変わります。\n\n※ P2P同期中はページを更新（リロード）せずそのままお待ちください。`,
          "📡 P2P 同期開始"
        );
      } else {
        activeKuboPins.delete(cid);
        await showCustomAlert(`Kubo Pin要求に失敗しました: ${pinRes.error}`, "❌ エラー");
        target.disabled = false;
        target.textContent = origText;
      }
    } catch (err) {
      activeKuboPins.delete(cid);
      await showCustomAlert(`エラー: ${err.message}`, "❌ エラー");
      target.disabled = false;
      target.textContent = origText;
    }
    return;
  }

  // ⚡ Filebase からの削除（アンピン）：Filebase S3 から削除し、KVとURLは維持
  if (target.classList.contains("unpin-file-btn")) {
    const key = target.dataset.key;
    const s3Key = target.dataset.s3key || key;
    const article = target.closest(".result-item");
    const cid = target.dataset.cid || article?.dataset?.cid || getStoredIpfsCid(key) || getStoredIpfsCid(s3Key);

    const isEn = getAppLanguage() === "en";
    const confirmMsg = isEn
      ? `Unpin and remove '${key}' from Filebase?\n\n・The object will be removed from Filebase storage.\n・The public URL remains active and served via IPFS / local Kubo.\n・⚠️ Note: You cannot re-store it to Filebase unless you re-upload the original file.`
      : `ファイル '${key}' を Filebase から削除（アンピン）しますか？\n\n・Filebase から実体を削除（アンピン）します。\n・URL は維持され、IPFS/自宅Kuboから配信されます。\n・⚠️ ※元ファイルを再度アップロードするまで、Filebase への再保管は行えません。`;
    const confirmTitle = isEn ? "☁️ Unpin from Filebase" : "☁️ Filebase 削除の確認";
    const ok = await showCustomConfirm(confirmMsg, confirmTitle);
    if (!ok) return;

    try {
      const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      });
      await s3.send(command);

      // KV の unpinned を true に更新（Kubo の既存保護状態は維持し、未Pinかつ自動Pin有効時のみPin試行）
      let currentKuboStatus = "not_pinned";
      let meta = {};
      if (key && cid) {
        const kvData = await fetchKvRecord(key);
        if (kvData) {
          meta = kvData.metadata || {};
          currentKuboStatus = meta.kuboStatus || "not_pinned";
        }
      }

      const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";
      if (currentKuboStatus !== "pinned" && isKuboAutoPin && cid) {
        const kuboCheck = await checkKuboOnline(1500);
        if (kuboCheck.online) {
          activeKuboPins.add(cid);
          try {
            const pinRes = await pinToKubo(cid);
            if (pinRes.success) {
              currentKuboStatus = "pinned";
            }
          } finally {
            activeKuboPins.delete(cid);
          }
        }
      }

      if (key && cid) {
        await registerKvCid(
          key,
          cid,
          meta.size || 0,
          meta.mime || "",
          meta.s3Key || s3Key || key,
          "",
          null,
          meta.ttl || 0,
          meta.expiresAt || null,
          true,
          currentKuboStatus
        );
      }

      await fetchAndRenderR2Files();
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${err.message}`, "❌ エラー");
    }
    return;
  }

  // ⚡ R2 バケットからの実体消去（安全ライフサイクルガード: 自宅Kubo保全済み時のみ実行可能）
  if (target.classList.contains("unpin-r2-origin-btn")) {
    const key = target.dataset.key;
    const s3Key = target.dataset.s3key || key;
    const cid = target.dataset.cid;

    const isEn = getAppLanguage() === "en";
    const confirmMsg = isEn
      ? `Remove R2 storage object for '${key}' to free up bucket quota?\n\n・The object will be safely removed from Cloudflare R2 bucket.\n・Since it is already stored on your home Kubo node, the public URL will remain fully accessible via IPFS / Kubo.\n・Filebase is NOT used or affected.`
      : `自宅Kuboに保全されているため、'${key}' の R2 実体を消去してバケット容量を解放しますか？\n\n・R2 バケットから実体オブジェクトが削除され、10GB の無料枠が空きます。\n・すでに自宅 Kubo ノードに実体が保全されているため、公開 URL は引き続き IPFS / Kubo 経由で正常にアクセス可能です。\n・※ Filebase の帯域や枠は一切消費されません。`;
    const confirmTitle = isEn ? "⚡ Free R2 Storage" : "⚡ R2 実体消去（容量解放）の確認";
    const ok = await showCustomConfirm(confirmMsg, confirmTitle);
    if (!ok) return;

    try {
      const r2S3 = getS3Client("r2");
      const r2Bucket = getBucketName("r2");
      if (!r2S3 || !r2Bucket) throw new Error("R2 is not configured");

      await r2S3.send(new DeleteObjectCommand({
        Bucket: r2Bucket,
        Key: s3Key,
      }));

      // ローカルハッシュキャッシュをパージ
      deleteR2Hash(s3Key);
      deleteR2Hash(key);

      await fetchAndRenderR2Files();
      await showCustomAlert(
        isEn ? "✅ R2 object deleted successfully. Media will now be served from your home Kubo node." : "✅ R2 実体を削除し、バケット容量を解放しました！\n今後は自宅 Kubo ノードから安全に配信されます。",
        "🎉 容量解放完了"
      );
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${err.message}`, "❌ エラー");
    }
    return;
  }

  // 🚫 リンク抹消：KV から削除して即座に 404 化し、共有リンクが無ければ S3 の実体も削除
  if (target.classList.contains("delete-r2-file-btn")) {
    const key = target.dataset.key;
    const s3Key = target.dataset.s3key || key;
    const cid = target.dataset.cid || "";
    const isFromOrigin = target.dataset.origin === "1";

    if (!key) return;

    if (isFilebase) {
      // 画面上の他のアイテムで、同じ S3実体 または CID を共有している別名リンクを探索
      const allItems = Array.from(r2FileList.querySelectorAll(".result-item"));
      const siblingLinks = allItems
        .filter(el => el.dataset.key !== key)
        .filter(el => {
          const elS3Key = el.dataset.s3key;
          const elCid = el.dataset.cid;
          if (s3Key && elS3Key && elS3Key === s3Key) return true;
          if (cid && elCid && elCid === cid) return true;
          return false;
        })
        .map(el => el.dataset.key);

      let deleteOriginAlso = false;

      if (siblingLinks.length > 0) {
        // 他のリンクと実体を共有している場合
        const siblingNames = siblingLinks.map(name => `'${name}'`).join("、");
        const confirmMsg = `ファイル（リンク）'${key}' を削除しますか？\n\n⚠️ このファイルの実体は、以下の他の名前（エイリアス）とも共有されています：\n【共有中】: ${siblingNames}\n\n・[OK] を押すと、'${key}' のURLのみを削除（即座に404化）します。\n（他のリンク '${siblingLinks[0]}' などは引き続き閲覧できます）`;
        const ok = await showCustomConfirm(confirmMsg, "⚠️ リンク削除の確認");
        if (!ok) return;

        // オプション: 実体ごと全部消したいか確認
        if (isFromOrigin) {
          deleteOriginAlso = await showCustomConfirm(
            `【完全削除の確認】\n\nクラウド実体（Filebase）も完全に削除し、共有している他のリンク（${siblingNames}）もすべて無効化しますか？\n\n・[すべて完全削除]: 実体も含めてすべて完全削除\n・[リンクのみ削除]: '${key}' のリンクのみ削除（推奨）`,
            "🗑️ 完全削除の確認",
            "すべて完全削除",
            "リンクのみ削除"
          );
        }
      } else {
        // 単独リンクの場合
        const confirmMsg = `ファイル '${key}' を削除しますか？\n\n・URL は即座に 404 になり閲覧できなくなります。\n・クラウドおよび自宅Kuboからも安全に消去されます。`;
        const ok = await showCustomConfirm(confirmMsg, "🗑️ ファイル削除の確認", "削除する");
        if (!ok) return;
        deleteOriginAlso = isFromOrigin;
      }

      try {
        const willDeleteAll = (siblingLinks.length === 0 || deleteOriginAlso);
        // 1. 対象リンクの KV マッピングを削除（他で使われていなければ墓標発行指示）
        await deleteKvCid(key, { makeTombstone: willDeleteAll });

        // 2. 「すべて抹消」が選択された場合、共有している兄弟リンクの KV も一括削除
        if (siblingLinks.length > 0 && deleteOriginAlso) {
          for (const sKey of siblingLinks) {
            await deleteKvCid(sKey, { makeTombstone: false });
          }
        }

        // 3. 他に共有リンクがないか、あるいは「実体ごとすべて抹消」が選ばれた場合のみ S3 実体を削除
        if (deleteOriginAlso && s3 && bucketName && s3Key) {
          const thumbnailKey = getVideoThumbnailKey(s3Key);
          if (thumbnailKey) await deleteKvCid(thumbnailKey, { makeTombstone: false });
          const keysToDelete = [s3Key, thumbnailKey].filter(Boolean);
          await safeDeleteS3Objects(s3, bucketName, keysToDelete);
        }


        await fetchAndRenderR2Files();
      } catch (err) {
        await showCustomAlert(`削除に失敗しました: ${err.message}`, "❌ エラー");
      }
      return;
    }

    // Cloudflare R2 モードの場合
    const resolvedS3Key = target.dataset.s3key || target.closest(".result-item")?.dataset?.s3key || key;
    const allItems = Array.from(r2FileList.querySelectorAll(".result-item"));
    const siblingLinks = allItems
      .filter(el => el.dataset.key !== key)
      .filter(el => {
        const elS3Key = el.dataset.s3key;
        if (resolvedS3Key && elS3Key && elS3Key === resolvedS3Key) return true;
        return false;
      })
      .map(el => el.dataset.key);

    let deleteOriginAlso = false;

    if (siblingLinks.length > 0) {
      // 他のリンクと実体を共有している場合（エイリアスがある）
      const siblingNames = siblingLinks.map(name => `'${name}'`).join("、");
      const confirmMsg = `ファイル（リンク）'${key}' を削除しますか？\n\n⚠️ このファイルの実体は、以下の他のドメイン（エイリアス）とも共有されています：\n【共有中】: ${siblingNames}\n\n・[OK] を押すと、'${key}' のURLのみを削除（即座に404化）します。\n（他のリンク '${siblingLinks[0]}' などは引き続き閲覧できます）`;
      const ok = await showCustomConfirm(confirmMsg, "⚠️ リンク削除の確認");
      if (!ok) return;

      deleteOriginAlso = await showCustomConfirm(
        `【完全削除の確認】\n\nR2 バケット内の実体ファイルも完全に削除し、共有している他のリンク（${siblingNames}）もすべて無効化しますか？\n\n・[すべて完全削除]: 実体も含めてすべて完全削除\n・[リンクのみ削除]: '${key}' のリンクのみ削除（推奨）`,
        "🗑️ 完全削除の確認",
        "すべて完全削除",
        "リンクのみ削除"
      );
    } else {
      // 単独リンクの場合
      const confirmMsg = `ファイル '${key}' を R2 から削除しますか？\n\n・URL は即座に 404 になり閲覧できなくなります。\n・R2 バケット内の実体も安全に消去されます。`;
      const ok = await showCustomConfirm(confirmMsg, "🗑️ R2 削除の確認", "削除する");
      if (!ok) return;
      deleteOriginAlso = true;
    }

    try {
      const willDeleteAll = (siblingLinks.length === 0 || deleteOriginAlso);
      // 1. 対象リンクの KV マッピングを削除（エイリアスレコードの場合）
      await deleteKvCid(key, { makeTombstone: willDeleteAll });

      // 2. 「すべて完全削除」が選択された場合、共有している兄弟リンクの KV も一括削除
      if (siblingLinks.length > 0 && deleteOriginAlso) {
        for (const sKey of siblingLinks) {
          await deleteKvCid(sKey, { makeTombstone: false });
        }
      }

      // 3. 単独、または「すべて完全削除」の場合のみ S3 (R2) 実体を削除
      if (deleteOriginAlso && s3 && bucketName && resolvedS3Key) {
        const thumbnailKey = getVideoThumbnailKey(resolvedS3Key);
        if (thumbnailKey) await deleteKvCid(thumbnailKey, { makeTombstone: false });
        const keysToDelete = [resolvedS3Key, thumbnailKey].filter(Boolean);
        await safeDeleteS3Objects(s3, bucketName, keysToDelete);
        keysToDelete.forEach(deleteR2Hash);
      }
      await fetchAndRenderR2Files();
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${err.message}`, "❌ エラー");
    }
    return;
  }

  if (target.classList.contains("r2-file-checkbox")) {
    updateSelectedR2ActionButtonsState();
  }
});

function updateSelectedR2ActionButtonsState() {
  const checkboxes = document.querySelectorAll(".r2-file-checkbox:checked");
  if (deleteSelectedR2FilesButton) {
    deleteSelectedR2FilesButton.style.display = checkboxes.length > 0 ? "inline-flex" : "none";
    deleteSelectedR2FilesButton.textContent = `選択削除 (${checkboxes.length})`;
  }
}

deleteSelectedR2FilesButton?.addEventListener("click", async () => {
  const checkboxes = Array.from(document.querySelectorAll(".r2-file-checkbox:checked"));
  if (checkboxes.length === 0) return;

  const isFilebase = activeStorageTab === "filebase";
  const providerLabel = isFilebase ? "Filebase / KV" : "R2";

  const ok = await showCustomConfirm(
    `選択した ${checkboxes.length} 件のファイルを ${providerLabel} から削除しますか？`,
    "🗑️ 一括削除の確認",
    "一括削除する"
  );
  if (!ok) return;

  const s3 = getS3Client(activeStorageTab);
  const bucketName = getBucketName(activeStorageTab);
  const keys = checkboxes.map(cb => cb.dataset.key);

  try {
    if (isFilebase) {
      // 選択されたキーの KV マッピングを削除
      for (const key of keys) {
        await deleteKvCid(key);
      }

      // 未選択の残るアイテムの中に、同じ S3実体 を指している別名リンクがあるかチェック
      const allItems = Array.from(r2FileList.querySelectorAll(".result-item"));
      const remainingItems = allItems.filter(el => !keys.includes(el.dataset.key));
      const remainingS3Keys = new Set(remainingItems.map(el => el.dataset.s3key).filter(Boolean));

      // 選択された各アイテムに対応する S3Key のうち、残るリンクから参照されていない実体のみを S3 から削除
      const s3KeysToDelete = new Set();
      for (const cb of checkboxes) {
        const itemS3Key = cb.closest(".result-item")?.dataset?.s3key || cb.dataset.key;
        if (itemS3Key && !remainingS3Keys.has(itemS3Key)) {
          s3KeysToDelete.add(itemS3Key);
        }
      }

      if (s3 && bucketName && s3KeysToDelete.size > 0) {
        const thumbnailKeys = Array.from(s3KeysToDelete).map(getVideoThumbnailKey).filter(Boolean);
        for (const thumbnailKey of thumbnailKeys) await deleteKvCid(thumbnailKey, { makeTombstone: false });
        await safeDeleteS3Objects(s3, bucketName, [...s3KeysToDelete, ...thumbnailKeys]);
      }

    } else {
      // 選択されたキーの KV マッピングを削除（エイリアスレコードの場合）
      for (const key of keys) {
        await deleteKvCid(key);
      }

      // 未選択の残るアイテムの中に、同じ S3実体 を指している別名リンクがあるかチェック
      const allItems = Array.from(r2FileList.querySelectorAll(".result-item"));
      const remainingItems = allItems.filter(el => !keys.includes(el.dataset.key));
      const remainingS3Keys = new Set(remainingItems.map(el => el.dataset.s3key).filter(Boolean));

      // 選択された各アイテムに対応する S3Key のうち、残るリンクから参照されていない実体のみを R2 から削除
      const s3KeysToDelete = new Set();
      for (const cb of checkboxes) {
        const itemS3Key = cb.closest(".result-item")?.dataset?.s3key || cb.dataset.key;
        if (itemS3Key && !remainingS3Keys.has(itemS3Key)) {
          s3KeysToDelete.add(itemS3Key);
        }
      }

      if (s3 && bucketName && s3KeysToDelete.size > 0) {
        const thumbnailKeys = Array.from(s3KeysToDelete).map(getVideoThumbnailKey).filter(Boolean);
        for (const thumbnailKey of thumbnailKeys) await deleteKvCid(thumbnailKey, { makeTombstone: false });
        await safeDeleteS3Objects(s3, bucketName, [...s3KeysToDelete, ...thumbnailKeys]);
        s3KeysToDelete.forEach(deleteR2Hash);
      }
    }
    await fetchAndRenderR2Files();
  } catch (err) {
    await showCustomAlert(`一括削除に失敗しました: ${err.message}`, "❌ エラー");
  }
});

// URL 生成ヘルパー
function getPublicUrl(key) {
  const domain = getSelectedR2Domain();
  return domain ? `${domain.replace(/\/$/, "")}/${encodeURIComponent(key)}` : key;
}

function getDevUrl(key) {
  const list = getR2DomainList();
  const dev = list.find(d => d.includes(".r2.dev"));
  return dev ? `${dev.replace(/\/$/, "")}/${encodeURIComponent(key)}` : getPublicUrl(key);
}

// パレット描画
function renderUrlPalette() {
  if (!paletteList) return;
  paletteList.innerHTML = "";

  const allPaletteFiles = [...paletteFiles, ...civitaiPaletteFiles];

  if (allPaletteFiles.length === 0) {
    paletteList.innerHTML = `<span style="font-size: 11px; color: var(--muted); padding: 8px;">R2 ストレージまたはCivitaiのメディアがありません。</span>`;
    return;
  }

  allPaletteFiles.forEach(file => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = file.isCivitai ? "palette-chip civitai-palette-chip" : "palette-chip";
    btn.dataset.url = file.url;
    btn.title = `${file.key} (クリックでURL挿入)`;
    btn.style.position = "relative";

    const ext = file.key ? file.key.split('.').pop().toLowerCase() : "";
    const isVideo = file.isVideo || ["mp4", "webm", "ogv", "mov", "m4v"].includes(ext);
    const isImage = !isVideo && (file.previewUrl || ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext) || file.isCivitai);

    if (isVideo) {
      const video = document.createElement("video");
      video.src = `${file.url}#t=0.5`;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("referrerpolicy", "no-referrer");
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      video.style.pointerEvents = "none";
      btn.append(video);
    } else if (isImage) {
      const img = document.createElement("img");
      img.src = file.previewUrl || file.url;
      img.alt = "";
      img.loading = "lazy";
      img.setAttribute("referrerpolicy", "no-referrer");
      btn.append(img);
    } else {
      btn.className += " format-badge";
      btn.textContent = ext.toUpperCase() || "FILE";
    }

    if (file.isCivitai) {
      const badge = document.createElement("span");
      badge.className = "palette-chip-badge";
      badge.textContent = "🎨";
      btn.append(badge);
    }

    btn.addEventListener("click", () => {
      insertUrlToComposer(file.url);
    });

    paletteList.append(btn);
  });
}

function insertUrlToComposer(url) {
  if (!composerTextarea) return;
  const text = composerTextarea.value;
  if (text.includes("{url}")) {
    const idx = text.indexOf("{url}");
    composerTextarea.value = text.replace("{url}", url);
    const newPos = idx + url.length;
    composerTextarea.focus();
    composerTextarea.setSelectionRange(newPos, newPos);
  } else {
    const start = composerTextarea.selectionStart;
    const end = composerTextarea.selectionEnd;
    const before = text.substring(0, start);
    const after = text.substring(end);

    composerTextarea.value = `${before}${url}\n${after}`;
    composerTextarea.focus();
    composerTextarea.selectionStart = composerTextarea.selectionEnd = start + url.length + 1;
  }
}

// テキスト作成支援のイベント
templateSelect?.addEventListener("change", () => {
  const val = templateSelect.value;
  if (!val) {
    if (deleteTemplateButton) deleteTemplateButton.style.display = "none";
    return;
  }

  if (val === "__new__") {
    if (deleteTemplateButton) deleteTemplateButton.style.display = "none";
    return;
  }

  const selectedOpt = templateSelect.selectedOptions[0];
  if (selectedOpt && composerTextarea) {
    composerTextarea.value = selectedOpt.dataset.text || "";
  }

  const isDefault = Object.keys(defaultTemplates).includes(val);
  if (deleteTemplateButton) {
    deleteTemplateButton.style.display = isDefault ? "none" : "inline-flex";
  }
});

saveTemplateButton?.addEventListener("click", () => {
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  const text = composerTextarea?.value || "";

  if (!text.trim()) {
    alert(dict.promptEmptyNotice);
    return;
  }

  const name = prompt(dict.promptNameInput);
  if (!name || !name.trim()) return;

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("composerTemplates") || "{}");
  } catch (e) {
    saved = {};
  }

  const key = "tpl_" + Date.now();
  saved[key] = { name: name.trim(), text };
  localStorage.setItem("composerTemplates", JSON.stringify(saved));
  loadTemplates(key);
  alert(dict.promptSaveSuccess.replace("{name}", name.trim()));
});

deleteTemplateButton?.addEventListener("click", () => {
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  const val = templateSelect?.value;
  if (!val || Object.keys(defaultTemplates).includes(val) || val === "__new__") return;

  const opt = templateSelect.selectedOptions[0];
  const name = opt ? opt.textContent : "";

  if (!confirm(dict.promptDeleteConfirm.replace("{name}", name))) return;

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("composerTemplates") || "{}");
  } catch (e) {
    saved = {};
  }

  delete saved[val];
  localStorage.setItem("composerTemplates", JSON.stringify(saved));
  loadTemplates();
});

insertUrlTagButton?.addEventListener("click", () => {
  if (!composerTextarea) return;
  const start = composerTextarea.selectionStart ?? composerTextarea.value.length;
  const end = composerTextarea.selectionEnd ?? composerTextarea.value.length;
  const text = composerTextarea.value;
  const insertText = "{url}";
  composerTextarea.value = text.substring(0, start) + insertText + text.substring(end);
  composerTextarea.focus();
  const nextPos = start + insertText.length;
  composerTextarea.setSelectionRange(nextPos, nextPos);
});

clearComposerButton?.addEventListener("click", () => {
  if (composerTextarea) composerTextarea.value = "";
});

copyComposerTextButton?.addEventListener("click", async () => {
  if (!composerTextarea) return;
  await copyToClipboard(composerTextarea.value, copyComposerTextButton);
});

// ユーティリティ
function openCivitaiIntent(mediaUrl, title = "", existingWindow = null) {
  if (!mediaUrl) return;
  const intentUrl = `https://civitai.com/intent/post?mediaUrl=${encodeURIComponent(mediaUrl)}${title ? `&title=${encodeURIComponent(title)}` : ""}`;
  if (existingWindow && !existingWindow.closed) {
    try {
      existingWindow.location.href = intentUrl;
      return;
    } catch (e) {
      console.warn("Failed to redirect existing window:", e);
    }
  }
  window.open(intentUrl, "_blank", "noopener,noreferrer");
}
async function copyToClipboard(text, button = null) {
  if (!text) {
    if (button) {
      const orig = button.textContent;
      button.textContent = "URLなし";
      button.classList.add("danger-button");
      setTimeout(() => {
        button.textContent = orig;
        button.classList.remove("danger-button");
      }, 1500);
    }
    return false;
  }
  let copied = false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch (err) {
    console.warn("navigator.clipboard failed, trying execCommand fallback:", err);
  }

  if (!copied) {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.top = "-9999px";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textArea);
    } catch (fallbackErr) {
      console.error("execCommand copy failed:", fallbackErr);
    }
  }

  if (button) {
    const orig = button.textContent;
    button.textContent = copied ? "コピー完了!" : "コピー失敗";
    button.classList.add(copied ? "good" : "danger-button");
    setTimeout(() => {
      button.textContent = orig;
      button.classList.remove("good", "danger-button");
    }, 1500);
  }
  return copied;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 画面中央に表示するカスタム確認モーダル（ブラウザ最上部alert/confirmの代替）
 * @param {string} message - 表示メッセージ
 * @param {string} title - モーダル見出し
 * @param {string} okText - OKボタンのテキスト
 * @param {string} cancelText - キャンセルボタンのテキスト
 * @returns {Promise<boolean>} - OKならtrue、キャンセルならfalse
 */
function showCustomConfirm(message, title = "確認", okText = "OK", cancelText = "キャンセル") {
  return new Promise((resolve) => {
    const modal = document.getElementById("centerAppModal");
    const titleEl = document.getElementById("centerAppModalTitle");
    const bodyEl = document.getElementById("centerAppModalBody");
    const okBtn = document.getElementById("centerAppModalOkBtn");
    const cancelBtn = document.getElementById("centerAppModalCancelBtn");

    if (!modal || !bodyEl || !okBtn || !cancelBtn) {
      resolve(confirm(message));
      return;
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;
    bodyEl.style.whiteSpace = "pre-line";
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = "inline-flex";

    modal.style.display = "grid";

    const cleanup = (res) => {
      modal.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      resolve(res);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target === modal) cleanup(false);
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
  });
}

/**
 * 画面中央に表示するカスタム通知モーダル（OKボタンのみ）
 * @param {string} message - 表示メッセージ
 * @param {string} title - モーダル見出し
 * @returns {Promise<void>}
 */
function showCustomAlert(message, title = "お知らせ") {
  return new Promise((resolve) => {
    const modal = document.getElementById("centerAppModal");
    const titleEl = document.getElementById("centerAppModalTitle");
    const bodyEl = document.getElementById("centerAppModalBody");
    const okBtn = document.getElementById("centerAppModalOkBtn");
    const cancelBtn = document.getElementById("centerAppModalCancelBtn");

    if (!modal || !bodyEl || !okBtn) {
      alert(message);
      resolve();
      return;
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;
    okBtn.textContent = "OK";
    if (cancelBtn) cancelBtn.style.display = "none";

    modal.style.display = "grid";

    const cleanup = () => {
      modal.style.display = "none";
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
      resolve();
    };

    const onOk = () => cleanup();
    const onBackdrop = (e) => {
      if (e.target === modal) cleanup();
    };

    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
  });
}

/**
 * 🌐 配信ドメイン エイリアス作成ダイアログ
 * @param {string} currentKey - 対象ファイル名
 * @param {string} currentDomain - 現在選択されているドメイン
 * @param {string[]} domainList - 利用可能なドメイン一覧
 * @returns {Promise<{ filename: string, targetDomain: string } | null>}
 */
function showDomainAliasDialog(currentKey, currentDomain, domainList) {
  return new Promise((resolve) => {
    const modal = document.getElementById("aliasCreateModal");
    const filenameInput = document.getElementById("aliasTargetFilenameInput");
    const domainSelect = document.getElementById("aliasTargetDomainSelect");
    const ttlSelect = document.getElementById("aliasTargetTtlSelect");
    const submitBtn = document.getElementById("submitAliasBtn");
    const cancelBtn = document.getElementById("cancelAliasBtn");

    if (!modal || !filenameInput || !domainSelect || !submitBtn || !cancelBtn) {
      // フォールバック
      const newDomain = prompt("追加する配信ドメインを入力してください:", domainList[0] || "");
      if (!newDomain) return resolve(null);
      return resolve({ filename: currentKey, targetDomain: newDomain, ttl: 0 });
    }

    // 同一ファイル名をそのまま固定表示
    filenameInput.value = currentKey;

    // ドメイン候補オプション生成（現在と異なるドメインを優先選択）
    domainSelect.innerHTML = "";
    let firstOtherDomain = null;
    domainList.forEach(domain => {
      let icon = "🌐 ";
      if (domain.includes(".pages.dev")) icon = "⚡ ";
      else if (domain.includes(".r2.dev")) icon = "📦 ";
      let clean = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const isCurrent = currentDomain && domain.toLowerCase() === currentDomain.toLowerCase();
      if (!isCurrent && !firstOtherDomain) firstOtherDomain = domain;
      const opt = document.createElement("option");
      opt.value = domain;
      opt.textContent = `${icon}${clean}${isCurrent ? " (現在のドメイン)" : ""}`;
      domainSelect.appendChild(opt);
    });

    if (firstOtherDomain) {
      domainSelect.value = firstOtherDomain;
    }

    if (ttlSelect) {
      ttlSelect.value = "0"; // デフォルトは無期限
    }

    modal.style.display = "grid";

    const cleanup = (result) => {
      modal.style.display = "none";
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      resolve(result);
    };

    const onSubmit = () => {
      const filename = filenameInput.value.trim() || currentKey;
      const targetDomain = domainSelect.value.trim();
      const ttl = ttlSelect ? Number(ttlSelect.value || 0) : 0;
      if (!targetDomain) {
        alert("⚠️ 配信ドメインを選択してください。");
        return;
      }
      cleanup({ filename, targetDomain, ttl });
    };

    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => {
      if (e.target === modal) cleanup(null);
    };

    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
  });
}


function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

function generateRandomString(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ファイル名を最大100文字に制限し、超過時は安全に切り詰めて短縮ハッシュを付与
function truncateFilename(filename, maxLength = 100) {
  if (!filename || typeof filename !== "string") return filename || "";
  const fullChars = Array.from(filename);
  if (fullChars.length <= maxLength) return filename;

  const dotIndex = filename.lastIndexOf(".");
  let ext = "";
  let baseStr = filename;
  if (dotIndex > 0 && dotIndex < filename.length - 1) {
    ext = filename.slice(dotIndex);
    baseStr = filename.slice(0, dotIndex);
  }

  let hash = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const rand = new Uint8Array(4);
    crypto.getRandomValues(rand);
    hash = Array.from(rand, b => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
  } else {
    hash = Math.random().toString(36).slice(2, 8);
  }

  const suffix = `_${hash}${ext}`;
  const suffixChars = Array.from(suffix);
  const allowedBaseCharsCount = Math.max(1, maxLength - suffixChars.length);
  const baseChars = Array.from(baseStr);
  const truncatedBase = baseChars.slice(0, allowedBaseCharsCount).join("").replace(/[._\s-]+$/, "");

  return `${truncatedBase}${suffix}`;
}

function createOutputName(originalName, mimeType, index = 0) {
  const dotIndex = originalName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  const originalExt = dotIndex > 0 ? originalName.slice(dotIndex + 1) : "";

  const isRenameOn = enableRenameCheck?.checked ?? true;
  const isConvertOn = enableConvertCheck?.checked ?? true;

  let safeBase = baseName;

  if (isRenameOn) {
    const pattern = renamePattern?.value?.trim() || "{name}";
    safeBase = pattern.replaceAll("{name}", baseName);

    safeBase = safeBase.replace(/\{rand[ao]m(?::(\d+))?\}/g, (match, digits) => {
      const len = digits ? parseInt(digits, 10) : 6;
      return generateRandomString(len);
    });

    safeBase = safeBase.replace(/\{num(?::(\d+))?\}/g, (match, digits) => {
      const numValue = index + 1;
      if (digits) {
        const targetLength = parseInt(digits, 10);
        return String(numValue).padStart(targetLength, "0");
      }
      return String(numValue);
    });

    safeBase = safeBase.replace(/[\\/:*?"<>|]/g, "-");
  }

  // URL・ストレージセーフ化: 空白・連続スペースをアンダースコアにサニタイズ（SNSでのリンク分断を防止）
  safeBase = safeBase.trim().replace(/\s+/g, "_");

  const isImageMime = mimeType && (mimeType in extensions);
  const ext = (isConvertOn && isImageMime)
    ? extensions[mimeType]
    : (originalExt || "bin");

  // 🛡️ どんなプリセット・連番を重ねても、最終出力は厳格に100文字以内にサニタイズ
  return truncateFilename(`${safeBase}.${ext}`, 100);
}

function createZip(entries) {
  const files = [];
  const centralDirectory = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    files.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralDirectory.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralSize = centralDirectory.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...files, ...centralDirectory, end], { type: "application/zip" });
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function downloadUrl(url, name) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

civitaiGalleryList?.addEventListener("click", async (event) => {
  const target = event.target;
  const creatorTag = target.closest(".civitai-creator-tag");
  if (creatorTag) {
    const user = creatorTag.dataset.username;
    if (user && civitaiUserSelect) {
      civitaiUserSelect.value = user;
      localStorage.setItem("civitaiUsername", user);
      updateCivitaiStatus();
      renderCivitaiUserSelect();
      fetchAndRenderCivitaiGallery();
    }
    return;
  }

  const promptBtn = target.closest(".civitai-prompt-btn");
  if (promptBtn) {
    const id = promptBtn.dataset.id;
    const promptText = civitaiPromptsMap[id];
    if (promptText) {
      await copyToClipboard(promptText, promptBtn, "📋 コピー完了!");
    }
    return;
  }

  const copyBtn = target.closest(".civitai-copy-btn");
  if (copyBtn) {
    const rawUrl = copyBtn.dataset.url;
    if (!rawUrl) return;

    try {
      copyBtn.textContent = "解決中...";
      let finalUrl = rawUrl;

      // サーバーサイドの /api/resolve-url を経由してリダイレクト先（blobs-b2.civitai.com 等）の短縮URLを取得
      try {
        const resolveApi = `/api/resolve-url?url=${encodeURIComponent(rawUrl)}`;
        const res = await fetch(resolveApi);
        if (res.ok) {
          const data = await res.json();
          if (data && data.resolvedUrl) {
            finalUrl = data.resolvedUrl;
          }
        }
      } catch (e) {
        console.warn("Failed to resolve URL via /api/resolve-url:", e);
      }

      copyBtn.dataset.url = finalUrl;
      await copyToClipboard(finalUrl, copyBtn, "📋 URLコピー");
    } catch (err) {
      console.warn("Failed to copy civitai url:", err);
      await copyToClipboard(rawUrl, copyBtn, "📋 URLコピー");
    }
  }
});

// --- 🚀 外部投稿 / Windows「送る」連携ロジック ---
const uploadStorageSelect = document.querySelector("#uploadStorageSelect");
const uploadReturnDomainSelect = document.querySelector("#uploadReturnDomainSelect");
const uploadNamingRuleSelect = document.querySelector("#uploadNamingRuleSelect");
const dedicatedUploadApiUrlInput = document.querySelector("#dedicatedUploadApiUrl");
const uploadApiTokenInput = document.querySelector("#uploadApiToken");
const uploadTokenNotice = document.querySelector("#uploadTokenNotice");
const copyUploadApiUrlBtn = document.querySelector("#copyUploadApiUrlBtn");
const copyCurlCmdBtn = document.querySelector("#copyCurlCmdBtn");
const downloadSendToBatBtn = document.querySelector("#downloadSendToBatBtn");
const downloadSharexBtn = document.querySelector("#downloadSharexBtn");

// 外部投稿は、利用者自身が設定した Worker だけを対象にする。
function getDedicatedUploadEndpoint() {
  const customWorkerUrl = getCustomKvWorkerUrl();
  if (!customWorkerUrl) return "";
  const baseDomain = customWorkerUrl.replace(/\/api\/(cividge-kv|ipfs-kv)\/?$/, "").replace(/\/$/, "");
  return `${baseDomain}/api/upload`;
}

// 選択中の投稿先ストレージ種別を取得 ("filebase" | "r2")
function getSelectedUploadStorage() {
  return uploadStorageSelect?.value || "filebase";
}

// 外部投稿は管理 API トークンを流用せず、投稿専用の UPLOAD_TOKEN を使う。
function getUploadApiToken() {
  return (uploadApiTokenInput?.value || localStorage.getItem("uploadApiToken") || "").trim();
}

// 外部投稿用プルダウンの選択肢を更新
function populateUploadReturnDomainSelect() {
  if (!uploadReturnDomainSelect) return;
  const currentVal = uploadReturnDomainSelect.value;
  const domains = getR2DomainList(getSelectedUploadStorage());

  uploadReturnDomainSelect.innerHTML = "";
  domains.forEach(d => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    uploadReturnDomainSelect.appendChild(opt);
  });

  if (currentVal && domains.includes(currentVal)) {
    uploadReturnDomainSelect.value = currentVal;
  } else if (uploadReturnDomainSelect.options.length > 0) {
    uploadReturnDomainSelect.selectedIndex = 0;
  }
}

// 選択された返却配信ドメインを取得
function getSelectedUploadReturnDomain() {
  if (uploadReturnDomainSelect && uploadReturnDomainSelect.value) {
    return uploadReturnDomainSelect.value.trim().replace(/\/$/, "");
  }
  return (getSelectedR2Domain(getSelectedUploadStorage()) || "").replace(/\/$/, "");
}

// 外部投稿用 URL。秘密情報はクエリへ含めず Authorization ヘッダーだけで渡す。
function getDedicatedUploadFullUrl() {
  const endpoint = getDedicatedUploadEndpoint();
  const selectedDomain = getSelectedUploadReturnDomain();
  const selectedStorage = getSelectedUploadStorage();
  const namingRule = uploadNamingRuleSelect?.value || "original";

  if (!endpoint) return "";

  const url = new URL(endpoint);
  if (selectedStorage) {
    url.searchParams.set("storage", selectedStorage);
  }
  if (selectedDomain) {
    url.searchParams.set("domain", selectedDomain);
  }
  if (namingRule) {
    url.searchParams.set("naming", namingRule);
  }
  return url.toString();
}

const uploadTokenStatusBadge = document.querySelector("#uploadTokenStatusBadge");
let isUploadTokenVerified = false;
let uploadTokenVerifyTimer = null;

// 🔑 Worker と通信して UPLOAD_TOKEN の正誤を検証
async function verifyUploadToken() {
  const token = getUploadApiToken();
  const endpoint = getDedicatedUploadEndpoint();
  const dict = i18nDict[getAppLanguage()] || i18nDict.ja;

  if (!endpoint) {
    if (uploadTokenStatusBadge) {
      uploadTokenStatusBadge.innerHTML = `<span style="color: var(--muted);">${dict.uploadTokenStatusNeedWorker}</span>`;
    }
    isUploadTokenVerified = false;
    updateDedicatedUploadApiUI();
    return;
  }

  if (!token) {
    if (uploadTokenStatusBadge) {
      uploadTokenStatusBadge.innerHTML = `<span style="color: var(--muted);">${dict.uploadTokenStatusUnknown}</span>`;
    }
    isUploadTokenVerified = false;
    updateDedicatedUploadApiUI();
    return;
  }

  if (uploadTokenStatusBadge) {
    uploadTokenStatusBadge.innerHTML = `<span style="color: #f59e0b;">${dict.uploadTokenStatusChecking}</span>`;
  }

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.valid || data.success) {
        if (uploadTokenStatusBadge) {
          uploadTokenStatusBadge.innerHTML = `<span style="color: #22c55e; font-weight: 600;">${dict.uploadTokenStatusValid}</span>`;
        }
        isUploadTokenVerified = true;
      } else {
        if (uploadTokenStatusBadge) {
          uploadTokenStatusBadge.innerHTML = `<span style="color: #ef4444; font-weight: 600;">${dict.uploadTokenStatusInvalid}</span>`;
        }
        isUploadTokenVerified = false;
      }
    } else {
      if (uploadTokenStatusBadge) {
        uploadTokenStatusBadge.innerHTML = `<span style="color: #ef4444; font-weight: 600;">${dict.uploadTokenStatusInvalid}</span>`;
      }
      isUploadTokenVerified = false;
    }
  } catch (err) {
    if (uploadTokenStatusBadge) {
      uploadTokenStatusBadge.innerHTML = `<span style="color: #ef4444;">⚠️ 通信エラー</span>`;
    }
    isUploadTokenVerified = false;
  }

  updateDedicatedUploadApiUI();
}

function scheduleUploadTokenVerify(delayMs = 400) {
  if (uploadTokenVerifyTimer) clearTimeout(uploadTokenVerifyTimer);
  uploadTokenVerifyTimer = setTimeout(() => {
    verifyUploadToken();
  }, delayMs);
}

// UIの同期・トークン未設定＆不一致ガード
function updateDedicatedUploadApiUI() {
  if (!dedicatedUploadApiUrlInput) return;
  const token = getUploadApiToken();
  const hasToken = Boolean(token);
  const hasEndpoint = Boolean(getDedicatedUploadEndpoint());

  dedicatedUploadApiUrlInput.value = getDedicatedUploadFullUrl();

  if (uploadTokenNotice) {
    if (!hasEndpoint) {
      uploadTokenNotice.style.display = "block";
      uploadTokenNotice.innerHTML = "⚠️ <strong>KV Worker URL が必要です:</strong> 「クラウドストレージ接続設定」で、自分の KV Worker URL を保存してください。";
    } else if (!hasToken) {
      uploadTokenNotice.style.display = "block";
      uploadTokenNotice.innerHTML = "⚠️ <strong>投稿専用 API トークンが必要です:</strong> Worker に設定した <code>UPLOAD_TOKEN</code> を入力すると、URLコピー・curl例・Windows「送る」登録を利用できます。";
    } else if (!isUploadTokenVerified) {
      uploadTokenNotice.style.display = "block";
      uploadTokenNotice.innerHTML = "❌ <strong>トークンが Worker と一致していません:</strong> 入力されたトークンでは認証に失敗しました。Worker の <code>UPLOAD_TOKEN</code> と完全一致しているか確認してください。";
    } else {
      uploadTokenNotice.style.display = "none";
    }
  }

  const isReady = isUploadTokenVerified && hasEndpoint;
  if (copyUploadApiUrlBtn) copyUploadApiUrlBtn.disabled = !isReady;
  if (copyCurlCmdBtn) copyCurlCmdBtn.disabled = !isReady;
  if (downloadSendToBatBtn) downloadSendToBatBtn.disabled = !isReady;
  if (downloadSharexBtn) downloadSharexBtn.disabled = !isReady;
}

uploadStorageSelect?.addEventListener("change", () => {
  populateUploadReturnDomainSelect();
  updateDedicatedUploadApiUI();
});
uploadReturnDomainSelect?.addEventListener("change", updateDedicatedUploadApiUI);
r2DomainSelect?.addEventListener("change", () => {
  populateUploadReturnDomainSelect();
  updateDedicatedUploadApiUI();
});
kvWorkerUrl?.addEventListener("input", () => {
  updateDedicatedUploadApiUI();
  scheduleUploadTokenVerify(400);
});
if (uploadNamingRuleSelect) {
  uploadNamingRuleSelect.value = localStorage.getItem("uploadNamingRule") || "original";
  uploadNamingRuleSelect.addEventListener("change", () => {
    localStorage.setItem("uploadNamingRule", uploadNamingRuleSelect.value);
    updateDedicatedUploadApiUI();
  });
}
if (uploadApiTokenInput) {
  uploadApiTokenInput.value = localStorage.getItem("uploadApiToken") || "";
  uploadApiTokenInput.addEventListener("input", () => {
    const token = uploadApiTokenInput.value.trim();
    if (token) localStorage.setItem("uploadApiToken", token);
    else localStorage.removeItem("uploadApiToken");
    scheduleUploadTokenVerify(400);
  });
}

setTimeout(() => {
  populateUploadReturnDomainSelect();
  updateDedicatedUploadApiUI();
  scheduleUploadTokenVerify(200);
}, 250);

copyUploadApiUrlBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿専用 API トークンが未入力です。\nWorker に設定した UPLOAD_TOKEN を入力してください。");
    return;
  }
  const fullUrl = getDedicatedUploadFullUrl();
  await copyToClipboard(fullUrl, copyUploadApiUrlBtn, "📋 コピー完了!");
});

copyCurlCmdBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿専用 API トークンが未入力です。\nWorker に設定した UPLOAD_TOKEN を入力してください。");
    return;
  }
  const endpoint = getDedicatedUploadEndpoint();
  const selectedDomain = getSelectedUploadReturnDomain();
  const selectedStorage = getSelectedUploadStorage();
  const namingRule = uploadNamingRuleSelect?.value || "original";

  const url = new URL(endpoint);
  if (selectedStorage) {
    url.searchParams.set("storage", selectedStorage);
  }
  if (selectedDomain) {
    url.searchParams.set("domain", selectedDomain);
  }
  if (namingRule) {
    url.searchParams.set("naming", namingRule);
  }

  let curlCmd = `curl -X POST "${url.toString()}"`;
  curlCmd += ` \\\n  -H "Authorization: Bearer ${token}"`;
  curlCmd += ` \\\n  -H "X-Upload-Filename: image.webp"`;
  curlCmd += ` \\\n  -H "Content-Type: application/octet-stream"`;
  curlCmd += ` \\\n  --data-binary "@/path/to/image.webp"`;

  await copyToClipboard(curlCmd, copyCurlCmdBtn, "💻 コピー完了!");
});

downloadSendToBatBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿専用 API トークンが未入力です。Worker の UPLOAD_TOKEN を入力してから登録してください。");
    return;
  }
  if (!isUploadTokenVerified) {
    alert("⚠️ 投稿専用 API トークンが Worker と一致していません。正しい UPLOAD_TOKEN を入力してください。");
    return;
  }

  const dict = i18nDict[getAppLanguage()] || i18nDict.ja;
  const confirmed = await showCustomConfirm(
    dict.sendToSecurityConfirm || "この BAT ファイルには投稿専用トークンが平文で含まれます。共有しないでください。",
    dict.sendToSecurityTitle || "🔐 個人専用バッチを生成しますか？",
    dict.sendToSecurityProceed || "理解して生成",
    dict.btnCancel || "キャンセル",
  );
  if (!confirmed) return;

  const endpoint = getDedicatedUploadEndpoint();
  const selectedDomain = getSelectedUploadReturnDomain();
  const selectedStorage = getSelectedUploadStorage();
  const namingRule = uploadNamingRuleSelect?.value || "original";

  const url = new URL(endpoint);
  if (selectedStorage) {
    url.searchParams.set("storage", selectedStorage);
  }
  if (selectedDomain) {
    url.searchParams.set("domain", selectedDomain);
  }
  if (namingRule) {
    url.searchParams.set("naming", namingRule);
  }

  const endpointUrlStr = url.toString();
  const escapedToken = token.replace(/"/g, '`"');

  // ファイル名を「(選んだアドレス)にアップロード.bat」に命名
  let domainHost = "";
  try {
    const parsed = new URL(selectedDomain.startsWith("http") ? selectedDomain : `https://${selectedDomain}`);
    domainHost = parsed.hostname || selectedDomain;
  } catch (e) {
    domainHost = selectedDomain || "Cividge";
  }
  const storagePrefix = selectedStorage === "r2" ? "R2_" : "IPFS_";
  const batFileName = `${storagePrefix}${domainHost}にアップロード.bat`;

  const batContent = `<# :
@echo off
chcp 65001 >nul
set "BAT_PATH=%~f0"
set "BAT_ARGS="
:loop
if "%~1"=="" goto :endloop
if defined BAT_ARGS (set "BAT_ARGS=%BAT_ARGS%|||%~1") else (set "BAT_ARGS=%~1")
shift
goto :loop
:endloop
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$s=[System.IO.File]::ReadAllText($env:BAT_PATH, [System.Text.Encoding]::UTF8); & ([ScriptBlock]::Create($s))"
exit /b
#>

$endpoint = "${endpointUrlStr}"
$token = "${escapedToken}"
$batPath = $env:BAT_PATH
$rawArgs = $env:BAT_ARGS

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 1. 引数なし（ダブルクリック時）: SendTo フォルダへ自動登録
if (-not $rawArgs) {
    $sendtoDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::SendTo)
    $dest = Join-Path $sendtoDir "${batFileName}"
    
    try {
        Copy-Item -Path $batPath -Destination $dest -Force
        [System.Windows.Forms.MessageBox]::Show("【登録完了】\`n\`n✅ Windows の「送る」メニューに「${batFileName}」を登録しました！\`n\`n投稿先ストレージ: ${selectedStorage.ToUpper()}\`n返却配信アドレス: ${selectedDomain}\`n\`nエクスプローラーで画像や動画を右クリック ➜「送る」➜「${batFileName}」で即座に投稿・短縮URLコピーが可能です。\`n\`n※解除・削除したい場合: Win+R ➜ shell:sendto から本ファイルを削除してください。", "登録完了 - ${batFileName}", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    } catch {
        [System.Windows.Forms.MessageBox]::Show("⚠️ 登録に失敗しました: " + $_.Exception.Message, "エラー", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    }
    exit
}

# 2. 引数あり: アップロード処理
$files = $rawArgs -split '\\|\\|\\|'
$urls = @()
$errors = @()

foreach ($f in $files) {
    if (Test-Path $f -PathType Leaf) {
        $curlArgs = @('-s', '-X', 'POST')
        if ($token) {
            $curlArgs += @('-H', ('Authorization: Bearer ' + $token))
        }
        $fileName = [System.IO.Path]::GetFileName($f)
        $curlArgs += @('-H', ('X-Upload-Filename: ' + $fileName))
        $curlArgs += @('-H', 'Content-Type: application/octet-stream')
        $curlArgs += @('--data-binary', ('@' + $f), $endpoint)
        
        try {
            $raw = & curl.exe @curlArgs
            $json = $raw | ConvertFrom-Json
            if ($json.success -and $json.url) {
                $urls += $json.url
            } else {
                $err = if ($json.error) { $json.error } else { $raw }
                $errors += ([System.IO.Path]::GetFileName($f) + ': ' + $err)
            }
        } catch {
            $errors += ([System.IO.Path]::GetFileName($f) + ': ' + $_.Exception.Message)
        }
    }
}

if ($urls.Count -gt 0) {
    $clip = $urls -join [Environment]::NewLine
    [System.Windows.Forms.Clipboard]::SetText($clip)
    $notify = New-Object System.Windows.Forms.NotifyIcon
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $notify.Visible = $true
    $msg = if ($urls.Count -eq 1) { "URL (${selectedDomain}) をコピーしました！" } else { "$($urls.Count)件のURL (${selectedDomain}) をコピーしました！" }
    $notify.ShowBalloonTip(4000, "Cividge アップロード完了", $msg, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 2
    $notify.Dispose()
}

if ($errors.Count -gt 0) {
    $errMsg = $errors -join [Environment]::NewLine
    [System.Windows.Forms.MessageBox]::Show("一部またはすべてのアップロードに失敗しました:\`n" + $errMsg, "Cividge アップロードエラー", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
}
`;

  const crlfContent = "\uFEFF" + batContent.replace(/\r?\n/g, "\r\n");
  const blob = new Blob([crlfContent], { type: "application/bat;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = batFileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
});

downloadSharexBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿専用 API トークンが未入力です。Worker の UPLOAD_TOKEN を入力してからダウンロードしてください。");
    return;
  }
  if (!isUploadTokenVerified) {
    alert("⚠️ 投稿専用 API トークンが Worker と一致していません。正しい UPLOAD_TOKEN を入力してください。");
    return;
  }

  const dict = i18nDict[getAppLanguage()] || i18nDict.ja;
  const confirmed = await showCustomConfirm(
    dict.sharexSecurityConfirm || "この .sxcu ファイルには投稿専用の UPLOAD_TOKEN が平文で含まれます。自分の端末・アカウントだけで保管・使用してください。\n\nメール、チャット、Discord、Git リポジトリ、共有フォルダへ渡してはいけません。\n他人に渡すと、あなたのストレージに画像を勝手にアップロードされる危険があります。\n紛失・共有した場合は、Worker の UPLOAD_TOKEN を再発行してください。",
    dict.sharexSecurityTitle || "🔐 ShareX 設定ファイルを生成しますか？",
    dict.sharexSecurityProceed || "理解してダウンロード",
    dict.btnCancel || "キャンセル",
  );
  if (!confirmed) return;

  const endpoint = getDedicatedUploadEndpoint();
  const selectedDomain = getSelectedUploadReturnDomain();
  const selectedStorage = getSelectedUploadStorage();
  const namingRule = uploadNamingRuleSelect?.value || "original";

  if (!endpoint) {
    alert("⚠️ 投稿APIエンドポイントが未設定です。KV Worker URL を設定してください。");
    return;
  }

  const url = new URL(endpoint);
  if (selectedStorage) {
    url.searchParams.set("storage", selectedStorage);
  }
  if (selectedDomain) {
    url.searchParams.set("domain", selectedDomain);
  }
  if (namingRule) {
    url.searchParams.set("naming", namingRule);
  }

  let domainHost = "";
  try {
    const parsed = new URL(selectedDomain.startsWith("http") ? selectedDomain : `https://${selectedDomain}`);
    domainHost = parsed.hostname || selectedDomain;
  } catch (e) {
    domainHost = selectedDomain || "Cividge";
  }
  const storageLabel = selectedStorage === "r2" ? "R2" : "Filebase";

  const sxcuConfig = {
    Version: "15.0.0",
    Name: `Cividge (${storageLabel} - ${domainHost} - ${namingRule})`,
    DestinationType: "ImageUploader, TextUploader, FileUploader",
    RequestMethod: "POST",
    RequestURL: url.toString(),
    Headers: {
      Authorization: `Bearer ${token}`,
    },
    Body: "MultipartFormData",
    FileFormName: "file",
    URL: "{json:url}",
    ErrorMessage: "{json:error}",
  };

  const jsonString = JSON.stringify(sxcuConfig, null, 2);
  const blob = new Blob([jsonString], { type: "application/json;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = `Cividge_${storageLabel}_${domainHost}_${namingRule}.sxcu`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 10000);
});

// 📱 スマホ表示時に設定アコーディオン群を Civitai パネル直下へ移動するレスポンシブ制御
function setupResponsiveSettingsLayout() {
  const settingsContainer = document.getElementById("allSettingsAccordionsContainer") || document.getElementById("cfSettingsContainer");
  const desktopSlot = document.getElementById("desktopSettingsSlot");
  const mobileSlot = document.getElementById("mobileSettingsSlot");
  const mobileBody = mobileSlot ? mobileSlot.querySelector(".mobile-settings-body") : null;
  if (!settingsContainer || !desktopSlot || !mobileBody) return;

  const mql = window.matchMedia("(max-width: 960px)");
  const updateLayout = (matches) => {
    if (matches) {
      if (!mobileBody.contains(settingsContainer)) {
        mobileBody.appendChild(settingsContainer);
      }
    } else {
      if (!desktopSlot.contains(settingsContainer)) {
        desktopSlot.appendChild(settingsContainer);
      }
    }
  };

  try {
    mql.addEventListener("change", (e) => updateLayout(e.matches));
  } catch (_) {
    mql.addListener((e) => updateLayout(e.matches));
  }
  updateLayout(mql.matches);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupResponsiveSettingsLayout);
} else {
  setupResponsiveSettingsLayout();
}

// 🪦 起動5秒後にバックグラウンドで24時間経過判定を行い、必要時のみ低優先度で墓標を定期回収
window.addEventListener("load", () => {
  setTimeout(() => {
    try {
      const s3 = getS3Client(activeStorageTab);
      const bucketName = getBucketName(activeStorageTab);
      maybeDrainTombstonesDaily(s3, bucketName);
    } catch (_) {}
  }, 5000);
});

