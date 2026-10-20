import { createR2Content } from "./storage/r2-content.js";
import { escapeHtml, safeHttpUrl, safeMediaUrl, renderKuboStatus, quotePosixShell, quotePowerShell } from "./security/presentation.js";
import { encryptConfiguration, decryptConfiguration, encryptedConfigurationUrl } from "./security/configuration-export.js";
import { redactSecrets, tokenDigest, safeConsole } from "./security/diagnostics.js";
import { createManagedController } from "./managed/managed-controller.js";
import { observeMissingFilebaseCids } from "./managed/filebase-cid-observation.js";
import { createStorageCapacityExecution } from "./storage/capacity-execution.js";
import { createFilebaseContent } from "./storage/filebase-content.js";
import { createImageConverter } from "./upload/conversion.js";
import { createUploadState } from "./upload/upload-state.js";
import { createManagedPreflight } from "./upload/managed-preflight.js";
import { createUploadOrchestrator } from "./upload/upload-orchestrator.js";
import { createVideoThumbnailRegistration } from "./upload/video-thumbnail.js";
import { createVideoPreviewCache } from "./media/video-preview-cache.js";
import { showManagedVideoPreview } from "./media/managed-video-preview.js";
import { attachJxlPreviewFallback } from "./media/jxl-preview.js";
import { recordUploadedWorkflow } from "./upload/workflow-cache.js";
import { localEntryIdentity, getRetiredLocalEntries, setLocalEntryRetired, saveLedgerToLocalStorage, loadLedgerFromLocalStorage, loadDisplayCache } from "./managed/managed-cache.js";
import { createWorkerClient } from "./api/worker-client.js";
import { createFilenameTools } from "./upload/filename-policy.js";
import { createUploadDestinationGuard } from "./ui/upload-destination.js";
import { createStorageConnections } from "./storage/connections.js";
import { i18nDict } from "./ui/i18n.js";
import { insertFilenamePatternToken } from "./ui/filename-pattern-input.js";
import { canUseCivitaiPostIntent, projectedFinalUploadMedia } from "./ui/civitai-capability.js";
import { detectComfyMetadata } from "./media/metadata.js";
import QRCode from "qrcode";
import * as fflate from "fflate";
import {
  extensions,
  isWorkerDerivedR2Key,
} from "./media-utils.js";
import { createKuboClient } from "./kubo-client.js";
import { createKuboPlacementApplication, KUBO_PLACEMENT_STATE } from "./kubo-placement.js";
import { GATEWAY_REGION_LABELS, gatewayRegionLabel, gatewayEditorSummary, normalizeGatewayEndpoint, normalizeGatewaySettings } from "./ipfs-gateway.js";
import { isDriftRetired, observeDrift } from "./drift-policy.js";
import { exceedsUploadLimit } from "./upload-limit.js";
import { matchesSelectedRelayProbe } from "./relay-compat.js";
import { canonicalFilenamePolicy, canonicalConversionMode, conversionModeToMime, isConversionModeEnabled, fetchManagedFiles } from "./view-policy.js";

import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";

// --- アプリケーション状態 ---
const uploadState = createUploadState();
// Cached managed rows render during module startup, before upload wiring below.
// The preview resolver must already have its cache at that point.
const videoPreviewCache = createVideoPreviewCache();

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
const enableRenameCheck = document.querySelector("#enableRenameCheck");
const enableTtlCheck = document.querySelector("#enableTtlCheck");
const tempTtlSelect = document.querySelector("#tempTtlSelect");
const formatSelect = document.querySelector("#formatSelect");
const qualityRange = document.querySelector("#qualityRange");
const qualityOutput = document.querySelector("#qualityOutput");
const renamePattern = document.querySelector("#renamePattern");
const clearRenamePattern = document.querySelector("#clearRenamePattern");
// Presentation-only choices for turning a checkbox back on. Neither value is
// persisted separately from the canonical conversion/filename setting.
let lastUiConversionMode = "webp";
let lastUiFilenamePolicy = "{random:6}";
const enableZipCheck = document.querySelector("#enableZipCheck");
const { createOutputName, truncateFilename } = createFilenameTools({ isConversionEnabled, getFilenamePolicy: () => canonicalFilenamePolicy(renamePattern?.value) });
const { convertImage } = createImageConverter({ getConversionMode, isConversionEnabled, qualityRange, createOutputName });

// アクションボタン
const convertDownloadButton = document.querySelector("#convertDownloadButton");
const uploadButton = document.querySelector("#uploadButton");
const uploadProviderSelect = document.querySelector("#uploadProviderSelect");
let uploadUiLocked = false;
let uploadDestinationBusy = false; // transient interaction guard, never persisted
const quickDomainSelect = document.querySelector("#quickDomainSelect");
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
const publicGatewayMode = document.querySelector("#publicGatewayMode");
const publicGatewaySelected = document.querySelector("#publicGatewaySelected");
const publicGatewayUrl = document.querySelector("#publicGatewayUrl");
const publicGatewayRegion = document.querySelector("#publicGatewayRegion");
const publicGatewayAdd = document.querySelector("#publicGatewayAdd");
const publicGatewayList = document.querySelector("#publicGatewayList");
const publicGatewayLoad = document.querySelector("#publicGatewayLoad");
const publicGatewaySave = document.querySelector("#publicGatewaySave");
const publicGatewayStatus = document.querySelector("#publicGatewayStatus");

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
const storageTabAll = document.querySelector("#storageTabAll");
const storageTabR2 = document.querySelector("#storageTabR2");
const storageTabFilebase = document.querySelector("#storageTabFilebase");

const r2FileList = document.querySelector("#r2FileList");
const reloadR2FilesButton = document.querySelector("#reloadR2FilesButton");
const deleteSelectedR2FilesButton = document.querySelector("#deleteSelectedR2FilesButton");
const r2PaginationControls = document.querySelector("#r2PaginationControls");
const r2PrevPageBtn = document.querySelector("#r2PrevPageBtn");
const r2NextPageBtn = document.querySelector("#r2NextPageBtn");
const r2PageInfo = document.querySelector("#r2PageInfo");
const r2PerPageSelect = document.querySelector("#r2PerPageSelect");

const managedController = createManagedController({ loadDisplayCache, loadLedgerFromLocalStorage,
  saveLedgerToLocalStorage, setLocalEntryRetired,
  initialProvider: localStorage.getItem("activeStorageTab") === "filebase" ? "filebase" : "r2",
  initialPerPage: parseInt(localStorage.getItem("storagePerPage") || "10", 10) });
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
const qrContainer = document.querySelector("#qrContainer");
const qrStatus = document.querySelector("#qrStatus");
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
  const storageConfigured = managedController.getView() === "all"
    ? (isR2Configured() || isFilebaseConfigured() || hasAdminAccess())
    : (managedController.getActiveProvider() === "filebase" ? isFilebaseConfigured() : isR2Configured());
  if (storageConfigured) {
    renderCurrentStoragePage();
  } else {
    renderStorageOnboardingCard();
  }
  loadTemplates(templateSelect ? templateSelect.value : "");
  renderGatewaySettings();
  render();
}

langSelect?.addEventListener("change", (e) => {
  setAppLanguage(e.target.value);
});

const { isR2Configured, isFilebaseConfigured, getBucketName, getS3Client, safeDeleteS3Objects } = createStorageConnections({ r2AccountId, r2BucketName, r2AccessKeyId, r2SecretAccessKey, filebaseBucket, filebaseApiKey, filebaseSecretKey, getSelectedR2Domain });

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
    safeConsole.error("CORS設定失敗:", err);
    alert(`❌ CORS設定の適用に失敗しました:\n${redactSecrets(err.message)}`);
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
    safeConsole.debug("S3 direct thumbnail fallback failed:", e);
  }
  const ext = (s3Key || key || "").split('.').pop().toLowerCase();
  if (imgElement.parentElement) {
    imgElement.parentElement.innerHTML = `<div class="thumb format-badge">${escapeHtml(ext.toUpperCase() || 'IMG')}</div>`;
  }
  return false;
}
// A failed preview is a presentation event, not a render-time observation.
r2FileList?.addEventListener("error", event => {
  const image = event.target;
  if (!image?.matches?.("img.thumb") || image.dataset.fallbackAttempted === "1") return;
  const card = image.closest(".result-item");
  if (!card || !/\.(jpe?g|png|webp|gif|avif)$/i.test(card.dataset.displayname || "")) return;
  image.dataset.fallbackAttempted = "1";
  void loadFallbackImageFromS3(image, card.dataset.key, card.dataset.s3key, card.dataset.provider);
}, true);
// --- 🛡️ KV台帳エンドポイント ＆ APIトークン（BYOC・責任分離） ---
function getCustomKvWorkerUrl() {
  const rawUrl = (localStorage.getItem("kvWorkerUrl") || kvWorkerUrl?.value || "").trim().replace(/\/$/, "");
  if (!rawUrl) return "";
  // Workerのホスト名だけが入力されても、fetchがローカル相対パスとして解釈しないようにする。
  return safeHttpUrl(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`, { endpoint: true }).replace(/\/$/, "");
}

function getKvApiEndpoint() {
  const customUrl = getCustomKvWorkerUrl();
  if (customUrl) {
    if (customUrl.endsWith("/api/cividge-kv")) {
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
    // 末尾の canonical control-plane path を除去して配信オリジンを取得
    return customUrl.replace(/\/api\/cividge-kv\/?$/, "");
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

// [INV-CORE-006] ホスト名抽出・KVキー生成ヘルパー:
// すべてのKVレコードを `host:filename` という均一なキー構造にするための共通関数。
// 「コピー元（単体キー）」と「エイリアス（ドメイン付きキー）」の非対称性を根絶する。
function extractCleanHost(domainOrUrl) {
  return String(domainOrUrl || "").trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0];
}
function buildKvKey(domainOrUrl, filename) {
  const host = extractCleanHost(domainOrUrl);
  return host ? `${host}:${filename}` : filename;
}

async function registerKvCid(key, cid = "", size = 0, mime = "", s3Key = "", password = "", blobOrBytes = null, ttl = 0, expiresAt = null, unpinned = false, kuboStatus = null, allowedHost = null, overwriteAllowedHost = false, width = null, height = null, civitaiTemporary = undefined, contentCid = null, backend = null, mutationOptions = {}) {
  if (!key) return;
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();

  // 🛡️ KV連携が有効でない（トークンも独自Workerもない）場合、中央KVへの登録はスキップする。
  if (!hasAdminAccess()) {
    safeConsole.log(`[責任分離] 一般ユーザーモードのため、中央KVへの登録をスキップしました: ${key}`);
    return;
  }
  try {
    const payload = { key, cid: cid || "", size, mime, s3Key: s3Key || key };
    if (mutationOptions.createOnly) payload.createOnly = true;
    if (mutationOptions.confirmPlacementPresent) payload.confirmPlacementPresent = true;
    if (mutationOptions.policyChange) payload.policyChange = true;
    if (mutationOptions.cachePolicy) payload.cachePolicy = mutationOptions.cachePolicy;
    if (mutationOptions.uploadAttemptId) payload.uploadAttemptId = mutationOptions.uploadAttemptId;
    if (mutationOptions.objectId) payload.objectId = mutationOptions.objectId;
    if (mutationOptions.bucket) payload.bucket = mutationOptions.bucket;
    if (contentCid) payload.contentCid = contentCid;
    if (backend) payload.backend = backend;
    // Civitai 転送専用の短期置き場だけを、次回の明示更新で回収できるようにする。
    // undefined は既存レコードの印を維持するため、通常のメタデータ更新では送らない。
    if (civitaiTemporary !== undefined) payload.civitaiTemporary = Boolean(civitaiTemporary);
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
      } else if (expiresAt && Number(expiresAt) > 0) {
        // 保存先の状態更新時は継続時間を復元できない場合がある。絶対期限を優先する。
        payload.expiresAt = Number(expiresAt);
      } else {
        // ⏳ 0 または無期限化: KV側にも明示的に解除を指示
        payload.ttl = 0;
        payload.expiresAt = 0;
        payload.clearTtl = true;
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
      if (errData.code === "CID_CONFLICT" || errData.code === "LINK_OBJECT_CONFLICT" || errData.code === "OBJECT_REF_CONFLICT") {
        throw new Error(`同名ファイル「${key}」が別の内容で既に登録されています。ファイル名を変更してください。`);
      }
      if (errData.code === "RESERVATION_CONFLICT") throw new Error(`このLinkでは別のアップロードが未完了です。保存先の確認・再開が必要です: ${key}`);
      if (errData.code === "LIFECYCLE_CONFLICT") throw new Error(`Object/Placementの状態遷移が進行中です。後で再試行してください: ${key}`);
      throw new Error(redactSecrets(errData.error || `KV登録エラー (${res.status})`));
    }
    return true;
  } catch (e) {
    safeConsole.warn("Failed to register CID to KV:", e);
    throw e;
  }
}

function getLifecycleApiEndpoint() {
  const worker = getCustomKvWorkerUrl()
    .replace(/\/api\/cividge-kv\/?$/, "")
    .replace(/\/$/, "");
  return worker ? `${worker}/api/lifecycle` : "";
}

async function objectIdForManagedLink(linkKey) {
  if (!linkKey?.includes(":")) throw new Error("Canonical Link key is required to resolve ObjectId");
  const response = await linkBindingRequest({ action: "inspect", linkKey });
  const objectId = response?.binding?.status === "BOUND" ? response.binding.objectRef : null;
  if (!/^sha256:[0-9a-f]{64}$/.test(objectId || "")) throw new Error("Managed ObjectId is unavailable");
  return objectId;
}

// Provider/CID only select a visible Link candidate. They never construct an
// ObjectId; the LinkBinding authority resolves the exact managed Object.
async function getObjectRefForUi(provider, s3Key, cid) {
  const normalized = normalizeDeliveryProvider(provider);
  const candidates = [...(managedController.getContents() || []), ...(loadLedgerFromLocalStorage(normalized) || [])];
  const item = candidates.find(entry => entry.entryKind === "link" &&
    entry.storageProvider === normalized &&
    (entry.rawKey === s3Key || entry.s3Key === s3Key || entry.metadata?.s3Key === s3Key ||
      (cid && (entry.cid === cid || entry.contentCid === cid))));
  const linkKey = s3Key?.includes(":") ? s3Key : item?.rawKey;
  return objectIdForManagedLink(linkKey);
}

const { lifecycleRequest, linkBindingRequest, gatewayConfigRequest } = createWorkerClient({ hasAdminAccess, getLifecycleApiEndpoint, getCustomKvWorkerUrl, getAdminApiToken });

// The browser can execute Filebase/Kubo capabilities, but never decides that an
// Object is unreferenced. It claims a task authorized by the Durable Object and
// reports the outcome for retryable bookkeeping.
async function executeAuthorizedBrowserReleaseTasks(objectRef, tasks = []) {
  for (const task of tasks) {
    if (task.operation !== "release") continue;
    const claimed = await lifecycleRequest({ action: "claimPlacement", objectRef, placement: task.kind, operation: "release" });
    const claim = claimed.claim;
    try {
      if (task.kind === "filebase") {
        const s3 = getS3Client("filebase");
        const bucket = getBucketName("filebase");
        if (!s3 || !bucket) throw new Error("Filebase is not configured in this browser");
        if (claim.locator.bucket !== bucket) throw new Error("Filebase Placement bucket does not match this browser's configured bucket");
        await safeDeleteS3Objects(s3, bucket, [claim.locator.key]);
      } else if (task.kind === "kubo") {
        const result = await unpinFromKubo(claim.locator.cid);
        if (!result?.success) throw new Error(result?.error || "Kubo unpin failed");
      } else {
        throw new Error(`Unsupported browser placement: ${task.kind}`);
      }
      await lifecycleRequest({
        action: "reportPlacement",
        objectRef,
        placement: task.kind,
        claimId: claim.claimId,
        generation: claim.generation,
        operation: "release",
        outcome: "released",
      });
    } catch (error) {
      await lifecycleRequest({
        action: "reportPlacement",
        objectRef,
        placement: task.kind,
        claimId: claim.claimId,
        generation: claim.generation,
        operation: "release",
        outcome: "retryable",
        error: error.message,
      }).catch(() => {});
      throw error;
    }
  }
}

async function ensureAuthoritativeKuboPin(objectRef, cid, { requestPin = true } = {}) {
  await kuboPlacementApplication.acquire({ objectRef, cid, existingOnly: !requestPin });
  return true;
}

async function requestAuthorizedRelease(objectRef, reason, placement = null) {
  if (!objectRef || !hasAdminAccess()) return null;
  const action = placement ? "requestPlacementRelease" : "requestRelease";
  const result = await lifecycleRequest({ action, objectRef, reason, ...(placement ? { placement } : {}) });
  if (!placement && Array.isArray(result?.lifecycle?.links) && result.lifecycle.links.length === 0) {
    void videoPreviewCache.remove(objectRef).catch(() => {});
  }
  if (result?.browserTasks?.length) await executeAuthorizedBrowserReleaseTasks(objectRef, result.browserTasks);
  return result;
}

async function deleteKvCid(key, expectedGeneration = null) {
  if (!key) return;
  if (!hasAdminAccess()) {
    safeConsole.log(`[責任分離] 一般ユーザーモードのため、KV削除をスキップしました: ${key}`);
    return;
  }
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();
  const sep = endpoint.includes("?") ? "&" : "?";
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const remove = async (objectRef = "") => {
    const retry = objectRef ? `&objectRef=${encodeURIComponent(objectRef)}` : "";
    const generation = expectedGeneration == null ? "" : `&generation=${encodeURIComponent(expectedGeneration)}`;
    const response = await fetch(`${endpoint}${sep}key=${encodeURIComponent(key)}${retry}${generation}`, {
      method: "DELETE",
      headers,
    });
    const result = await response.json().catch(() => ({}));
    return { response, result };
  };
  let attempt = await remove();
  if (!attempt.response.ok && attempt.result.retryable && attempt.result.objectRef) {
    attempt = await remove(attempt.result.objectRef);
  }
  if (!attempt.response.ok) {
    throw new Error(redactSecrets(attempt.result.error || `KV deletion error (${attempt.response.status})`));
  }
  removeCommittedLinkFromUi(key);
  return attempt.result;
}

// --- 🏠 自宅 Kubo (IPFSノード) RPC ヘルパー ---
function getKuboRpcEndpoint() {
  const custom = (localStorage.getItem("kuboRpcUrl") || kuboRpcUrl?.value || "").trim().replace(/\/$/, "");
  if (!custom) return "http://127.0.0.1:5001";
  const endpoint = safeHttpUrl(custom, { endpoint: true });
  if (!endpoint) throw new Error("Kubo RPC URL must be HTTP(S), without credentials, query or hash");
  return endpoint.replace(/\/$/, "");
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
const kuboPlacementApplication = createKuboPlacementApplication({
  lifecycleRequest,
  checkPinned: checkKuboPinned,
  requestPin: pinToKubo,
});

// Editor draft only. The canonical runtime configuration is stored by the
// Delivery Worker; localStorage is not a GatewayConfig authority.
let gatewayDraft = normalizeGatewaySettings({});
let gatewayDraftSaved = false;

function updateGatewayDraft(settings) {
  gatewayDraft = normalizeGatewaySettings(settings);
  gatewayDraftSaved = false;
  renderGatewaySettings();
}

function renderGatewaySettings() {
  if (!publicGatewayMode || !publicGatewaySelected || !publicGatewayList) return;
  const settings = gatewayDraft;
  const isEn = getAppLanguage() === "en";
  const summary = document.querySelector("#publicGatewaySummary");
  if (summary) summary.textContent = gatewayEditorSummary(settings, gatewayDraftSaved, getAppLanguage());
  if (publicGatewayStatus) publicGatewayStatus.textContent = gatewayDraftSaved
    ? (isEn ? "Worker setting loaded/saved. Changes may take time to reach all regions." : "Worker設定を読込・保存済み。全地域への反映には時間がかかる場合があります。")
    : (isEn ? "Draft only. Save to apply to delivery." : "編集中。配信へ反映するには保存してください。");
  publicGatewayMode.value = settings.mode;
  const addingRegion = publicGatewayRegion.value || "global";
  publicGatewayRegion.replaceChildren(...Object.keys(GATEWAY_REGION_LABELS).map(region =>
    new Option(gatewayRegionLabel(region, getAppLanguage()), region)));
  publicGatewayRegion.value = addingRegion;
  publicGatewaySelected.replaceChildren();
  for (const endpoint of settings.endpoints) {
    const option = new Option(`${gatewayRegionLabel(endpoint.region, getAppLanguage())} · ${endpoint.url}${endpoint.enabled ? "" : " (off)"}`, endpoint.url);
    option.disabled = !endpoint.enabled;
    publicGatewaySelected.add(option);
  }
  publicGatewaySelected.value = settings.selectedUrl;
  publicGatewaySelected.disabled = settings.mode !== "manual" || !settings.endpoints.some(item => item.enabled);

  publicGatewayList.replaceChildren();
  if (!settings.endpoints.length) {
    const empty = document.createElement("span");
    empty.textContent = isEn ? "No public Gateway is configured." : "公開Gatewayが設定されていません。";
    publicGatewayList.append(empty);
  }
  for (const endpoint of settings.endpoints) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:7px;flex-wrap:wrap";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = endpoint.enabled;
    toggle.setAttribute("aria-label", `${endpoint.url} enabled`);
    toggle.addEventListener("change", () => {
      const current = structuredClone(gatewayDraft);
      const entry = current.endpoints.find(item => item.url === endpoint.url);
      if (entry) entry.enabled = toggle.checked;
      if (!current.endpoints.some(item => item.enabled && item.url === current.selectedUrl)) {
        current.selectedUrl = current.endpoints.find(item => item.enabled)?.url || "";
      }
      updateGatewayDraft(current);
    });
    const label = document.createElement("span");
    label.textContent = endpoint.url;
    label.style.cssText = "overflow-wrap:anywhere;flex:1";
    const regionSelect = document.createElement("select");
    regionSelect.setAttribute("aria-label", `${endpoint.url} region`);
    for (const region of Object.keys(GATEWAY_REGION_LABELS)) {
      regionSelect.add(new Option(gatewayRegionLabel(region, getAppLanguage()), region));
    }
    regionSelect.value = endpoint.region;
    regionSelect.addEventListener("change", () => {
      const current = structuredClone(gatewayDraft);
      current.endpoints.find(item => item.url === endpoint.url).region = regionSelect.value;
      updateGatewayDraft(current);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost-button";
    remove.textContent = isEn ? "Remove" : "削除";
    remove.addEventListener("click", () => {
      const current = structuredClone(gatewayDraft);
      current.endpoints = current.endpoints.filter(item => item.url !== endpoint.url);
      if (current.selectedUrl === endpoint.url) current.selectedUrl = current.endpoints.find(item => item.enabled)?.url || "";
      updateGatewayDraft(current);
    });
    row.append(toggle, label, regionSelect, remove);
    publicGatewayList.append(row);
  }
}

publicGatewayMode?.addEventListener("change", () => {
  const settings = structuredClone(gatewayDraft);
  settings.mode = publicGatewayMode.value;
  if (settings.mode === "manual" && !settings.selectedUrl) settings.selectedUrl = settings.endpoints.find(item => item.enabled)?.url || "";
  updateGatewayDraft(settings);
});
publicGatewaySelected?.addEventListener("change", () => {
  const settings = structuredClone(gatewayDraft);
  settings.selectedUrl = publicGatewaySelected.value;
  updateGatewayDraft(settings);
});
publicGatewayAdd?.addEventListener("click", async () => {
  try {
    const endpoint = normalizeGatewayEndpoint(publicGatewayUrl.value, publicGatewayRegion.value);
    const settings = structuredClone(gatewayDraft);
    if (settings.endpoints.some(item => item.url === endpoint.url)) throw new Error("Gateway is already registered");
    settings.endpoints.push(endpoint);
    if (!settings.selectedUrl) settings.selectedUrl = endpoint.url;
    updateGatewayDraft(settings);
    publicGatewayUrl.value = "";
  } catch (error) {
    await showCustomAlert(error.message, "IPFS Public Gateway");
  }
});

publicGatewayLoad?.addEventListener("click", async () => {
  try {
    gatewayDraft = normalizeGatewaySettings(await gatewayConfigRequest("GET"));
    gatewayDraftSaved = true;
    renderGatewaySettings();
  } catch (error) {
    await showCustomAlert(error.message, "IPFS Public Gateway");
  }
});
publicGatewaySave?.addEventListener("click", async () => {
  try {
    gatewayDraft = normalizeGatewaySettings(await gatewayConfigRequest("PUT", gatewayDraft));
    gatewayDraftSaved = true;
    renderGatewaySettings();
  } catch (error) {
    await showCustomAlert(error.message, "IPFS Public Gateway");
  }
});

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


// 🚀 [INV-CORE-005] Local-First 台帳キャッシュ管理ヘルパー群
// 操作（追加・削除・リネーム・設定変更）時に手元の台帳キャッシュと localStorage を即時差分更新し、
// サーバーへの再フェッチ通信（kv.list / ListObjects）を完全ゼロ化する。

function recalculateStorageUsage(provider) {
  const isFilebase = provider === "filebase";
  const countedKeys = new Set();
  let uniqueTotalSize = 0;
  for (const c of (managedController.getContents() || [])) {
    if (c.storageProvider !== provider || !c.isFromS3) continue;
    const eKey = isFilebase ? (c.cid || getStoredIpfsCid(c.Key) || c.s3Key || c.Key) : (c.s3Key || c.Key);
    if (eKey && countedKeys.has(eKey)) continue;
    if (eKey) countedKeys.add(eKey);
    uniqueTotalSize += (c.Size || c.size || 0);
  }
  managedController.setTotalSize(uniqueTotalSize);
  updateStorageUsageUI();
}

function removeItemsFromLocalLedger(provider, keysToRemove, { purgeOriginAlso = false } = {}) {
  if (!managedController.removeLocalItems(provider, keysToRemove, { purgeOriginAlso })) return;
  recalculateStorageUsage(provider);
  renderCurrentStoragePage();
}

function removeCommittedLinkFromUi(linkKey) {
  // Invalidate every storage response that started before the authoritative
  // delete committed. Neither it nor the persisted UI cache may re-show this
  // generation; a later explicit upload can add a new Link normally.
  paletteFiles = managedController.applyCommittedDelete(linkKey, paletteFiles);
  renderUrlPalette();
  recalculateStorageUsage(managedController.getActiveProvider());
  renderCurrentStoragePage();
  updateSelectedR2ActionButtonsState();
}

function retireManagedEntry(provider, item) {
  if (managedController.retireLocal(provider, item)) {
    recalculateStorageUsage(provider);
    renderCurrentStoragePage();
  }
}

function addOrUpdateLocalLedgerItem(provider, item) {
  if (!managedController.upsert(provider, item)) return;
  recalculateStorageUsage(provider);
  renderCurrentStoragePage();
}


async function fetchKvFiles() {
  // 🛡️ KV台帳連携が有効でない場合、一覧取得はスキップ（相乗り・漏洩防止）
  if (!hasAdminAccess()) {
    return [];
  }
  const token = getAdminApiToken();
  const endpoint = getKvApiEndpoint();
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetchManagedFiles(fetch, endpoint, headers);
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
    safeConsole.warn("Failed to fetch KV record:", e);
    return null;
  }
}

function getR2DomainList(provider = managedController.getActiveProvider()) {
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
  return [...new Set(list.map(d => normalizeHttpsOrigin(d)).filter(Boolean))];
}

function saveR2DomainList(list, provider = managedController.getActiveProvider()) {
  const key = normalizeDeliveryProvider(provider) === "filebase" ? "filebaseDomainList" : "r2DomainList";
  localStorage.setItem(key, JSON.stringify(list.map(normalizeHttpsOrigin).filter(Boolean)));
}

function getSelectedR2Domain(provider = managedController.getActiveProvider()) {
  const storageProvider = normalizeDeliveryProvider(provider);
  const list = getR2DomainList(storageProvider);
  const selectedKey = storageProvider === "filebase" ? "filebaseSelectedDomain" : "r2SelectedDomain";
  const saved = (localStorage.getItem(selectedKey) || "").trim().replace(/\/$/, "");
  if (saved && list.includes(saved)) {
    return saved;
  }
  return list.length > 0 ? list[0] : "";
}

function setSelectedR2Domain(domain, provider = managedController.getActiveProvider()) {
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

const { getIpfsCidFromS3Response, calculateFilebaseCid, findFilebaseObjectByCid } = createFilebaseContent({ isValidIpfsCid, getStoredIpfsCid, storeIpfsCid, getManagedContents: () => managedController.getContents() || loadLedgerFromLocalStorage("filebase") || [] });

const { calculateContentHash, getStoredR2Hash, storeR2Hash, deleteR2Hash, findR2ObjectByHash } = createR2Content({ getStoredIpfsCid, getManagedContents: () => managedController.getContents() || loadLedgerFromLocalStorage("r2") || [] });

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

function getPublicDeliveryBase(provider = managedController.getActiveProvider(), canonicalBase = "") {
  const storageProvider = normalizeDeliveryProvider(provider);
  const canonical = normalizeHttpsOrigin(canonicalBase || getSelectedR2Domain(storageProvider));
  return canonical || (typeof window !== "undefined" ? window.location.origin.replace(/\/$/, "") : "");
}

function getPublicDeliveryUrl(name, provider = managedController.getActiveProvider(), canonicalBase = "") {
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

// 🌐 各ファイルカード専用の固定配信ドメイン管理（プルダウン変更や他ファイル操作で絶対に釣られない完全独立）
function getFileStoredDomain(itemKey, itemDisplayName, rawAllowedHost) {
  // 1. rawKey に host:filename があればそのホストを絶対優先
  if (itemKey && itemKey.indexOf(":") > 0 && !itemKey.startsWith("blob_")) {
    const host = itemKey.split(":")[0].trim();
    if (host) return host.startsWith("http") ? host : `https://${host}`;
  }
  // 2. メタデータの allowedHost / d があれば絶対優先
  if (rawAllowedHost) {
    const host = rawAllowedHost.split(",")[0].trim();
    if (host) return host.startsWith("http") ? host : `https://${host}`;
  }
  // 3. ローカルに保存されている各カード固有キー（itemKey）の固定ドメイン
  try {
    const map = JSON.parse(localStorage.getItem("fileDomainMap") || "{}");
    if (itemKey && map[itemKey]) return map[itemKey];
  } catch (e) {}

  // 4. メタデータも固有キーも存在しない未設定アイテムのみ、現在選択されている配信ドメインを適用
  const current = getSelectedR2Domain();
  if (current) {
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
  const uploadProvider = uploadProviderSelect?.value || "r2";
  populateSelect(quickDomainSelect, uploadProvider === "filebase" ? filebaseDomains : r2Domains,
    uploadProvider === "filebase" ? selectedFilebaseDomain : selectedR2Domain,
    isEnglish ? "-- Configure a delivery domain --" : "-- 配信ドメインを設定してください --");

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

  if (uploadButton) uploadButton.disabled = uploadUiLocked || !uploadState.getFiles().length;

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
    safeConsole.debug("Civitai unread check skipped:", err);
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
    safeConsole.debug("Civitai WF check skipped:", err);
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
  const hearts = Math.max(0, Number(stats.heartCount) || 0);
  const likes = Math.max(0, Number(stats.likeCount) || 0);
  const laughs = Math.max(0, Number(stats.laughCount) || 0);
  const cries = Math.max(0, Number(stats.cryCount) || 0);
  const comments = Math.max(0, Number(stats.commentCount) || 0);
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
      const directUrl = safeHttpUrl(item.url);
      if (!directUrl) return;
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
      const civitaiPostPageUrl = `https://civitai.com/images/${encodeURIComponent(String(item.id))}`;

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
        ? `<button type="button" class="ghost-button civitai-prompt-btn" data-id="${escapeHtml(String(item.id))}" style="height: 30px; font-size: 11px; padding: 0 8px; color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); display: inline-flex; align-items: center; gap: 3px;" title="生成プロンプトをコピー">📝 ${escapeHtml(dict.civitaiPrompt || "プロンプト")}</button>`
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
              <span class="civitai-wf-badge-placeholder" data-id="${escapeHtml(String(item.id))}"></span>
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
    safeConsole.error("Civitai gallery fetch error:", err);
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

  const savedEnableZip = localStorage.getItem("enableZip");
  if (savedEnableZip !== null && enableZipCheck) {
    enableZipCheck.checked = savedEnableZip === "true";
  }

  const savedFormat = localStorage.getItem("formatSelect");
  if (formatSelect) commitConversionMode(savedFormat);

  const savedQuality = localStorage.getItem("qualityRange");
  if (savedQuality) {
    if (qualityRange) qualityRange.value = savedQuality;
    if (qualityOutput) qualityOutput.textContent = savedQuality;
  }

  const savedRename = localStorage.getItem("renamePattern");
  if (renamePattern) commitFilenamePolicy(savedRename);

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

  payload.fmt = getConversionMode();
  payload.pat = canonicalFilenamePolicy(renamePattern?.value);

  return payload;
}

function applyAppImportPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const stringFields = ["sp", "a", "b", "k", "s", "p", "d", "ds", "fds", "fb", "fk", "fs", "ku", "kv", "kt", "cu", "fmt", "pat"];
  if (stringFields.some(key => payload[key] !== undefined && typeof payload[key] !== "string")) return false;
  if (["dl", "fdl", "cul"].some(key => payload[key] !== undefined && (!Array.isArray(payload[key]) || payload[key].some(value => typeof value !== "string")))) return false;
  if (["kv", "ku"].some(key => payload[key] && !safeHttpUrl(payload[key], { endpoint: true }))) return false;

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
    if (!payload.kt && payload.kv !== localStorage.getItem("kvWorkerUrl")) {
      localStorage.removeItem("adminApiToken");
      if (adminApiToken) adminApiToken.value = "";
    }
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
  if (payload.fmt !== undefined) {
    commitConversionMode(payload.fmt);
  }
  if (payload.pat !== undefined) {
    commitFilenamePolicy(payload.pat);
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

// 暗号化バックアップURLの発行
let currentBackupRestorationKey = "";
async function generatePinBackupUrl() {
  // 💾 バックアップ発行前に最新の入力状態を自動で一回保存
  saveR2SettingsAuto();

  const payload = buildAppExportPayload();
  const hasData = payload.a || payload.fb || payload.kv || payload.ku || payload.cu || (payload.cul && payload.cul.length > 0) || (payload.dl && payload.dl.length > 0);
  if (!hasData) {
    alert("⚠️ バックアップする設定（クラウドストレージ接続設定またはCivitaiクリエイターリスト）がありません。");
    return;
  }

  const { encrypted, restorationKey } = await encryptConfiguration(payload);
  const backupUrl = encryptedConfigurationUrl(encrypted, window.location.href);

  const pinDisplayModal = document.querySelector("#pinDisplayModal");
  const generatedPinText = document.querySelector("#generatedPinText");
  const backupUrlTextarea = document.querySelector("#backupUrlTextarea");
  const backupUrlStage = document.querySelector("#backupUrlStage");
  const backupKeyStage = document.querySelector("#backupKeyStage");
  const copyBackupUrlButton = document.querySelector("#copyBackupUrlButton");
  const copyBackupKeyButton = document.querySelector("#copyBackupKeyButton");

  currentBackupRestorationKey = restorationKey;
  if (generatedPinText) generatedPinText.textContent = "";
  if (backupUrlTextarea) backupUrlTextarea.value = backupUrl;
  if (backupUrlStage) backupUrlStage.style.display = "block";
  if (backupKeyStage) backupKeyStage.style.display = "none";
  if (copyBackupUrlButton) copyBackupUrlButton.textContent = "📋 URLをコピー";
  if (copyBackupKeyButton) copyBackupKeyButton.textContent = "📋 復元キーをコピー";
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
      alert("この形式の設定URLは秘密情報を保護しないため復元できません。設定済みブラウザから新しい暗号化バックアップを発行してください。");
    }
  } catch (err) {
    safeConsole.error("Failed to parse sync hash:", err);
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
function saveR2SettingsAuto() {
  // 🛡️ 入力欄を操作中（フォーカス中）の消去のみ許可し、触っていない別アコーディオンの既存設定を誤削除しない
  const safeSaveField = (inputEl, key) => {
    if (!inputEl) return;
    const value = inputEl.value.trim();
    if (value) {
      if (key === "kvWorkerUrl" && !safeHttpUrl(/^https?:\/\//i.test(value) ? value : `https://${value}`, { endpoint: true })) {
        throw new Error("Worker URL must be HTTP(S), without credentials, query or hash");
      }
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
    if (kuboWebUiLink) kuboWebUiLink.href = safeHttpUrl(`${getKuboRpcEndpoint()}/webui`);
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

  updateR2Status();
  render();
  // [INV-CORE-001] [INV-CORE-004] 文字入力中の 400ms debounce 通信（fetchAndRenderR2Files）は完全撤去。
  // 設定値の localStorage 保存と UI 状態更新のみを行い、入力中の重い通信連打を根絶。
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
      renderKuboStatus(kuboStatusIndicator, info);
    }
    alert(`✅ 自宅 Kubo ノードへの接続に成功しました！\n\n・Version: ${info.agentVersion}\n・RPC: ${getKuboRpcEndpoint()}`);
  } else {
    if (kuboStatusIndicator) {
      renderKuboStatus(kuboStatusIndicator, info);
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
const handleDomainSelectionChange = (newDomain, provider = managedController.getActiveProvider()) => {
  const storageProvider = normalizeDeliveryProvider(provider);
  setSelectedR2Domain(newDomain, storageProvider);
  const settingsDomainSelect = storageProvider === "filebase" ? filebaseDomainSelect : r2DomainSelect;
  if (settingsDomainSelect && settingsDomainSelect.value !== newDomain) {
    settingsDomainSelect.value = newDomain;
  }
  if (storageProvider === (uploadProviderSelect?.value || "r2") && quickDomainSelect && quickDomainSelect.value !== newDomain) {
    quickDomainSelect.value = newDomain;
  }
  if (storageProvider === "r2") updateR2CompatibilityUi();
  if (storageProvider === "filebase") updateFilebaseCompatibilityUi();
  updateR2Status();
  updateDomainCompatBadgeUi(storageProvider);
  if (storageProvider === normalizeDeliveryProvider(managedController.getActiveProvider())) {
    if (managedController.getContents() && managedController.getContents().length > 0) {
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
  const provider = uploadProviderSelect?.value || "r2";
  setSelectedR2Domain(e.target.value, provider);
  renderR2DomainSelect();
});

uploadProviderSelect?.addEventListener("change", () => {
  renderR2DomainSelect();
  render();
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
const DOMAIN_COMPAT_STORAGE_KEY = "cividge_domain_compat_flags_v2";

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

    const isWorker = matchesSelectedRelayProbe(cleanUrl, res);
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
    // 🚀 [INV-CORE-005] 手元台帳キャッシュから照合（kv.list 全件走査ゼロ化）
    const otherLedger = loadLedgerFromLocalStorage(otherProvider) || [];
    const foreignFiles = otherLedger.filter(f => {
      const key = (f.rawKey || f.Key || f.name || "").toLowerCase();
      if (!key.startsWith(`${cleanHost}:`)) return false;
      const b = f.metadata?.backend || f.metadata?.b || f.backend;
      return b === otherProvider;
    });
    if (foreignFiles.length > 0) {
      await showCustomAlert(
        `🚫 登録拒否: このドメイン（${cleanHost}）には、過去に ${otherProvider.toUpperCase()} で登録されたファイルがまだ ${foreignFiles.length} 件台帳に残っています。\n\nURLの衝突やすり替わり事故を防ぐため、該当ファイルを全削除しない限り、${storageProvider.toUpperCase()} で再利用することはできません。`,
        "⚠️ ドメイン宗派替え防止ロック"
      );
      return;
    }
  } catch (e) {
    safeConsole.warn("Local ledger check error during domain add:", e);
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
  if (storageProvider === normalizeDeliveryProvider(managedController.getActiveProvider())) renderCurrentStoragePage();
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
      // 🚀 [INV-CORE-005] 手元台帳キャッシュから照合（kv.list 全件走査ゼロ化）
      const currentLedger = loadLedgerFromLocalStorage(storageProvider) || [];
      const activeFiles = currentLedger.filter(f => (f.rawKey || f.Key || f.name || "").toLowerCase().startsWith(`${cleanHost}:`));
      if (activeFiles.length > 0) {
        await showCustomAlert(
          `⚠️ このドメイン（${cleanHost}）で配信中のファイルがまだ ${activeFiles.length} 件存在します。\n\nドメイン設定を削除すると、これらはアクセス不能（404）になります。\nドメインを削除する前に、該当ファイルを削除するか別ドメインへ移してください。`,
          "⚠️ 配信中ファイル保護ロック"
        );
        return;
      }
    } catch (e) {
      safeConsole.warn("Local ledger check error during domain delete:", e);
    }

    if (!confirm(`選択中の${label}配信ドメイン「${current}」を削除しますか？`)) return;
    const nextList = getR2DomainList(storageProvider).filter(d => d !== current);
    saveR2DomainList(nextList, storageProvider);
    setSelectedR2Domain(nextList[0] || "", storageProvider);
    renderR2DomainSelect();
    updateR2Status();
    updateDomainCompatBadgeUi(storageProvider);
    render();
    if (storageProvider === normalizeDeliveryProvider(managedController.getActiveProvider())) renderCurrentStoragePage();
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
        // 🚀 [INV-CORE-005] 手元台帳キャッシュから照合（kv.list 全件走査ゼロ化）
        const otherLedger = loadLedgerFromLocalStorage(otherProvider) || [];
        const foreignFiles = otherLedger.filter(f => {
          const key = (f.rawKey || f.Key || f.name || "").toLowerCase();
          if (!key.startsWith(`${cleanHost}:`)) return false;
          const b = f.metadata?.backend || f.metadata?.b || f.backend;
          return b === otherProvider;
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
        safeConsole.warn("Local ledger check error during domain unmirror:", e);
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
  renderGatewaySettings();

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
let currentSyncRestorationKey = "";
let syncQrStage = "url";
const copySyncUrlButton = document.querySelector("#copySyncUrlButton");
const toggleQrPayloadButton = document.querySelector("#toggleQrPayloadButton");
const copyRestorationKeyButton = document.querySelector("#copyRestorationKeyButton");

async function renderSyncQrStage(stage) {
  if (!qrCanvas || !currentSyncRestorationKey || !lastGeneratedSyncUrl) return;
  syncQrStage = stage === "key" ? "key" : "url";
  const value = syncQrStage === "key" ? currentSyncRestorationKey : lastGeneratedSyncUrl;
  const stageDescription = document.querySelector("#qrStageDescription");
  const messages = i18nDict[getAppLanguage()] || i18nDict.ja;
  const qrMatrix = QRCode.create(value, { errorCorrectionLevel: "L" });
  const quietZoneModules = 4;
  const pixelsPerModule = syncQrStage === "key" ? 8 : 4;
  const qrWidth = (qrMatrix.modules.size + quietZoneModules * 2) * pixelsPerModule;
  await QRCode.toCanvas(qrCanvas, value, {
    width: qrWidth,
    margin: quietZoneModules,
    errorCorrectionLevel: "L",
    color: { dark: "#0f172a", light: "#ffffff" },
  });
  if (stageDescription) stageDescription.textContent = syncQrStage === "key" ? messages.qrKeyStage : messages.qrUrlStage;
  const keyWrap = document.querySelector("#qrRestorationKeyWrap");
  const keyDisplay = document.querySelector("#qrRestorationKey");
  if (keyDisplay) keyDisplay.textContent = syncQrStage === "key" ? currentSyncRestorationKey : "";
  if (keyWrap) keyWrap.style.display = syncQrStage === "key" ? "block" : "none";
  if (copySyncUrlButton) copySyncUrlButton.style.display = syncQrStage === "url" ? "block" : "none";
  if (copyRestorationKeyButton) copyRestorationKeyButton.style.display = syncQrStage === "key" ? "block" : "none";
  if (toggleQrPayloadButton) toggleQrPayloadButton.textContent = syncQrStage === "key"
    ? messages.btnShowUrlQr
    : messages.btnShowKeyQr;
}

async function openSyncQrModal() {
  const messages = i18nDict[getAppLanguage()] || i18nDict.ja;
  lastGeneratedSyncUrl = "";
  currentSyncRestorationKey = "";
  syncQrStage = "url";
  if (qrContainer) qrContainer.style.display = "none";
  if (qrStatus) qrStatus.textContent = messages.qrGenerating;
  if (copySyncUrlButton) copySyncUrlButton.disabled = true;
  if (toggleQrPayloadButton) toggleQrPayloadButton.disabled = true;
  if (toggleQrPayloadButton) toggleQrPayloadButton.textContent = messages.btnShowKeyQr;
  if (copyRestorationKeyButton) copyRestorationKeyButton.textContent = messages.btnCopyRestorationKey;
  if (copySyncUrlButton) copySyncUrlButton.style.display = "block";
  if (copyRestorationKeyButton) copyRestorationKeyButton.style.display = "none";
  const keyWrap = document.querySelector("#qrRestorationKeyWrap");
  if (keyWrap) keyWrap.style.display = "none";
  if (qrModal) qrModal.style.display = "grid";
  try {
    saveR2SettingsAuto();
    const payload = buildAppExportPayload();
    const hasData = payload.a || payload.fb || payload.kv || payload.ku || payload.cu || (payload.cul && payload.cul.length > 0) || (payload.dl && payload.dl.length > 0);
    if (!hasData) {
      if (qrStatus) qrStatus.textContent = messages.qrNoData;
      return;
    }
    const { encrypted, restorationKey } = await encryptConfiguration(payload);
    lastGeneratedSyncUrl = encryptedConfigurationUrl(encrypted, window.location.href);
    currentSyncRestorationKey = restorationKey;
    if (copySyncUrlButton) copySyncUrlButton.disabled = false;
    if (toggleQrPayloadButton) toggleQrPayloadButton.disabled = false;

    if (qrCanvas) {
      await renderSyncQrStage("url");
      if (qrContainer) qrContainer.style.display = "inline-block";
    }
    if (qrStatus) qrStatus.textContent = "";
  } catch (err) {
    safeConsole.error("QR Code generation error:", err);
    if (qrStatus) qrStatus.textContent = /too big to be stored in a QR Code/i.test(err?.message || "")
      ? messages.qrTooLarge
      : messages.qrFailed;
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
    safeConsole.error("Clipboard copy failed:", err);
    prompt("以下の引き継ぎURLをコピーしてください:", lastGeneratedSyncUrl);
  }
});

toggleQrPayloadButton?.addEventListener("click", async () => {
  try {
    await renderSyncQrStage(syncQrStage === "url" ? "key" : "url");
  } catch (err) {
    safeConsole.error("QR Code generation error:", err);
    if (qrStatus) qrStatus.textContent = "QRコードを表示できませんでした。復元キーをコピーして利用してください。";
  }
});

copyRestorationKeyButton?.addEventListener("click", async () => {
  if (!currentSyncRestorationKey) return;
  try {
    await navigator.clipboard.writeText(currentSyncRestorationKey);
    const originalText = copyRestorationKeyButton.textContent;
    copyRestorationKeyButton.textContent = "✅ 復元キーをコピーしました";
    setTimeout(() => { copyRestorationKeyButton.textContent = originalText; }, 2000);
  } catch (err) {
    safeConsole.error("Restoration key clipboard copy failed:", err);
    prompt("復元キーだけをコピーしてください（引き継ぎURLとは別に保管）:", currentSyncRestorationKey);
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
  lastGeneratedSyncUrl = "";
  currentSyncRestorationKey = "";
  syncQrStage = "url";
  const keyDisplay = document.querySelector("#qrRestorationKey");
  if (keyDisplay) keyDisplay.textContent = "";
  const keyWrap = document.querySelector("#qrRestorationKeyWrap");
  if (keyWrap) keyWrap.style.display = "none";
  const messages = i18nDict[getAppLanguage()] || i18nDict.ja;
  if (toggleQrPayloadButton) toggleQrPayloadButton.textContent = messages.btnShowKeyQr;
  if (qrCanvas) qrCanvas.getContext("2d")?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
});

qrModal?.addEventListener("click", (e) => {
  if (e.target === qrModal) {
    closeQrModalButton?.click();
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

submitPinButton?.addEventListener("click", async () => {
  const pin = pinInput?.value?.trim() || "";
  if (!/^[a-f0-9]{32}$/i.test(pin)) {
    if (pinErrorNotice) pinErrorNotice.textContent = "32文字の復元キーを入力してください";
    return;
  }

  const payload = await decryptConfiguration(pendingEncryptedHash, pin);
  if (!payload || typeof payload !== "object") {
    if (pinErrorNotice) pinErrorNotice.textContent = "❌ 復元キーが正しくないか、データが変更されています";
    return;
  }

  const restored = applyAppImportPayload(payload);
  if (!restored) {
    if (pinErrorNotice) pinErrorNotice.textContent = "⚠️ バックアップデータが破損しているか空です";
    return;
  }

  if (pinModal) pinModal.style.display = "none";
  history.replaceState(null, "", window.location.pathname + window.location.search);
  pendingEncryptedHash = "";
  if (pinInput) pinInput.value = "";
  alert("🎉 設定を正常に復元・保存しました！");
});

cancelPinButton?.addEventListener("click", () => {
  if (pinModal) pinModal.style.display = "none";
  pendingEncryptedHash = "";
  if (pinInput) pinInput.value = "";
  history.replaceState(null, "", window.location.pathname + window.location.search);
});

closePinDisplayModalButton?.addEventListener("click", () => {
  if (pinDisplayModal) pinDisplayModal.style.display = "none";
  currentBackupRestorationKey = "";
  const keyDisplay = document.querySelector("#generatedPinText");
  const urlDisplay = document.querySelector("#backupUrlTextarea");
  const backupUrlStage = document.querySelector("#backupUrlStage");
  const backupKeyStage = document.querySelector("#backupKeyStage");
  if (keyDisplay) keyDisplay.textContent = "";
  if (urlDisplay) urlDisplay.value = "";
  if (backupUrlStage) backupUrlStage.style.display = "block";
  if (backupKeyStage) backupKeyStage.style.display = "none";
});

document.querySelector("#showBackupKeyButton")?.addEventListener("click", () => {
  const backupUrlStage = document.querySelector("#backupUrlStage");
  const backupKeyStage = document.querySelector("#backupKeyStage");
  const keyDisplay = document.querySelector("#generatedPinText");
  if (keyDisplay) keyDisplay.textContent = currentBackupRestorationKey;
  if (backupUrlStage) backupUrlStage.style.display = "none";
  if (backupKeyStage) backupKeyStage.style.display = "block";
});

document.querySelector("#showBackupUrlButton")?.addEventListener("click", () => {
  const backupUrlStage = document.querySelector("#backupUrlStage");
  const backupKeyStage = document.querySelector("#backupKeyStage");
  const keyDisplay = document.querySelector("#generatedPinText");
  if (keyDisplay) keyDisplay.textContent = "";
  if (backupKeyStage) backupKeyStage.style.display = "none";
  if (backupUrlStage) backupUrlStage.style.display = "block";
});

document.querySelector("#copyBackupUrlButton")?.addEventListener("click", async () => {
  const value = document.querySelector("#backupUrlTextarea")?.value || "";
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    document.querySelector("#copyBackupUrlButton").textContent = "✅ URLをコピーしました";
  } catch (err) {
    safeConsole.error("Backup URL clipboard copy failed:", err);
    prompt("復元用URLをコピーしてください:", value);
  }
});

document.querySelector("#copyBackupKeyButton")?.addEventListener("click", async () => {
  if (!currentBackupRestorationKey) return;
  try {
    await navigator.clipboard.writeText(currentBackupRestorationKey);
    document.querySelector("#copyBackupKeyButton").textContent = "✅ 復元キーをコピーしました";
  } catch (err) {
    safeConsole.error("Backup restoration key clipboard copy failed:", err);
    prompt("復元キーだけをコピーしてください:", currentBackupRestorationKey);
  }
});

function getConversionMode() {
  return canonicalConversionMode(formatSelect?.value);
}

function isConversionEnabled() {
  return isConversionModeEnabled(getConversionMode());
}

function isFilenameChanged() {
  return canonicalFilenamePolicy(renamePattern?.value) !== "{original}";
}

function syncConversionQuality() {
  if (enableConvertCheck) enableConvertCheck.checked = isConversionEnabled();
  if (qualityRange) qualityRange.disabled = !isConversionEnabled();
  if (qualityOutput) qualityOutput.style.opacity = isConversionEnabled() ? "1" : "0.5";
}

function commitConversionMode(mode) {
  const canonical = canonicalConversionMode(mode);
  if (formatSelect) formatSelect.value = canonical;
  if (canonical !== "passthrough") lastUiConversionMode = canonical;
  localStorage.setItem("formatSelect", canonical);
  syncConversionQuality();
}

function commitFilenamePolicy(policy, { preserveDraft = false } = {}) {
  const canonical = canonicalFilenamePolicy(policy);
  if (renamePattern && !preserveDraft) renamePattern.value = canonical;
  if (canonical !== "{original}") lastUiFilenamePolicy = canonical;
  localStorage.setItem("renamePattern", canonical);
  if (enableRenameCheck) enableRenameCheck.checked = canonical !== "{original}";
}

// --- UI イベントリスナー ---

enableZipCheck?.addEventListener("change", () => {
  const isChecked = enableZipCheck.checked;
  localStorage.setItem("enableZip", String(isChecked));
  render();
});

qualityRange?.addEventListener("input", () => {
  if (qualityOutput) qualityOutput.textContent = qualityRange.value;
  localStorage.setItem("qualityRange", qualityRange.value);
});

enableConvertCheck?.addEventListener("change", () => {
  commitConversionMode(enableConvertCheck.checked ? lastUiConversionMode : "passthrough");
  render();
  updateRenamePreview();
});

formatSelect?.addEventListener("change", () => {
  commitConversionMode(formatSelect.value);
  render();
  updateRenamePreview();
});

enableRenameCheck?.addEventListener("change", () => {
  commitFilenamePolicy(enableRenameCheck.checked ? lastUiFilenamePolicy : "{original}");
  render();
  updateRenamePreview();
});

renamePattern?.addEventListener("input", () => {
  commitFilenamePolicy(renamePattern.value, { preserveDraft: true });
  render();
  updateRenamePreview();
});
renamePattern?.addEventListener("blur", event => {
  // A helper click is part of the current edit; do not normalize an empty
  // draft to {original} before that helper inserts its token.
  if (event.relatedTarget?.closest?.(".pattern-helpers")) return;
  commitFilenamePolicy(renamePattern.value);
  render();
  updateRenamePreview();
});

clearRenamePattern?.addEventListener("click", () => {
  if (renamePattern) {
    renamePattern.value = "";
    commitFilenamePolicy(renamePattern.value, { preserveDraft: true });
    renamePattern.focus();
    render();
    updateRenamePreview();
  }
});

const patternHelpers = document.querySelector(".pattern-helpers");
patternHelpers?.addEventListener("mousedown", event => {
  // Mouse activation should keep the draft and selection until insertion.
  if (event.target.closest(".tag-button")) event.preventDefault();
});
patternHelpers?.addEventListener("click", (event) => {
  const target = event.target;
  if (target.classList.contains("tag-button")) {
    const insertText = target.dataset.insert;
    if (!insertText || !renamePattern) return;

    const { value, cursor } = insertFilenamePatternToken(
      renamePattern.value, insertText,
      renamePattern.selectionStart ?? renamePattern.value.length,
      renamePattern.selectionEnd ?? renamePattern.value.length,
    );
    renamePattern.value = value;

    renamePattern.focus();
    renamePattern.setSelectionRange(cursor, cursor);

    commitFilenamePolicy(renamePattern.value, { preserveDraft: true });
    render();
    updateRenamePreview();
  }
});

function getActiveStorageLimitGB() {
  if (managedController.getActiveProvider() === "filebase") {
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
  if (managedController.getActiveProvider() === "filebase") {
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
    const isFb = managedController.getActiveProvider() === "filebase";
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
  const key = managedController.getActiveProvider() === "filebase" ? "autoFifo" : "r2AutoFifo";
  localStorage.setItem(key, String(autoFifoCheckbox.checked));
});

function updateStorageUsageUI() {
  if (!storageUsageText || !storageUsageBar) return;
  const totalSize = managedController.getTotalSize() || 0;
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
  uploadState.getResults().forEach((result) => {
    if (result && result.url) URL.revokeObjectURL(result.url);
  });
  uploadState.clear();
  render();
});


function createComfyBadgeHtml(file, result) {
  const meta = file.metaStatus;
  if (!meta) return '<div style="font-size: 10px; color: var(--muted); margin-top: 3px;">🔍 メタデータ解析中...</div>';

  const isConvertOn = isConversionEnabled();

  let badge = "";
  if (meta.hasWorkflow) {
    badge = `
      <span class="meta-badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10.5px; padding: 2px 6px; border-radius: 4px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;" title="ComfyUIのワークフロー（ノード接続・配置情報）が完全な形で含まれています。ComfyUI画面にドロップすると完全再現可能です。">
        <span>🧬 ComfyUI ワークフロー完全内包</span>
        ${meta.nodeCount ? `<span style="font-size: 9.5px; opacity: 0.85;">(${escapeHtml(meta.nodeCount)}ノード)</span>` : ""}
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

function checkRemoteFileWf(key) {
  if (!key) return false;
  try {
    const wfStore = JSON.parse(localStorage.getItem("comfyWfMap") || "{}");
    return Boolean(wfStore[key]);
  } catch (e) {
    return false;
  }
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
  let oversizedCount = 0;
  const allowed = files.filter((file) => {
    if (exceedsUploadLimit(file.size)) { oversizedCount++; return false; }
    const ok = isFileAcceptable(file);
    if (!ok) blockedCount++;
    return ok;
  });

  if (blockedCount > 0) {
    alert(`⚠️ 実行ファイルやスクリプトなどの危険なファイル形式（${blockedCount}件）は除外されました。`);
  }
  if (oversizedCount > 0) {
    const dict = i18nDict[getAppLanguage()] || i18nDict.ja;
    alert(`⚠️ ${dict.uploadLimitCount.replace("{count}", String(oversizedCount))}`);
  }

  uploadState.addFiles(allowed);
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
        safeConsole.warn("Meta parse error:", err);
        f.metaStatus = { hasWorkflow: false, type: "none" };
        render();
      });
    } else {
      f.metaStatus = { hasWorkflow: false, type: "none" };
    }
  });
}

function setUiLock(locked) {
  locked = locked || uploadDestinationBusy;
  uploadUiLocked = locked;
  const hasFiles = uploadState.getFiles().length > 0;
  const isConvertOn = isConversionEnabled();
  const isRenameOn = isFilenameChanged();
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
  if (uploadButton) uploadButton.disabled = locked || !hasFiles;
  if (uploadProviderSelect) uploadProviderSelect.disabled = locked;
  if (quickDomainSelect) quickDomainSelect.disabled = locked;
}

function updateRenamePreview() {
  const previewText = document.querySelector("#renamePreviewText");
  if (!previewText) return;

  const firstFile = uploadState.getFiles()[0];
  const firstExt = firstFile ? (firstFile.name.split('.').pop() || "") : "";
  const isFirstImage = firstFile
    ? (firstFile.type.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"].includes(firstExt.toLowerCase()))
    : true;

  const isRenameOn = isFilenameChanged();
  const isConvertOn = isConversionEnabled();

  // 画像以外（MP3等）なら変換設定に関わらず元拡張子を維持
  const ext = (isConvertOn && isFirstImage)
    ? (extensions[conversionModeToMime(getConversionMode())] || "webp")
    : (firstExt || "ext");

  const dummyName = firstFile ? firstFile.name.replace(/\.[^.]+$/, "") : "sample";

  if (!isRenameOn) {
    previewText.textContent = `${dummyName}.${ext}`;
    return;
  }

  const rawPattern = renamePattern?.value;
  const pattern = canonicalFilenamePolicy(rawPattern);

  let previewName = pattern.replaceAll("{original}", dummyName);

  previewName = previewName.replace(/\{random(?::(\d+))?\}/g, (match, digits) => {
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
  const hasFiles = uploadState.getFiles().length > 0;
  if (fileCount) fileCount.textContent = `${uploadState.getFiles().length}件`;

  const isConvertOn = isConversionEnabled();
  const isRenameOn = isFilenameChanged();
  const isZipOn = enableZipCheck?.checked ?? false;
  const canProcessLocal = isConvertOn || isRenameOn || isZipOn;

  if (convertDownloadButton) {
    convertDownloadButton.disabled = !hasFiles || !canProcessLocal;
    convertDownloadButton.title = (!canProcessLocal && hasFiles)
      ? "画像変換・リネーム・ZIPまとめ保存がすべてオフのためダウンロード無効"
      : "";
  }
  if (uploadButton) uploadButton.disabled = uploadUiLocked || !hasFiles;

  if (dropzone) {
    dropzone.classList.toggle("has-files", hasFiles);
  }

  updateRenamePreview();

  if (fileList) {
    fileList.innerHTML = "";
    const lang = getAppLanguage();
    const dict = i18nDict[lang] || i18nDict.ja;

    uploadState.getFiles().forEach((file, index) => {
      try {
        const result = uploadState.getResults()[index];
        const item = document.createElement("article");
        item.className = "file-item unified-file-card";
        item.dataset.index = index;

        const originalExt = file.name ? file.name.split('.').pop().toLowerCase() : "";

        let previewSrc = "";
        if (result && result.previewUrl) {
          previewSrc = result.previewUrl;
        } else if ((file.type && file.type.startsWith("image/")) || originalExt === "jxl") {
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
            ${previewSrc ? `<img class="thumb" src="${escapeHtml(safeMediaUrl(previewSrc))}" alt="" loading="lazy">` : `<div class="thumb format-badge">${escapeHtml(originalExt.toUpperCase() || "FILE")}</div>`}
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
        const previewImage = item.querySelector("img.thumb");
        const previewExt = displayName.split(".").pop().toLowerCase();
        if (previewImage && previewExt === "jxl") {
          attachJxlPreviewFallback(previewImage, { onFailure: image => {
            const placeholder = document.createElement("div");
            placeholder.className = "thumb format-badge";
            placeholder.textContent = "JXL";
            image.replaceWith(placeholder);
          } });
        }
      } catch (err) {
        safeConsole.error("Card render error:", err);
      }
    });

    const totalPrompts = uploadState.getFiles().filter(f => f.metaStatus?.promptDetails?.prompt).length;
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

  const isConvertOn = isConversionEnabled();
  const isRenameOn = isFilenameChanged();
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

  const canUseCivitai = canUseCivitaiPostIntent(projectedFinalUploadMedia(file, result, getConversionMode()));
  const isProtected = Boolean(file.hasPassword || result?.hasPassword);
  const civitaiOk = upOk && canUseCivitai && !isProtected;
  const civitaiStyle = civitaiOk
    ? "color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); font-size: 11px; padding: 0 8px; height: 28px;"
    : "opacity: 0.35; font-size: 11px; padding: 0 8px; height: 28px; cursor: not-allowed;";
  let civitaiBtnTitle = "リネームを無視して変換・5分間だけ一時保存し、Civitaiの投稿画面を開く";
  if (!upOk) civitaiBtnTitle = "ストレージ未接続のためCivitai連携不可";
  else if (isProtected) civitaiBtnTitle = "パスワード保護中のファイルはCivitai連携不可";

  if (result && result.isUploaded) {
    const isFb = result.uploadedProvider === "filebase";
    const deliveryUrl = getSelectedDeliveryUrl(result);
    const badgeHtml = isFb
      ? `<span style="font-size: 9.5px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); padding: 1px 5px; border-radius: 4px;">🪐 IPFS</span>`
      : `<span style="font-size: 9.5px; font-weight: 700; color: #fb923c; background: rgba(249, 115, 22, 0.15); border: 1px solid rgba(249, 115, 22, 0.4); padding: 1px 5px; border-radius: 4px;">⚡ R2</span>`;

    const pwdBadge = result.hasPassword
      ? `<span class="password-badge" style="font-size: 9.5px; font-weight: 600; color: #818cf8; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); padding: 1px 5px; border-radius: 4px;" title="パスワード保護中">🔒 保護</span>`
      : "";

    return `
      ${badgeHtml}
      ${pwdBadge}
      <input type="text" class="url-output" value="${escapeHtml(deliveryUrl)}" readonly style="width: 140px; font-size: 11px; height: 28px; padding: 0 6px; background: rgba(0,0,0,0.3); border: 1px solid rgba(56,189,248,0.4); color: #38bdf8; border-radius: 4px;" title="クリックで全選択＆コピー">
      <button type="button" class="ghost-button copy-button" style="font-size: 11px; padding: 0 8px; height: 28px;">${escapeHtml(dict.copyUrl || "コピー")}</button>
      <button type="button" class="ghost-button download-single-btn" data-index="${index}" style="font-size: 11px; padding: 0 8px; height: 28px;" title="${dlBtnTitle}" ${dlBtnDisabled}>📥 DL</button>
      ${canUseCivitai ? `<button type="button" class="ghost-button civitai-post-btn" data-index="${index}" data-url="${escapeHtml(deliveryUrl)}" data-name="${escapeHtml(result.name)}" style="${civitaiStyle}" title="${civitaiBtnTitle}" ${civitaiOk ? '' : 'disabled'}>🎨 Civitai</button>` : ""}
    `;
  }

  // The single upload action uses the explicit destination selector.
  return `
    <button type="button" class="ghost-button download-single-btn" data-index="${index}" style="font-size: 11px; padding: 0 8px; height: 28px;" title="${dlBtnTitle}" ${dlBtnDisabled}>📥 DL</button>
    <button type="button" class="ghost-button upload-single-btn" data-index="${index}" style="font-size: 11px; padding: 0 8px; height: 28px;" title="${escapeHtml(dict.uploadAction)}" ${uploadUiLocked ? 'disabled' : ''}>${escapeHtml(dict.uploadAction)}</button>
    ${canUseCivitai ? `<button type="button" class="ghost-button civitai-post-btn" data-index="${index}" style="${civitaiStyle}" title="${civitaiBtnTitle}" ${civitaiOk ? '' : 'disabled'}>🎨 Civitai</button>` : ""}
  `;
}

copyAllPromptsBtn?.addEventListener("click", async () => {
  const promptList = uploadState.getFiles()
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
  if (target.matches("input.url-output")) { target.select(); return; }
  const card = target.closest(".unified-file-card");
  if (!card) return;

  const index = Number(target.dataset.index ?? card.dataset.index);

  // 0. プロンプト個別コピーボタン
  const promptBtn = target.closest(".copy-prompt-btn");
  if (promptBtn) {
    const idx = Number(promptBtn.dataset.index ?? card.dataset.index);
    const f = uploadState.getFiles()[idx];
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
    if (!isNaN(index) && index >= 0 && index < uploadState.getFiles().length) {
      const removedResult = uploadState.getResults()[index];
      if (removedResult) {
        if (removedResult.url) URL.revokeObjectURL(removedResult.url);
        if (removedResult.previewUrl) URL.revokeObjectURL(removedResult.previewUrl);
      }
      uploadState.removeAt(index);
      render();
    }
    return;
  }

  // 2. 単体ダウンロード
  if (target.classList.contains("download-single-btn")) {
    if (isNaN(index) || index < 0 || index >= uploadState.getFiles().length) return;
    const file = uploadState.getFiles()[index];
    let result = uploadState.getResults()[index];

    target.disabled = true;
    target.textContent = "...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        uploadState.setResult(index, result);
      }
      downloadUrl(result.url, result.name);
    } catch (e) {
      safeConsole.error(e);
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
    if (isNaN(index) || index < 0 || index >= uploadState.getFiles().length) return;
    if (uploadDestinationBusy) return;
    uploadDestinationBusy = true;
    const file = uploadState.getFiles()[index];
    let result = uploadState.getResults()[index];

    target.disabled = true;
    target.textContent = "UP中...";
    try {
      setUiLock(true);
      const destination = await requestUploadDestination(uploadProviderSelect?.value || "r2");
      if (!destination) return;
      setUiLock(true);
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        uploadState.setResult(index, result);
      }
      const success = await uploadImage(result, destination.provider, null, { deliveryDomain: destination.domain });
      if (success) {
        renderCurrentStoragePage();
      }
    } catch (e) {
      safeConsole.error(e);
      alert("アップロードに失敗しました: " + e.message);
    } finally {
      uploadDestinationBusy = false;
      setUiLock(false);
      render();
    }
    return;
  }

  // 3.5 Civitai 転送
  if (target.classList.contains("civitai-post-btn")) {
    if (isNaN(index) || index < 0 || index >= uploadState.getFiles().length) return;
    const file = uploadState.getFiles()[index];
    let result = uploadState.getResults()[index];

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
      safeConsole.warn("Preload window failed:", e);
    }

    target.disabled = true;
    target.textContent = "転送準備中...";
    try {
      if (!result || !isConversionCacheValid()) {
        if (result && result.url) URL.revokeObjectURL(result.url);
        if (result && result.previewUrl) URL.revokeObjectURL(result.previewUrl);
        result = await convertImage(file, index);
        uploadState.setResult(index, result);
      }
      const targetProvider = isR2Configured() ? "r2" : "filebase";
      const success = await uploadImage(result, targetProvider, null, {
        // Civitai は intent を開いた時点でメディアを取り込むため、ここは共有用ではなく短期の踏み台にする。
        ttlSeconds: 5 * 60,
        civitaiTemporary: true,
      });
      if (success && result.proxyUrl) {
        renderCurrentStoragePage();
        openCivitaiIntent(result.proxyUrl, result.name, preloadWindow);
      } else {
        if (preloadWindow && !preloadWindow.closed) preloadWindow.close();
      }
    } catch (e) {
      safeConsole.error(e);
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
    const result = uploadState.getResults()[index];
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
    const result = uploadState.getResults()[index];

    if (inputEl && newDomain) {
      const updatedUrl = switchUrlDomain(inputEl.value, newDomain);
      inputEl.value = updatedUrl;
      if (result) result.proxyUrl = updatedUrl;
      // Civitai ボタンの URL も更新
      const civitaiBtn = card?.querySelector(".civitai-post-btn");
      if (civitaiBtn) civitaiBtn.dataset.url = updatedUrl;

      // 🌐 [INV-CORE-006] KV台帳に登録済みの場合は allowedHost も非同期で自動更新（host:filename キーで照会）
      if (result && result.name && hasAdminAccess()) {
        registerKvCid(
          result.kvKey || result.name,
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
        ).catch(err => safeConsole.warn("Failed to update allowedHost on domain change:", err));
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
        currentDomain,
        false, null, null, undefined, null, null,
        { policyChange: true }
      ).then(() => {
        const provider = article?.dataset?.provider;
        const current = managedController.getContents().find(item => item.storageProvider === provider && (item.rawKey || item.Key) === key);
        if (current) {
          addOrUpdateLocalLedgerItem(provider, {
            ...current,
            expiresAt: expiresAt || null,
            ttl: ttlSeconds,
            metadata: { ...current.metadata, expiresAt: expiresAt || null, ttl: ttlSeconds },
          });
        }
        // 成功フィードバック
        e.target.style.transition = "all 0.2s ease";
        e.target.style.borderColor = "#22c55e";
        setTimeout(() => { e.target.style.borderColor = ""; }, 600);
      }).catch(err => {
        safeConsole.warn("Failed to update TTL for " + key + ":", err);
        alert(`❌ 有効期限の更新に失敗しました: ${redactSecrets(err.message)}`);
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
    const result = uploadState.getResults()[index];

    if (result) {
      result.ttl = ttlSeconds;
      result.expiresAt = ttlSeconds > 0 ? (Date.now() + ttlSeconds * 1000) : null;

      if (result.name && hasAdminAccess()) {
        registerKvCid(
          result.kvKey || result.name,
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
          null,
          false, null, null, undefined, null, null,
          { policyChange: true }
        ).then(() => {
          e.target.style.transition = "all 0.2s ease";
          e.target.style.borderColor = "#22c55e";
          setTimeout(() => { e.target.style.borderColor = ""; }, 600);
        }).catch(err => safeConsole.warn("Failed to update result TTL:", err));
      }
    }
  }
});

// --- 設定シグネチャ & スマートバイパス ---

function getCurrentConfigSignature() {
  const format = getConversionMode();
  const quality = qualityRange ? qualityRange.value : "85";
  const pattern = canonicalFilenamePolicy(renamePattern?.value);
  const fileSig = uploadState.getFiles().map(f => `${f.name}:${f.size}:${f.lastModified}`).join("|");

  return `${format}_${format === "passthrough" ? "" : quality}_${pattern}_${fileSig}`;
}

function isConversionCacheValid() {
  return uploadState.isConversionCacheValid(getCurrentConfigSignature());
}

function invalidateConversionCache(clearResults = true) {
  uploadState.invalidateConversion();
  if (clearResults && uploadState.getResults().length > 0) {
    uploadState.getResults().forEach(result => {
      if (result) {
        if (result.url) URL.revokeObjectURL(result.url);
        if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
      }
    });
    uploadState.clearResults();
    render();
  }
}

// --- 画像変換処理 ---
async function runConversion(force = false) {
  if (!uploadState.getFiles().length) return false;

  // 設定が変わっておらず、すでに変換済みBlobが揃っている場合は完全バイパス！
  if (!force && isConversionCacheValid()) {
    return true;
  }

  if (progressBar) progressBar.value = 0;
  if (statusText) {
    statusText.textContent = "変換中...";
    statusText.className = "status-text saving";
  }

  uploadState.getResults().forEach((result) => {
    if (result) {
      if (result.url) URL.revokeObjectURL(result.url);
      if (result.previewUrl) URL.revokeObjectURL(result.previewUrl);
    }
  });
  uploadState.clearResults();
  render();
  setUiLock(true);

  try {
    uploadState.beginConversion();

    const conversionPromises = uploadState.getFiles().map((file, index) =>
      convertImage(file, index).then(result => {
        uploadState.setResult(index, result);
        const finishedCount = uploadState.getResults().filter(r => r !== null).length;
        if (progressBar) progressBar.value = Math.round((finishedCount / uploadState.getFiles().length) * 100);
        render();
      })
    );
    await Promise.all(conversionPromises);
    uploadState.completeConversion(getCurrentConfigSignature());
    if (statusText) {
      statusText.textContent = "変換完了";
      statusText.className = "status-text";
    }
    return true;
  } catch (error) {
    safeConsole.error("Conversion error:", error);
    uploadState.invalidateConversion();
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

const { ensureStorageCapacityFilebase, ensureStorageCapacityR2 } = createStorageCapacityExecution({
  getSetting: key => localStorage.getItem(key),
  checkKuboOnline, getAppLanguage, getKuboPinnedCids, formatBytes, getStoredIpfsCid,
  getManagedContents: () => managedController.getContents(), getObjectRefForUi,
  activeKuboPins, ensureAuthoritativeKuboPin, requestAuthorizedRelease,
  loadLedgerFromLocalStorage, calculateFilebaseCid, kuboPlacementApplication,
  addFileToKubo, storeIpfsCid, storeR2Hash, deleteR2Hash,
});

const prepareManagedUpload = createManagedPreflight({ lifecycleRequest, linkBindingRequest,
  getSelectedR2Domain, getCurrentOrigin: () => window.location.origin,
  buildKvKey, getIpfsCidFromS3Response });
const queueVideoThumbnail = createVideoThumbnailRegistration({ hasAdminAccess, getCustomKvWorkerUrl, getAdminApiToken,
  cachePreview: (objectId, blob) => videoPreviewCache.write(objectId, blob),
  onPreviewCached: objectId => {
    for (const card of r2FileList.querySelectorAll("article.result-item")) {
      if (card.dataset.objectid === objectId) void showVideoPreview(card, objectId);
    }
  },
});
const executeUpload = createUploadOrchestrator({
  getS3Client, getBucketName, hasAdminAccess, calculateFilebaseCid,
  prepareManagedUpload, linkBindingRequest, lifecycleRequest, registerKvCid,
  findFilebaseObjectByCid, findR2ObjectByHash, ensureStorageCapacityFilebase,
  ensureStorageCapacityR2, safeDeleteS3Objects, getSelectedR2Domain, buildKvKey,
  getSelectedDeliveryUrl, getKvDeliveryBaseDomain, checkKuboPinned, isValidIpfsCid,
  setFileStoredDomain, addOrUpdateLocalLedgerItem, markCivitaiTemporaryTransfer,
  storeIpfsCid, storeR2Hash, extractCleanHost, isConversionEnabled,
  onFileState: () => render(),
  onError: message => alert(redactSecrets(message)),
  onUploadLimit: size => {
    const dict = i18nDict[getAppLanguage()] || i18nDict.ja;
    return showCustomAlert(dict.uploadLimitError.replace("{size}", size), "⚠️ 容量オーバー");
  },
  onPublicUrl: (key, url) => {
    paletteFiles.unshift({ key, url });
    renderUrlPalette();
  },
  recordWorkflow: recordUploadedWorkflow,
  queueVideoThumbnail,
});

// DOM inputs are captured at the presentation boundary; upload execution
// and provider sequencing belong to the upload feature.
async function uploadImage(result, targetProvider = "r2", customPassword = null, uploadOptions = {}) {
  const dict = i18nDict[getAppLanguage()] || i18nDict.ja;
  return executeUpload(result, targetProvider, customPassword, {
    ...uploadOptions,
    password: uploadOptions.password ?? (document.querySelector("#tempPasswordInput")?.value.trim() || ""),
    requestedTtl: uploadOptions.requestedTtl ?? Number(document.querySelector("#tempTtlSelect")?.value || 0),
    cachePolicy: uploadOptions.cachePolicy ?? (document.querySelector("#uploadCachePolicySelect")?.value === "PUBLISHED" ? "PUBLISHED" : "BOARD"),
    origin: window.location.origin,
    formatLimitError: size => dict.uploadLimitError.replace("{size}", size),
  });
}

// --- 一括アップロード共通処理 ---
const requestUploadDestination = createUploadDestinationGuard({
  getDomain: getSelectedR2Domain, getDomains: getR2DomainList,
  isConfigured: provider => {
    try { return (provider === "filebase" ? isFilebaseConfigured() : isR2Configured()) && Boolean(getS3Client(provider)); }
    catch (_) { return false; }
  },
  // Existing standalone/direct-origin operation remains valid. Managed Pages
  // relays must prove their own canonical relay identity before any upload.
  requiresRelay: domain => hasAdminAccess() && new URL(domain).hostname.endsWith(".pages.dev"),
  verifyRelay: verifyDomainCompatLayer,
  onIssue: async (provider, issue) => {
    const english = getAppLanguage() === "en";
    const name = provider === "filebase" ? "Filebase" : "R2";
    const messages = english ? {
      storage: `Complete the ${name} connection settings before uploading.`,
      domain: `Select or register a valid ${name} delivery domain before uploading.`,
      relay: "The selected delivery domain could not be verified. Check its redirect and Worker allowlist, then run the connection test.",
    } : {
      storage: `${name}の接続設定を先に完了してください。`,
      domain: `${name}の配信ドメインを選択・登録してください。`,
      relay: "選択した配信ドメインへの接続を確認できませんでした。リダイレクトとWorkerの許可設定を確認し、接続テストを行ってください。",
    };
    const open = await showCustomConfirm(messages[issue], english ? "Upload settings required" : "アップロード設定が必要です",
      english ? "Open settings" : "設定を開く", english ? "Cancel" : "キャンセル");
    if (!open) return;
    const accordion = document.getElementById(provider === "filebase" ? "filebaseSettingsAccordion" : "r2SettingsAccordion");
    if (!accordion) return;
    for (let node = accordion; node; node = node.parentElement) if (node.tagName === "DETAILS") node.open = true;
    accordion.scrollIntoView({ behavior: "smooth", block: "center" });
    const field = document.getElementById(issue === "storage"
      ? (provider === "filebase" ? "filebaseBucket" : "r2AccountId")
      : (provider === "filebase" ? "filebaseDomainSelect" : "r2DomainSelect"));
    field?.focus({ preventScroll: true });
    // Opening settings never resumes the upload automatically.
  },
});

async function handleBatchUpload(targetProvider) {
  if (!uploadState.getFiles().length || uploadDestinationBusy) return;
  uploadDestinationBusy = true;
  const providerLabel = targetProvider === "filebase" ? "Filebase" : "R2";
  try {
    setUiLock(true);
    const destination = await requestUploadDestination(targetProvider);
    if (!destination) return;
    const options = {
      deliveryDomain: destination.domain,
      password: document.querySelector("#tempPasswordInput")?.value.trim() || "",
      requestedTtl: Number(document.querySelector("#tempTtlSelect")?.value || 0),
      cachePolicy: document.querySelector("#uploadCachePolicySelect")?.value === "PUBLISHED" ? "PUBLISHED" : "BOARD",
    };
    const success = await runConversion();
    if (!success) return;
    const targets = uploadState.getResults().filter(r => r && !r.isUploaded && !r.isUploading);
    if (!targets.length) return;
    setUiLock(true);
    if (statusText) statusText.className = "status-text saving";
    if (progressBar) progressBar.value = 0;
    let completed = 0;
    for (let i = 0; i < targets.length; i++) {
      const result = targets[i];
      if (statusText) statusText.textContent = `${providerLabel} アップロード中 (${i + 1}/${targets.length})`;
      const uploadSuccess = await uploadImage(result, targetProvider, null, options);
      if (!uploadSuccess) {
        break;
      }
      completed++;
      if (progressBar) progressBar.value = Math.round(((i + 1) / targets.length) * 100);
    }
    if (statusText) {
      statusText.textContent = completed === targets.length ? `${providerLabel} 一括アップロード完了` : `${providerLabel} アップロードを中止 (${completed}/${targets.length})`;
      statusText.className = "status-text";
    }
  } catch (error) {
    safeConsole.error("Upload failed:", error);
    if (statusText) {
      statusText.textContent = `アップロード失敗: ${redactSecrets(error.message)}`;
      statusText.className = "status-text error";
    }
  } finally {
    uploadDestinationBusy = false;
    setUiLock(false);
    // 🚀 [INV-CORE-005] Local-First 原則: 手元台帳が既にオプティミスティック更新されているため、
    // サーバーへの再フェッチ通信は不要。手元台帳から再描画するだけで完了！
    renderCurrentStoragePage();
  }
}

uploadButton?.addEventListener("click", () => handleBatchUpload(uploadProviderSelect?.value || "r2"));

convertDownloadButton?.addEventListener("click", async () => {
  const success = await runConversion();
  if (!success) return;

  const isZipOn = enableZipCheck?.checked ?? false;
  const validResults = uploadState.getResults().filter(r => r && r.blob);

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
      safeConsole.error("ZIP creation error:", err);
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
    for (const result of uploadState.getResults()) {
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
    if (managedController.getView() === "filebase") {
      storageTabFilebase.style.border = "1px solid #38bdf8";
      storageTabFilebase.style.background = "rgba(56, 189, 248, 0.15)";
      storageTabFilebase.style.color = "#38bdf8";
      storageTabFilebase.style.fontWeight = "700";

      storageTabR2.style.border = "1px solid var(--border)";
      storageTabR2.style.background = "rgba(255, 255, 255, 0.04)";
      storageTabR2.style.color = "var(--muted)";
      storageTabR2.style.fontWeight = "600";

    } else if (managedController.getView() === "r2") {
      storageTabR2.style.border = "1px solid #f97316";
      storageTabR2.style.background = "rgba(249, 115, 22, 0.15)";
      storageTabR2.style.color = "#fb923c";
      storageTabR2.style.fontWeight = "700";

      storageTabFilebase.style.border = "1px solid var(--border)";
      storageTabFilebase.style.background = "rgba(255, 255, 255, 0.04)";
      storageTabFilebase.style.color = "var(--muted)";
      storageTabFilebase.style.fontWeight = "600";

    } else {
      for (const button of [storageTabR2, storageTabFilebase]) {
        button.style.border = "1px solid var(--border)";
        button.style.background = "rgba(255, 255, 255, 0.04)";
        button.style.color = "var(--muted)";
        button.style.fontWeight = "600";
      }
    }
  }
  if (storageTabAll) {
    storageTabAll.style.border = managedController.getView() === "all" ? "1px solid #a5b4fc" : "1px solid var(--border)";
    storageTabAll.style.background = managedController.getView() === "all" ? "rgba(165,180,252,0.15)" : "rgba(255,255,255,0.04)";
    storageTabAll.style.color = managedController.getView() === "all" ? "#c7d2fe" : "var(--muted)";
  }
  // Capacity and FIFO controls act on one provider, never on the All view.
  const usage = document.querySelector("#storageUsage");
  if (usage) usage.style.display = managedController.getView() === "all" ? "none" : "flex";
  if (autoFifoLabel) autoFifoLabel.style.display = managedController.getView() === "all" ? "none" : "inline-flex";
  const r2WarningBadge = document.querySelector("#r2BillingWarningBadge");
  if (r2WarningBadge) {
    r2WarningBadge.style.display = managedController.getView() !== "r2" ? "none" : "inline-flex";
  }
  syncAutoFifoControl();
}

function syncAutoFifoControl() {
  if (!autoFifoCheckbox || !autoFifoLabel) return;
  const isFilebase = managedController.getActiveProvider() === "filebase";
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

  if (managedController.getPerPage() <= 0) {
    // 「すべて」表示
    managedController.clampPage(totalItems);
    r2PageInfo.textContent = getAppLanguage() === "en" ? `${labels.all} ${totalItems} ${labels.items}` : `${labels.all} ${totalItems} ${labels.items}`;
    r2PrevPageBtn.disabled = true;
    r2NextPageBtn.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / managedController.getPerPage()));
  managedController.clampPage(totalItems);

  r2PageInfo.textContent = `${managedController.getPage()} / ${totalPages} (${totalItems}${getAppLanguage() === "en" ? ` ${labels.items}` : labels.items})`;
  r2PrevPageBtn.disabled = managedController.getPage() <= 1;
  r2NextPageBtn.disabled = managedController.getPage() >= totalPages;

  if (r2PerPageSelect) {
    r2PerPageSelect.value = String(managedController.getPerPage());
  }
}

// ◀ 前へ
r2PrevPageBtn?.addEventListener("click", () => {
  if (managedController.getPage() > 1) {
    managedController.previousPage();
    renderCurrentStoragePage();
  }
});

// ▶ 次へ
r2NextPageBtn?.addEventListener("click", () => {
  const visibleCount = getVisibleManagedContents().length;
  const totalPages = Math.max(1, Math.ceil(visibleCount / (managedController.getPerPage() || 1)));
  if (managedController.getPage() < totalPages) {
    managedController.nextPage(visibleCount);
    renderCurrentStoragePage();
  }
});

// 表示件数変更
r2PerPageSelect?.addEventListener("change", (e) => {
  managedController.setPerPage(parseInt(e.target.value, 10));
  localStorage.setItem("storagePerPage", String(managedController.getPerPage()));
  renderCurrentStoragePage();
});

function getVisibleManagedContents() {
  return managedController.visible();
}

function selectManagedStorageView(view) {
  managedController.selectView(view);
  if (view !== "all") {
    localStorage.setItem("activeStorageTab", view);
    syncStorageLimitControl();
    renderR2DomainSelect(view);
  }
  updateStorageTabsUi();
  recalculateStorageUsage(managedController.getActiveProvider());
  renderCurrentStoragePage();
  updateSelectedR2ActionButtonsState();
}

storageTabAll?.addEventListener("click", () => selectManagedStorageView("all"));
storageTabR2?.addEventListener("click", () => {
  selectManagedStorageView("r2");
});

storageTabFilebase?.addEventListener("click", () => {
  selectManagedStorageView("filebase");
});

reloadR2FilesButton?.addEventListener("click", () => {
  managedController.resetPage();
  fetchAndRenderR2Files({ forceRefresh: true, cleanupExpiredCivitaiTransfers: true });
});

// 🚀 初回オンボーディング（設定・接続案内カード）の描画
function renderStorageOnboardingCard() {
  if (!r2FileList) return;

  const isFb = managedController.getActiveProvider() === "filebase";
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
            <input type="password" id="obAdminToken" placeholder="${isEnglish ? "e.g. your-secret-token" : "例: your-secret-token"}">
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
              <input type="text" id="obFbKey" placeholder="例: E39D98762...">
            </div>
            <div class="onboarding-input-field">
              <label>Filebase Secret Key</label>
              <input type="password" id="obFbSecret" placeholder="例: WkH18302...">
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
              <input type="text" id="obR2Key" placeholder="例: c8a1928374...">
            </div>
            <div class="onboarding-input-field">
              <label>Secret Access Key</label>
              <input type="password" id="obR2Secret" placeholder="例: 99f87654...">
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

  // Restore secrets as input properties, never as serialized HTML attributes.
  for (const [id, value] of [["obAdminToken", adminTokenVal], ["obFbKey", fbKeyVal], ["obFbSecret", fbSecretVal],
    ["obR2Key", r2KeyVal], ["obR2Secret", r2SecretVal]]) {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = value;
  }
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
    const apiEndpoint = kvUrl.endsWith("/api/cividge-kv") ? kvUrl : `${kvUrl}/api/cividge-kv`;
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
        const workerDeliveryDomain = kvUrl.replace(/\/api\/cividge-kv\/?$/, "");
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
      if (obKvStatus) obKvStatus.textContent = `⚠️ KV 接続に失敗しました: ${redactSecrets(error.message)}`;
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
      managedController.resetPage();
      await fetchAndRenderR2Files();
      if (r2FileList) {
        const notice = document.createElement("div");
        notice.className = "storage-connection-success";
        notice.textContent = `✅ ${isFb ? "Filebase" : "Cloudflare R2"} への接続に成功しました。設定を保存し、ファイル一覧を読み込みました。`;
        notice.style.cssText = "margin: 0 0 12px; padding: 10px 12px; border: 1px solid rgba(74, 222, 128, 0.45); border-radius: 7px; background: rgba(22, 163, 74, 0.12); color: #86efac; font-size: 12px;";
        r2FileList.prepend(notice);
      }
    } catch (error) {
      if (obStorageStatus) obStorageStatus.textContent = `⚠️ ${isFb ? "Filebase" : "R2"} 接続に失敗しました: ${redactSecrets(error.message)}`;
      obStorageConnectBtn.disabled = false;
      obStorageConnectBtn.textContent = originalText;
    }
  });
}

async function fetchAndRenderR2Files({ forceRefresh = false, cleanupExpiredCivitaiTransfers = false } = {}) {
  if (!r2FileList) return;
  const fetchGeneration = managedController.beginObservation({ refresh: forceRefresh });
  updateStorageTabsUi();
  managedController.seedLocalDisplay();
  if (!isR2Configured() && !isFilebaseConfigured() && !hasAdminAccess()) {
    if (managedController.getContents().length) renderCurrentStoragePage();
    else renderStorageOnboardingCard();
    if (forceRefresh) {
      managedController.finishObservation(fetchGeneration);
      r2FileList.insertAdjacentHTML("afterbegin", '<span class="item-meta error" role="status" style="padding: 18px; color: var(--danger); display: block; text-align: center;">更新できません。接続設定を確認してください。前回の一覧を保持しています</span>');
    }
    return;
  }
  // Startup and tab changes display only the local projection. The Refresh
  // button is the explicit observation boundary for KV and provider lists.
  if (!forceRefresh) {
    renderCurrentStoragePage();
    return;
  }
  try {
    if (!hasAdminAccess() && managedController.getContents().some(item => item.entryKind === "link")) {
      throw new Error("Linkの現在状態を確認できません。Workerの管理接続を設定してください");
    }
    // One delivery projection for both placement views. Provider observations
    // are joined to this same generation; a tab switch never starts a fetch.
    const kvFiles = await fetchKvFiles();
    if (!managedController.isCurrentObservation(fetchGeneration)) return;
    const groups = await Promise.all(["r2", "filebase"].map(provider =>
      fetchManagedProviderContents(provider, kvFiles, fetchGeneration, cleanupExpiredCivitaiTransfers)
    ));
    if (!managedController.isCurrentObservation(fetchGeneration)) {
      // An explicit refresh may retire an expired temporary transfer. Its
      // mutation invalidates this read; acquire one new common generation.
      if (cleanupExpiredCivitaiTransfers) await fetchAndRenderR2Files({ forceRefresh: true });
      return;
    }
    if (!managedController.adoptObservation(groups, fetchGeneration)) return;
    paletteFiles = managedController.getContents().map(item => {
      const key = item.rawKey || item.Key || "";
      const domain = getFileStoredDomain(key, item.Key || "", item.metadata?.allowedHost || item.metadata?.d || "").replace(/\/$/, "");
      return { key: item.Key, url: `${domain}/${encodeURIComponent(item.Key)}` };
    });
    renderUrlPalette();
    recalculateStorageUsage(managedController.getActiveProvider());
    renderCurrentStoragePage();
    auditDriftingFiles(managedController.getContents());
  } catch (error) {
    if (!managedController.isCurrentObservation(fetchGeneration)) return;
    managedController.finishObservation(fetchGeneration);
    safeConsole.error("Storage fetch error:", error);
    renderCurrentStoragePage();
    r2FileList.insertAdjacentHTML("afterbegin", `<span class="item-meta error" role="status" style="padding: 18px; color: var(--danger); display: block; text-align: center;">${escapeHtml(getStorageListLabels().connectionError)} ${escapeHtml(error.message)} — 前回の一覧を表示しています</span>`);
  }
}

async function fetchManagedProviderContents(requestedProvider, canonicalKvFiles, fetchGeneration, cleanupExpiredCivitaiTransfers) {
  if (!managedController.isCurrentObservation(fetchGeneration)) return [];

  const isFilebase = requestedProvider === "filebase";
  const s3 = getS3Client(requestedProvider);
  const bucketName = getBucketName(requestedProvider);
  const providerLabel = isFilebase ? "Filebase (IPFS)" : "Cloudflare R2";
  const isStorageConfigured = isFilebase ? isFilebaseConfigured() : isR2Configured();
  const hasKvAccess = hasAdminAccess();

  // 🌟 ストレージ未設定、かつ KV台帳連携もない場合のみオンボーディングカードを描画。
  // KV台帳連携がある場合は、S3秘密鍵が端末に入っていなくてもKV台帳ビュー（閲覧・共有専用）として一覧を表示！
  if ((!isStorageConfigured || !s3 || !bucketName) && !hasKvAccess) return [];

  const isViewerMode = (!isStorageConfigured || !s3 || !bucketName) && hasKvAccess;
  if (!managedController.getContents().length) r2FileList.innerHTML = `<span class="status-text saving" style="padding: 18px; display: block;">${providerLabel}${isViewerMode ? " (KV台帳モード)" : ""} ファイル一覧を取得中...</span>`;

  try {
    let s3RawList = [];
    if (s3 && bucketName) {
      let continuationToken;
      do {
        const response = await s3.send(new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }));
        s3RawList.push(...(response.Contents || []).map(item => ({
          Key: item.Key,
          Size: item.Size || 0,
          LastModified: item.LastModified,
        })));
        if (response.IsTruncated && !response.NextContinuationToken) {
          throw new Error("S3一覧の続きが取得できません");
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    if (!managedController.isCurrentObservation(fetchGeneration)) return [];
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

      const kvFiles = canonicalKvFiles.map(item => ({ ...item, metadata: { ...item.metadata } }));

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
      // ドメイン付き正規キー（host:filename）を優先処理し、同一ドメインの重複を排除
      kvFiles.sort((a, b) => (b.name.includes(":") ? 1 : 0) - (a.name.includes(":") ? 1 : 0));
      const seenDomainFiles = new Set();

      for (const kvItem of kvFiles) {
        const rawKey = kvItem.name;
        // hostname:filename の形式（別ドメイン個別キー）なら表示ファイル名を抽出
        const colonIdx = rawKey.indexOf(":");
        const displayName = (colonIdx > 0 && !rawKey.startsWith("blob_"))
          ? rawKey.substring(colonIdx + 1)
          : rawKey;

        const itemDomain = (colonIdx > 0 ? rawKey.split(":")[0] : (kvItem.metadata?.d || kvItem.metadata?.allowedHost || "")).toLowerCase().trim();
        const domainFileKey = `${itemDomain}:${displayName}`;
        if (itemDomain && seenDomainFiles.has(domainFileKey)) {
          continue; // 同一ドメインかつ同一ファイル名の重複カードを排除
        }
        if (itemDomain) seenDomainFiles.add(domainFileKey);

        const kvCid = kvItem.metadata?.cid || getStoredIpfsCid(rawKey) || getStoredIpfsCid(displayName);
        const recordedS3Key = kvItem.metadata?.s3Key;

        // 🪐 Filebase タブ: R2 ストレージ専用レコードは除外する [INV-FRONT-005]
        const projectedBackend = kvItem.metadata?.backend || kvItem.metadata?.b;
        const isExplicitFilebase = projectedBackend === "filebase" || projectedBackend === "filebase_rpc";
        const isExplicitR2 = kvItem.metadata?.backend === "r2" || kvItem.metadata?.b === "r2";
        
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
            entryKind: "link",
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
            entryKind: "link",
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
      const retiredLocalEntries = getRetiredLocalEntries(requestedProvider);
      for (const s3Item of s3RawList) {
        // Content-addressed physical objects without a projected Link are
        // pending Placement observations, never Managed Link cards.
        if (s3Item.Key.startsWith("objects/")) continue;
        if (!consumedS3Keys.has(s3Item.Key) && !retiredLocalEntries.has(s3Item.Key)) {
          contents.push({
            storageProvider: "filebase",
            entryKind: "local",
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

      const kvFiles = canonicalKvFiles.map(item => ({ ...item, metadata: { ...item.metadata } }));

      const consumedS3Keys = new Set();
      const processedPhysicalKeys = new Set();

      // 1. R2 に属する KV レコード（ドメイン別エイリアスを含む）を走査してカード化
      kvFiles.sort((a, b) => (b.name.includes(":") ? 1 : 0) - (a.name.includes(":") ? 1 : 0));
      const seenR2DomainFiles = new Set();
      const cleanHostFn = (val) => String(val || "").trim().toLowerCase().replace(/^https?:\/\//, "").split('/')[0].split(':')[0];

      for (const kvItem of kvFiles) {
        const rawKey = kvItem.name;
        if (!rawKey || rawKey.startsWith("blob_")) continue;

        const colonIdx = rawKey.indexOf(":");
        const displayName = (colonIdx > 0)
          ? rawKey.substring(colonIdx + 1)
          : rawKey;

        const rawDomainVal = colonIdx > 0 ? rawKey.split(":")[0] : (kvItem.metadata?.d || kvItem.metadata?.allowedHost || baseDomain || "");
        const itemDomain = cleanHostFn(rawDomainVal);
        const domainFileKey = `${itemDomain}:${displayName}`;
        if (itemDomain && seenR2DomainFiles.has(domainFileKey)) {
          continue; // 同一ドメインかつ同一ファイル名の重複カードを排除
        }
        if (itemDomain) seenR2DomainFiles.add(domainFileKey);

        const kvCid = kvItem.metadata?.cid || kvItem.metadata?.c || kvItem.value || getStoredIpfsCid(rawKey) || getStoredIpfsCid(displayName) || "";
        const isExplicitFilebase = kvItem.metadata?.backend === "filebase" || kvItem.metadata?.b === "filebase";
        if (isExplicitFilebase) {
          continue; // 🚨 [INV-FRONT-005] Filebase レコードは絶対に R2 一覧に混入させない！
        }

        const isExplicitR2 = kvItem.metadata?.backend === "r2" || kvItem.metadata?.b === "r2";
        const hasIpfsCid = Boolean(kvCid && isValidIpfsCid(kvCid));
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

        // R2 明示レコード、または R2 バケット内の実体とマッチするレコードのみ対象（Viewerモード時もIPFS CID持ちは除外）
        const isR2Record = isExplicitR2 || Boolean(matchedS3) || (isViewerMode && !isExplicitFilebase && !hasIpfsCid);
        if (!isR2Record) continue;

        if (matchedS3) {
          consumedS3Keys.add(matchedS3.Key);
          processedPhysicalKeys.add(matchedS3.Key);
        }
        if (recordedS3Key) processedPhysicalKeys.add(recordedS3Key);
        processedPhysicalKeys.add(displayName);

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
          entryKind: "link",
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
      const retiredLocalEntries = getRetiredLocalEntries(requestedProvider);
      for (const s3Item of s3RawList) {
        if (s3Item.Key.startsWith("objects/")) continue;
        if (isWorkerDerivedR2Key(s3Item.Key)) continue;
        if (!consumedS3Keys.has(s3Item.Key) && !processedPhysicalKeys.has(s3Item.Key) && !retiredLocalEntries.has(s3Item.Key)) {
          const rawS3Cid = getStoredIpfsCid(s3Item.Key);
          const s3Cid = isValidIpfsCid(rawS3Cid) ? rawS3Cid : null;
          contents.push({
            storageProvider: "r2",
            entryKind: "local",
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

    // A physical-list observation may update a local entry's presence, but it
    // cannot silently retire that UI entry. Only retireManagedEntry can do so.
    const observedLocalIds = new Set(contents.filter(item => item.entryKind === "local").map(localEntryIdentity));
    const retiredLocalEntries = getRetiredLocalEntries(requestedProvider);
    for (const cached of loadLedgerFromLocalStorage(requestedProvider)) {
      if (cached.entryKind !== "local") continue;
      const identity = localEntryIdentity(cached);
      if (!identity || retiredLocalEntries.has(identity) || observedLocalIds.has(identity)) continue;
      contents.push({ ...cached, isFromS3: false });
      observedLocalIds.add(identity);
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

    // ⏳ 期限切れアイテムの一覧非表示化
    // [INV-CORE-001] [INV-CORE-004] 画面表示・閲覧時に裏で勝手に cleanupExpiredStorageItems() を
    // 発火させて deleteKvCid() 連打（書き込み枠浪費）を行う副作用を完全撤去。
    // 画面上での非表示フィルタリングのみを行う。公開GETはread-onlyであり、
    // Link回収とPlacement解放は明示的なlifecycle mutationだけが行う。
    if (contents.length > 0) {
      const nowMs = Date.now();
      const expiredKeySet = new Set(
        contents.filter(item => item.expiresAt && nowMs > Number(item.expiresAt)).map(i => i.rawKey || i.Key)
      );
      if (expiredKeySet.size > 0) {
        contents = contents.filter(i => !expiredKeySet.has(i.rawKey || i.Key));
      }
    }

    // [INV-CORE-001] [INV-CORE-004] 一覧更新時の Passive FIFO 自動発火（ensureStorageCapacityFilebase）を完全撤去。
    // 一覧画面を開いただけで勝手にアンピン＆KV書き込み連打が走る副作用の密輸を根絶。
    // FIFO による容量解放はアップロード時（uploadFiles）の容量不足判定時のみ実行する。

    const driftRetention = getDriftFailCounts();
    contents = contents.filter(item => !isDriftRetired(driftRetention[item.rawKey || item.Key]));

    // （※ 自宅 Kubo 遅延マイグレーションは一覧描画後に実行します）

    if (!managedController.isCurrentObservation(fetchGeneration)) return [];
    if (contents.length === 0) return [];

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

    // Capacity display is derived from the committed shared snapshot.

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

    if (isFilebase && s3 && bucketName) {
      const current = () => managedController.isCurrentObservation(fetchGeneration);
      await observeMissingFilebaseCids(contents, {
        cachedCid: getStoredIpfsCid,
        validCid: isValidIpfsCid,
        isCurrent: current,
        headCid: async key => getIpfsCidFromS3Response(await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }))),
        onResolved: (key, cid, rows) => {
          storeIpfsCid(key, cid);
          for (const row of rows) {
            storeIpfsCid(row.rawKey || row.Key, cid);
            storeIpfsCid(row.Key, cid);
          }
        },
      });
    }

    // 全件キャッシュとページネーションUI更新
    if (!managedController.isCurrentObservation(fetchGeneration)) return [];
    return contents;
  } catch (error) {
    if (!managedController.isCurrentObservation(fetchGeneration)) return [];
    throw error;
  }
}

async function cleanupExpiredCivitaiTransferItems(expiredItems, allItems, s3, bucketName, provider) {
  const cleanedKeys = new Set();
  const targetProvider = normalizeDeliveryProvider(provider);
  const isFilebase = targetProvider === "filebase";

  for (const item of expiredItems) {
    const key = item.rawKey || item.Key;
    const s3Key = item.s3Key || item.Key;
    if (!key) continue;

    // 🛡️ ストレージ分離ガード: 現在開いているストレージ（provider）とアイテムの所属が不一致なら絶対にKV削除しない
    const itemProvider = item.storageProvider;
    if (itemProvider !== "r2" && itemProvider !== "filebase") continue;
    if (itemProvider !== targetProvider) {
      continue;
    }

    try {
      const deleted = await deleteKvCid(key, item.metadata?.g);
      await requestAuthorizedRelease(deleted?.objectRef, "civitai-temporary").catch(error => {
        safeConsole.warn("Civitai lifecycle release deferred:", error);
      });
      clearCivitaiTemporaryTransfer(provider, s3Key);
      clearCivitaiTemporaryTransfer(provider, key);
      cleanedKeys.add(key);
    } catch (err) {
      safeConsole.warn("Civitai temporary transfer cleanup failed:", key, err);
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
    if (!key) continue;

    // 🛡️ ストレージ分離ガード: 現在開いているストレージ（provider）とアイテムの所属が不一致なら絶対にKV削除しない
    const itemProvider = item.storageProvider;
    if (itemProvider !== "r2" && itemProvider !== "filebase") continue;
    if (itemProvider !== targetProvider) {
      continue;
    }

    try {
      safeConsole.log(`⏳ 期限切れLinkを回収: ${key}`);
      const deleted = await deleteKvCid(key, item.metadata?.g);
      await requestAuthorizedRelease(deleted?.objectRef, "expiry").catch(error => {
        safeConsole.warn("Expiry lifecycle release deferred:", error);
      });
      cleanedKeys.add(key);
    } catch (err) {
      safeConsole.warn("Expired storage item cleanup failed:", key, err);
    }
  }
  return cleanedKeys;
}

// [INV-CORE-001] [INV-CORE-003] 画面表示時にR2ファイルを全ダウンロードして裏でCID計算・KV書き込み連打する
// 過剰自己修復コード（resolveR2CardCidAuto）は帯域・CPU・書き込み枠浪費防止のため完全撤去。


// 📄 現在のページに該当するストレージカード群をDOM描画
async function showVideoPreview(article, objectId, publicUrl = article.dataset.previewurl) {
  return showManagedVideoPreview(article, objectId, publicUrl, videoPreviewCache);
}

function renderCurrentStoragePage() {
  if (!r2FileList) return;
  const lang = getAppLanguage();
  const dict = i18nDict[lang] || i18nDict.ja;
  // 取得元が現在タブと一致するカードだけを描画する。非同期取得中の旧タブ
  // データや、旧バージョンがメモリに残した未分類データを表示しない。
  const visibleContents = getVisibleManagedContents();
  const totalItems = visibleContents.length;
  const labels = getStorageListLabels();

  updateStoragePaginationUI(totalItems);

  r2FileList.innerHTML = "";
  if (totalItems === 0) {
    r2FileList.innerHTML = `<span class="item-meta" style="padding: 18px; color: var(--muted); display: block; text-align: center;">${escapeHtml(dict.noFilesR2)}</span>`;
    return;
  }

  // 表示件数に合わせてスライス
  const pageItems = managedController.visiblePage();

  const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";

  pageItems.forEach(item => {
    const isFilebase = item.storageProvider === "filebase";
    const baseDomain = (getSelectedR2Domain(item.storageProvider) || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/$/, "");
    const article = document.createElement("article");
    article.className = "result-item";
    const ext = item.Key ? item.Key.split('.').pop().toLowerCase() : "";
    const isVideo = ["mp4", "webm", "ogv", "mov", "m4v"].includes(ext);
    const isImage = ["jpg", "jpeg", "png", "webp", "gif", "avif", "jxl"].includes(ext);
    
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

    const hasPassword = Boolean(item.isPasswordProtected || item.password || item.metadata?.passwordHash || item.metadata?.password);
    const canUseCivitai = canUseCivitaiPostIntent({ name: itemDisplayName, mimeType: item.metadata?.mime || item.mime });
    const pwdBadgeHtml = hasPassword
      ? `<span class="password-badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.5); font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 3px;" title="${escapeHtml(labels.protected)}">🔒 ${escapeHtml(labels.protected)}</span>`
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
      // The original public image is its preview, including for locally restored rows.
      thumbHtml = `<img class="thumb" alt="" src="${escapeHtml(publicUrl)}" loading="lazy">`;
    } else if (isVideo) {
      thumbHtml = `<div class="thumb format-badge">VIDEO</div>`;
    } else {
      thumbHtml = `<div class="thumb format-badge">${escapeHtml(ext.toUpperCase() || "FILE")}</div>`;
    }

    const dateStr = item.LastModified ? new Date(item.LastModified).toLocaleDateString() : "";

    let storageTierHtml = "";
    let actionButtonsHtml = "";

    if (isFilebase) {
      const isFromS3 = Boolean(item.isFromS3);
      const isRpcPlacement = (item.metadata?.backend || item.metadata?.b) === "filebase_rpc";
      const isRpcPresent = isRpcPlacement && !Boolean(item.metadata?.unpinned);
      const isKuboPinned = item.metadata?.kuboStatus === "pinned";
      const kuboPlacementState = item.metadata?.kuboPlacementState || item.kuboPlacementState ||
        (isKuboPinned ? KUBO_PLACEMENT_STATE.PRESENT : KUBO_PLACEMENT_STATE.ABSENT);

      const fbBadgeHtml = isRpcPlacement
        ? `<span style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: ${isRpcPresent ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.12)"}; color: ${isRpcPresent ? "#22c55e" : "#94a3b8"}; border: 1px solid ${isRpcPresent ? "rgba(34,197,94,0.4)" : "rgba(148,163,184,0.3)"}; font-weight: 600;">Filebase RPC: ${isRpcPresent ? (lang === "en" ? "stored" : "保持中") : (lang === "en" ? "released" : "未保持")}</span>`
        : isFromS3
        ? `<button type="button" class="unpin-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${labels.filebaseStored}</button>`
        : `<span style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; cursor: help;" title="${escapeHtml(labels.filebaseRemovedTooltip || "")}">${labels.filebaseRemoved}</span>`;

      let kuboBadgeHtml = "";
      if (!isKuboAutoPin) {
        kuboBadgeHtml = `<span class="kubo-badge-${escapeHtml(itemKey)}" style="font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.08); color: #64748b; border: 1px dashed rgba(148,163,184,0.25); font-weight: 500; cursor: not-allowed; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboOff}</span>`;
      } else if (isKuboPinned) {
        kuboBadgeHtml = `<button type="button" class="kubo-unpin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(168,85,247,0.15); color: #c084fc; border: 1px solid rgba(168,85,247,0.4); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboStored}</button>`;
      } else if (kuboPlacementState === KUBO_PLACEMENT_STATE.PIN_REQUESTED || kuboPlacementState === KUBO_PLACEMENT_STATE.PINNING) {
        const stateText = kuboPlacementState === KUBO_PLACEMENT_STATE.PINNING
          ? (lang === "en" ? "Kubo: syncing" : "Kubo: 同期中")
          : (lang === "en" ? "Kubo: requested" : "Kubo: Pin要求済み");
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" data-placement-state="${escapeHtml(kuboPlacementState)}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(56,189,248,0.12); color: #38bdf8; border: 1px solid rgba(56,189,248,0.35); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;" title="${lang === "en" ? "Click to resume authoritative confirmation" : "クリックしてauthorityの確認を再開"}">⏳ ${stateText}</button>`;
      } else if (kuboPlacementState === KUBO_PLACEMENT_STATE.RETRYABLE) {
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" data-placement-state="RETRYABLE" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(245,158,11,0.12); color: #fbbf24; border: 1px solid rgba(245,158,11,0.35); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">↻ ${lang === "en" ? "Kubo: retry" : "Kubo: 再試行"}</button>`;
      } else if (itemCid) {
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(148,163,184,0.12); color: #94a3b8; border: 1px dashed rgba(148,163,184,0.3); font-weight: 500; display: inline-flex; align-items: center; gap: 3px;">${labels.kuboMissing}</button>`;
      }

      let driftingBadgeHtml = "";
      const hasKuboRecord = isKuboPinned || item.metadata?.kuboStatus === "pinned" || item.kuboStatus === "pinned";
      if (!isFromS3 && !isRpcPresent && !hasKuboRecord) {
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
        ${canUseCivitai ? `<button type="button" class="ghost-button civitai-r2-post-btn" data-url="${escapeHtml(publicUrl)}" data-name="${escapeHtml(itemDisplayName)}" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); ${hasPassword ? 'opacity: 0.35; cursor: not-allowed;' : ''}" title="${hasPassword ? 'パスワード保護中のファイルはCivitai連携不可' : 'Civitai の投稿画面を開く'}" ${hasPassword ? 'disabled' : ''}>🎨 Civitai</button>` : ""}
        <button type="button" class="ghost-button danger-button delete-r2-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" data-origin="${isFromS3 ? '1' : '0'}">${item.entryKind === "local" ? (lang === "en" ? "Remove from list" : "一覧から退場") : labels.delete}</button>
      `;
    } else {
      const isFromS3 = Boolean(item.isFromS3);
      const isKuboPinned = item.metadata?.kuboStatus === "pinned";
      const kuboPlacementState = item.metadata?.kuboPlacementState || item.kuboPlacementState ||
        (isKuboPinned ? KUBO_PLACEMENT_STATE.PRESENT : KUBO_PLACEMENT_STATE.ABSENT);

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
      } else if (kuboPlacementState === KUBO_PLACEMENT_STATE.PIN_REQUESTED || kuboPlacementState === KUBO_PLACEMENT_STATE.PINNING) {
        const stateText = kuboPlacementState === KUBO_PLACEMENT_STATE.PINNING
          ? (lang === "en" ? "Kubo: syncing" : "Kubo: 同期中")
          : (lang === "en" ? "Kubo: requested" : "Kubo: Pin要求済み");
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-provider="r2" data-placement-state="${escapeHtml(kuboPlacementState)}" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(56,189,248,0.12); color: #38bdf8; border: 1px solid rgba(56,189,248,0.35); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">⏳ ${stateText}</button>`;
      } else if (kuboPlacementState === KUBO_PLACEMENT_STATE.RETRYABLE) {
        kuboBadgeHtml = `<button type="button" class="kubo-pin-manual-btn kubo-badge-${escapeHtml(itemKey)}" data-key="${escapeHtml(itemKey)}" data-cid="${escapeHtml(itemCid || "")}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-provider="r2" data-placement-state="RETRYABLE" style="cursor: pointer; font-size: 10px; padding: 2px 7px; border-radius: 4px; background: rgba(245,158,11,0.12); color: #fbbf24; border: 1px solid rgba(245,158,11,0.35); font-weight: 600; display: inline-flex; align-items: center; gap: 3px;">↻ ${lang === "en" ? "Kubo: retry" : "Kubo: 再試行"}</button>`;
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
        ${canUseCivitai ? `<button type="button" class="ghost-button civitai-r2-post-btn" data-url="${escapeHtml(publicUrl)}" data-name="${escapeHtml(itemDisplayName)}" style="color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); ${hasPassword ? 'opacity: 0.35; cursor: not-allowed;' : ''}" title="${hasPassword ? 'パスワード保護中のファイルはCivitai連携不可' : 'Civitai の投稿画面を開く'}" ${hasPassword ? 'disabled' : ''}>🎨 Civitai</button>` : ""}
        <button type="button" class="ghost-button danger-button delete-r2-file-btn" data-key="${escapeHtml(itemKey)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-cid="${escapeHtml(itemCid || "")}" data-origin="${item.isFromS3 ? '1' : '0'}">${item.entryKind === "local" ? (lang === "en" ? "Remove from list" : "一覧から退場") : escapeHtml(dict.deleteNow)}</button>
      `;
    }

    const renameBtnHtml = `<button type="button" class="rename-file-btn" data-key="${escapeHtml(itemKey)}" data-displayname="${escapeHtml(itemDisplayName)}" data-s3key="${escapeHtml(item.s3Key || itemDisplayName)}" data-size="${escapeHtml(item.Size || 0)}" data-cid="${escapeHtml(itemCid || "")}" title="${escapeHtml(labels.rename)}" style="background: none; border: none; cursor: pointer; padding: 2px 4px; font-size: 14px; opacity: 0.8; transition: opacity 0.15; line-height: 1;">✏️</button>`;

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

    if (isImage && !hasPassword) {
      const image = article.querySelector(".thumb-link img.thumb");
      const showPlaceholder = failedImage => {
        const fallback = document.createElement("div");
        fallback.className = "thumb format-badge";
        fallback.textContent = ext.toUpperCase() || "IMAGE";
        failedImage.replaceWith(fallback);
      };
      if (image && ext === "jxl") attachJxlPreviewFallback(image, { onFailure: showPlaceholder });
      else image?.addEventListener("error", event => showPlaceholder(event.currentTarget), { once: true });
    }

    if (isVideo && !hasPassword) {
      article.dataset.previewurl = publicUrl;
      const knownObjectId = item.objectId || item.metadata?.oid || item.metadata?.objectId;
      if (/^sha256:[0-9a-f]{64}$/.test(knownObjectId || "")) {
        article.dataset.objectid = knownObjectId;
        void showVideoPreview(article, knownObjectId);
      } else if (item.entryKind === "link" && hasAdminAccess()) {
        // Older presentation caches may lack ObjectId. Resolve only this Link;
        // thumbnail display never requires a managed-list Refresh.
        void objectIdForManagedLink(itemKey).then(objectId => {
          if (!article.isConnected || !managedController.getContents().includes(item)) return;
          item.objectId = objectId;
          item.metadata = { ...(item.metadata || {}), oid: objectId, objectId };
          saveLedgerToLocalStorage(item.storageProvider, managedController.getContents().filter(row => row.storageProvider === item.storageProvider));
          article.dataset.objectid = objectId;
          return showVideoPreview(article, objectId);
        }).catch(() => {});
      }
    }

    if (checkRemoteFileWf(item.Key)) {
      const placeholder = article.querySelector('.r2-wf-badge-placeholder');
      if (placeholder) {
        placeholder.innerHTML = `<span class="meta-badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); font-size: 10px; padding: 1px 5px; border-radius: 4px; font-weight: 700; display: inline-flex; align-items: center; gap: 2px;" title="${escapeHtml(labels.workflow)}">🧬 WF</span>`;
      }
    }

  });

  if (visibleContents.some(item => item.isCached)) {
    const notice = document.createElement("p");
    notice.className = "item-meta";
    notice.setAttribute("role", "status");
    notice.textContent = lang === "en"
      ? "Showing the last observed list. Refresh to check the current state."
      : "前回確認した一覧を表示しています。更新で現在の状態を確認できます。";
    r2FileList.prepend(notice);
  }

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
  const next = observeDrift(counts[rawKey], isAlive, now, DRIFT_FAIL_COOLDOWN_MS);
  if (isAlive) {
    delete counts[rawKey];
  } else {
    counts[rawKey] = next;
  }
  localStorage.setItem(DRIFT_STORAGE_KEY, JSON.stringify(counts));
  return { shouldRetire: isDriftRetired(next), count: next.count, skipped: Boolean(next.skipped) };
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
    const isFilebase = item.storageProvider === "filebase";
    const rawAllowedHost = item.metadata?.allowedHost || item.metadata?.d || "";
    const fileDomain = getFileStoredDomain(rawKey, item.Key, rawAllowedHost).replace(/\/$/, "");
    const publicUrl = item.publicUrl || item.proxyUrl || getPublicDeliveryUrl(item.Key, isFilebase ? "filebase" : "r2", fileDomain);
    if (!rawKey || !publicUrl) continue;

    // 🛡️ クールダウン先行ガード: 前回失敗から1時間以内なら HEAD 通信自体を完全にスキップ（通信無駄打ちゼロ）
    const counts = getDriftFailCounts();
    const entry = counts[rawKey];
    if (entry && entry.count > 0 && (now - entry.lastChecked < DRIFT_FAIL_COOLDOWN_MS)) {
      continue;
    }

    const isAlive = await checkDriftSurvival(publicUrl);
    const result = recordDriftCheckResult(rawKey, isAlive);

    const elem = [...(r2FileList?.querySelectorAll(`.result-item[data-key="${CSS.escape(rawKey)}"]`) || [])]
      .find(card => card.dataset.provider === item.storageProvider);
    const badge = elem?.querySelector(`.drifting-badge-${CSS.escape(rawKey)}`);
    if (result.shouldRetire) {
      safeConsole.warn(`🌊 漂流ファイルを3回連続の取得失敗により管理一覧から退役: ${rawKey}`);
      removeItemsFromLocalLedger(item.storageProvider, [rawKey]);
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
  const rowProvider = target.closest(".result-item")?.dataset?.provider || managedController.getActiveProvider();
  const isFilebase = rowProvider === "filebase";
  const s3 = getS3Client(rowProvider);
  const bucketName = getBucketName(rowProvider);

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

  // Presentation: ファイル名変更に見えるインライン編集。
  // Domain: 元Linkと同じhostに、同じObjectRefを指すpeer Linkをcreate-onlyで追加する。
  // 元Linkと物理Objectは変更・削除しない。
  if (target.classList.contains("rename-file-btn") || target.closest(".rename-file-btn")) {
    const btn = target.classList.contains("rename-file-btn") ? target : target.closest(".rename-file-btn");
    const oldKey = btn.dataset.key;
    if (!oldKey) return;

    const row = btn.closest(".item-name-group, .item-name-row");
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

      const isFilebase = rowProvider === "filebase";
      const currentSize = parseInt(btn.dataset.size || article?.dataset?.size || "0", 10);
      let cid = btn.dataset.cid || article?.dataset?.cid || getStoredIpfsCid(oldKey) || getStoredIpfsCid(originalS3Key);
      let size = currentSize;
      let mime = "";

      // 🚀 [INV-CORE-005] 手元台帳キャッシュからメタデータ取得と同名衝突チェック（kv.list 全件走査 2重連打を完全根絶）
      const localLedgerList = (managedController.getContents() && managedController.getContents().length > 0)
        ? managedController.getContents()
        : (loadLedgerFromLocalStorage(rowProvider) || []);

      const currentKv = localLedgerList.find(f => f.storageProvider === rowProvider && (f.rawKey || f.Key) === oldKey);
      if (currentKv) {
        if (!cid) cid = currentKv.cid || currentKv.contentCid || currentKv.metadata?.cid;
        if (!size) size = currentKv.Size || currentKv.size || currentKv.metadata?.size || 0;
        mime = currentKv.mime || currentKv.metadata?.mime || "";
      }

      if (isFilebase && !cid) {
        alert("⚠️ このファイルの CID が見つからないためリネームできません。");
        row.innerHTML = originalHtml;
        return;
      }

      // Link identityはcanonical `host:filename` のみ。ペン操作でhostは変えない。
      const colonIdx = oldKey.indexOf(":");
      if (colonIdx <= 0 || colonIdx === oldKey.length - 1) {
        alert("❌ 元リンクがcanonical host:filename形式ではないため、別名リンクを作成できません。");
        row.innerHTML = originalHtml;
        return;
      }
      const sourceHost = oldKey.slice(0, colonIdx).toLowerCase();
      const targetNewKey = `${sourceHost}:${newKey}`;

      // 同じLink identityは、同じObjectを指していても必ずconflict。上書きはしない。
      const conflictingFile = localLedgerList.find(f => (f.rawKey || f.Key) === targetNewKey);
      if (conflictingFile) {
        alert(`⚠️ 同名のリンク「${newKey}」はすでに存在します。\n別のファイル名を指定してください。`);
        row.innerHTML = originalHtml;
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "...";

      try {
        // 1. 新キーで登録（実体 S3 キー名 originalS3Key を引き継ぐ）
        // unpinned / kuboStatus などの状態もそのまま継承
        let unpinned = Boolean(currentKv?.unpinned || currentKv?.metadata?.unpinned);
        let kuboStatus = currentKv?.metadata?.kuboStatus || null;
        let ttl = currentKv?.ttl || currentKv?.metadata?.ttl || 0;
        let expiresAt = currentKv?.expiresAt || currentKv?.metadata?.expiresAt || null;
        let password = currentKv?.password || currentKv?.metadata?.password || "";
        // 🌐 元カードのDOM設定（allowedHost, expiresAt）をまず最優先で取得
        const domAllowedHost = article?.dataset?.allowedhost || null;
        const domExpiresAt = Number(article?.dataset?.expiresat || 0) || null;
        let allowedHost = domAllowedHost || currentKv?.metadata?.allowedHost || currentKv?.metadata?.d || null;
        if (domExpiresAt && domExpiresAt > Date.now()) {
          expiresAt = domExpiresAt;
          ttl = Math.round((domExpiresAt - Date.now()) / 1000);
        }

        const targetCid = isValidIpfsCid(cid) ? cid : (currentKv?.contentCid || currentKv?.metadata?.contentCid || "");
        const objectId = await objectIdForManagedLink(oldKey);
        const created = await registerKvCid(
          targetNewKey, targetCid, size, mime, originalS3Key, password, null, ttl, expiresAt,
           unpinned, kuboStatus, allowedHost, false,
          null, null, undefined,
          currentKv?.contentCid || currentKv?.metadata?.contentCid || null,
          isFilebase ? (currentKv?.metadata?.backend === "filebase_rpc" ? "filebase_rpc" : "filebase") : "r2",
           { createOnly: true, objectId, bucket: currentKv?.metadata?.bucket }
        );
        if (created !== true) {
          throw new Error("KV台帳Workerと管理トークンが未設定のため、peer Linkを作成できません。");
        }

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

        // 元Linkはpeerとしてそのまま残す。delete/update/renameは行わない。

        // 🚀 [INV-CORE-005] Local-First: 手元台帳に新名前レコードを追加して即時描画
        const existingItem = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === oldKey);
        if (existingItem) {
          addOrUpdateLocalLedgerItem(rowProvider, {
            ...existingItem,
            // Presentation name and canonical Link identity are distinct.
            // Keep host:filename only in rawKey; using it as Key makes the
            // immediate public URL append the host twice until the next reload.
            Key: newKey,
            name: newKey,
            rawKey: targetNewKey,
            displayName: newKey,
            objectId,
            metadata: { ...(existingItem.metadata || {}), objectId, oid: objectId },
          });
        } else {
          renderCurrentStoragePage();
        }
      } catch (err) {
        safeConsole.error("Rename failed:", err);
        alert(`❌ リネームに失敗しました: ${redactSecrets(err.message)}`);
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
    const itemProvider = article?.dataset?.provider || rowProvider;
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

        // 🚀 [INV-CORE-005] 手元台帳から既存アイテムのメタデータを取得（kv.list 呼び出しゼロ化）
        const currentItem = (managedController.getContents() || []).find(f => f.storageProvider === rowProvider && ((f.rawKey || f.Key) === oldKey || f.Key === displayName));
        if (currentItem) {
          unpinned = Boolean(currentItem.unpinned || currentItem.metadata?.unpinned);
          kuboStatus = currentItem.metadata?.kuboStatus || null;
          if (!expiresAt) {
            ttl = currentItem.ttl || currentItem.metadata?.ttl || 0;
            expiresAt = currentItem.expiresAt || currentItem.metadata?.expiresAt || null;
          }
          password = currentItem.password || currentItem.metadata?.password || "";
        }

        const resolvedCid = cid || getStoredIpfsCid(oldKey) || getStoredIpfsCid(displayName) || getStoredIpfsCid(s3Key) || "";
        const targetCid = isValidIpfsCid(resolvedCid) ? resolvedCid : "";
        const targetBackend = isFilebase
          ? ((currentItem?.metadata?.backend || currentItem?.metadata?.b) === "filebase_rpc" ? "filebase_rpc" : "filebase")
          : "r2";
        const objectId = await objectIdForManagedLink(oldKey);

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
          null,
          null,
          undefined,
          resolvedCid || null, // contentCid
          targetBackend, // backend: [INV-FRONT-005] 帰属ストレージの完全固定
           { createOnly: true, objectId, bucket: currentItem?.metadata?.bucket }
        );

        if (resolvedCid) {
          storeIpfsCid(newDomainKey, resolvedCid);
        }
        setFileStoredDomain(newDomainKey, targetDomainUrl);

        // 新URLのウォームアップ
        const newUrl = `${targetDomainUrl.replace(/\/$/, "")}/${encodeURIComponent(displayName)}`;
        fetch(newUrl, { method: "HEAD", mode: "no-cors" }).catch(() => {});

        closeModal();

        // 🚀 [INV-CORE-005] Local-First 原則: 手元台帳にエイリアスレコードを追加して即時描画
        addOrUpdateLocalLedgerItem(rowProvider, {
          storageProvider: targetBackend,
          entryKind: "link",
          Key: displayName,
          rawKey: newDomainKey,
          s3Key: s3Key || displayName,
          Size: size || 0,
          LastModified: new Date().toISOString(),
          isFromS3: currentItem?.isFromS3 ?? true,
          cid: targetBackend === "r2" ? (resolvedCid || null) : targetCid,
          contentCid: resolvedCid || null,
          objectId,
          password: password || null,
          passwordHash: password ? "hash" : null,
          expiresAt: expiresAt || null,
          ttl: ttl || 0,
          civitaiTemporary: Boolean(currentItem?.civitaiTemporary),
          metadata: {
            backend: targetBackend,
            allowedHost: targetDomainUrl,
            s3Key: s3Key || displayName,
            cid: targetCid,
            objectId,
            oid: objectId,
            unpinned,
            kuboStatus,
            expiresAt,
            ttl,
          }
        });
      } catch (err) {
        safeConsole.error("Failed to add domain alias:", err);
        alert(`❌ ドメイン追加に失敗しました: ${redactSecrets(err.message)}`);
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
      const cachedItem = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      const meta = cachedItem?.metadata || cachedItem || {};
      const isR2 = meta.backend === "r2" || meta.b === "r2" || cachedItem?.backend === "r2" || rowProvider === "r2";
      const objectRef = await getObjectRefForUi(isR2 ? "r2" : "filebase", meta.s3Key || key, cid);
      await requestAuthorizedRelease(objectRef, "manual-placement", "kubo");
      if (cachedItem) {
        addOrUpdateLocalLedgerItem(rowProvider, {
          ...cachedItem,
          kuboStatus: "not_pinned",
          metadata: { ...(cachedItem.metadata || {}), kuboStatus: "not_pinned" },
        });
      } else {
        renderCurrentStoragePage();
      }
    } catch (err) {
      await showCustomAlert(`エラー: ${redactSecrets(err.message)}`, "❌ エラー");
      target.disabled = false;
      target.textContent = origText;
    }
    return;
  }

  // 🏠 自宅 Kubo への Pin 再実行ボタン（Tailscale / ローカル連携時）
  if (target.classList.contains("kubo-pin-manual-btn")) {
    const key = target.dataset.key;
    const cid = target.dataset.cid;
    const provider = target.dataset.provider || rowProvider;
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

        const expectedCid = await calculateFilebaseCid(new Uint8Array(await blob.arrayBuffer()));
        const objectRef = await getObjectRefForUi("r2", s3Key, expectedCid);
        await kuboPlacementApplication.acquire({
          objectRef,
          cid: expectedCid,
          performAcquire: () => addFileToKubo(blob, key),
        });

        const realCid = expectedCid;
        if (realCid) {
          storeIpfsCid(key, realCid);
          storeIpfsCid(s3Key, realCid);
          storeR2Hash(key, realCid);
          storeR2Hash(s3Key, realCid);
        }

        // Projection metadata is synchronized from the lifecycle authority.
        const cachedItem = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);

        // 🚀 [INV-CORE-005] Local-First: 手元台帳を即座に更新して再描画（サーバー全件フェッチゼロ化）
        if (cachedItem) {
          addOrUpdateLocalLedgerItem(rowProvider, {
            ...cachedItem,
            kuboStatus: "pinned",
            contentCid: realCid || (isValidIpfsCid(cid) ? cid : null),
            metadata: {
              ...(cachedItem.metadata || {}),
              kuboStatus: "pinned",
              contentCid: realCid || (isValidIpfsCid(cid) ? cid : null),
            },
          });
        } else {
          renderCurrentStoragePage();
        }
        await showCustomAlert(`✅ 自宅 Kubo ノードへの実体保存と Pin 留めに成功しました！\n\nCID: ${realCid || addRes.cid}`, "🎉 保全完了");
      } catch (err) {
        await showCustomAlert(`エラー: ${redactSecrets(err.message)}`, "❌ エラー");
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
      const cachedBeforePin = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      const sourceMeta = cachedBeforePin?.metadata || cachedBeforePin || {};
      const acquisitionObjectRef = await getObjectRefForUi("filebase", sourceMeta.s3Key || key, cid);
      activeKuboPins.add(cid);
      await kuboPlacementApplication.acquire({
        objectRef: acquisitionObjectRef,
        cid,
        onState(state) {
          target.dataset.placementState = state;
          if (state === KUBO_PLACEMENT_STATE.PIN_REQUESTED) target.textContent = "Pin要求中...";
          else if (state === KUBO_PLACEMENT_STATE.PINNING) target.textContent = "同期中...";
          else if (state === KUBO_PLACEMENT_STATE.RETRYABLE) target.textContent = "再試行";
          else if (state === KUBO_PLACEMENT_STATE.PRESENT) target.textContent = "🏠 Kubo: 保持中";
        },
      });
      activeKuboPins.delete(cid);
      const cachedItem = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      if (cachedItem) {
        addOrUpdateLocalLedgerItem(rowProvider, {
          ...cachedItem,
          kuboStatus: "pinned",
          kuboPlacementState: KUBO_PLACEMENT_STATE.PRESENT,
          metadata: {
            ...(cachedItem.metadata || {}),
            kuboStatus: "pinned",
            kuboPlacementState: KUBO_PLACEMENT_STATE.PRESENT,
          },
        });
      } else {
        renderCurrentStoragePage();
      }
      await showCustomAlert(`✅ 自宅 Kubo ノードで Pin を確認しました。\n\nCID: ${cid}`, "🎉 保全完了");
    } catch (err) {
      activeKuboPins.delete(cid);
      await showCustomAlert(`エラー: ${redactSecrets(err.message)}`, "❌ エラー");
      target.disabled = false;
      target.textContent = "再試行";
      target.title = origText;
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
      // 🚀 [INV-CORE-005] 手元台帳から既存のメタデータを取得（kv.getWithMetadata 通信ゼロ化）
      const cachedItem = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      const meta = cachedItem?.metadata || cachedItem || {};
      let currentKuboStatus = meta.kuboStatus || "not_pinned";
      const objectRef = await getObjectRefForUi("filebase", meta.s3Key || s3Key || key, cid);

      const isKuboAutoPin = localStorage.getItem("kuboAutoPin") !== "false";
      if (currentKuboStatus !== "pinned" && isKuboAutoPin && cid) {
        const kuboCheck = await checkKuboOnline(1500);
        if (kuboCheck.online) {
          activeKuboPins.add(cid);
          try {
            await ensureAuthoritativeKuboPin(objectRef, cid);
            currentKuboStatus = "pinned";
          } finally {
            activeKuboPins.delete(cid);
          }
        }
      }

      if (key && cid) {
        // Only the authority can grant the Filebase actuator task.
        await requestAuthorizedRelease(objectRef, "manual-placement", "filebase");
      }

      // 🚀 [INV-CORE-005] Local-First 原則: 手元台帳の該当アイテムを更新し即座に再描画
      const item = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      if (item) {
        addOrUpdateLocalLedgerItem(rowProvider, {
          ...item,
          isFromS3: false,
        });
      } else {
        renderCurrentStoragePage();
      }
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${redactSecrets(err.message)}`, "❌ エラー");
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
      await requestAuthorizedRelease(await getObjectRefForUi("r2", s3Key, cid), "manual-placement", "r2");

      // ローカルハッシュキャッシュをパージ
      deleteR2Hash(s3Key);
      deleteR2Hash(key);

      // 🚀 [INV-CORE-005] Local-First 原則: 手元台帳の該当アイテムを更新し即座に再描画
      const item = (managedController.getContents() || []).find(i => i.storageProvider === rowProvider && (i.rawKey || i.Key) === key);
      if (item) {
        addOrUpdateLocalLedgerItem(rowProvider, {
          ...item,
          isFromS3: false,
        });
      } else {
        renderCurrentStoragePage();
      }
      await showCustomAlert(
        isEn ? "✅ R2 object deleted successfully. Media will now be served from your home Kubo node." : "✅ R2 実体を削除し、バケット容量を解放しました！\n今後は自宅 Kubo ノードから安全に配信されます。",
        "🎉 容量解放完了"
      );
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${redactSecrets(err.message)}`, "❌ エラー");
    }
    return;
  }

  // 🚫 リンク抹消：KV から削除して即座に 404 化し、共有リンクが無ければ S3 の実体も削除
  if (target.classList.contains("delete-r2-file-btn")) {
    const key = target.dataset.key;
    // The lifecycle authority, not this rendered page, decides whether this
    // was the final Link and whether physical cleanup may start.
    if (!key) return;
    try {
      const item = (managedController.getContents() || []).find(entry => entry.storageProvider === rowProvider && (entry.rawKey || entry.Key) === key);
      if (!item) throw new Error("Managed entry is no longer in the current list");
      const isLocalEntry = item.entryKind === "local";
      const ok = await showCustomConfirm(
        isLocalEntry
          ? `'${key}' をこのブラウザの一覧から退場させますか？\n\n物理ファイル、他のLink、Placementには触れません。`
          : `リンク '${key}' を削除しますか？\n\nURLは即座に404になります。実体のrelease可否はサーバー側台帳が判断します。`,
        isLocalEntry ? "🗑️ 一覧から退場" : "🗑️ リンク削除の確認", "削除する"
      );
      if (!ok) return;
      if (isLocalEntry) {
        retireManagedEntry(rowProvider, item);
        return;
      }
      if (!hasAdminAccess()) throw new Error("Link deletion requires the KV Worker admin capability");
      const deleted = await deleteKvCid(key, item.metadata?.g);
      await requestAuthorizedRelease(deleted?.objectRef, "manual-delete").catch(error => {
        safeConsole.warn("Object retained because release is not yet authorized:", error);
      });
      removeItemsFromLocalLedger(rowProvider, [key]);
    } catch (err) {
      await showCustomAlert(`削除に失敗しました: ${redactSecrets(err.message)}`, "❌ エラー");
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

  const ok = await showCustomConfirm(
    `選択した ${checkboxes.length} 件を処理しますか？\n\nLinkは正規のLink削除、ローカル項目は一覧からの退場です。物理ファイルを直接削除しません。`,
    "🗑️ 一括削除の確認",
    "一括削除する"
  );
  if (!ok) return;

  // A bulk action is merely repeated Link removal. The lifecycle DO sees the
  // complete authoritative relation; this page must not infer shared Objects.
  try {
    for (const checkbox of checkboxes) {
      const provider = checkbox.closest(".result-item")?.dataset?.provider;
      const item = (managedController.getContents() || []).find(entry => entry.storageProvider === provider && (entry.rawKey || entry.Key) === checkbox.dataset.key);
      if (!item) throw new Error(`Managed entry is no longer in the current list: ${checkbox.dataset.key}`);
      if (item.entryKind === "local") {
        setLocalEntryRetired(provider, item, true);
        removeItemsFromLocalLedger(provider, [checkbox.dataset.key]);
        continue;
      }
      if (!hasAdminAccess()) throw new Error("Link deletion requires the KV Worker admin capability");
      const deleted = await deleteKvCid(checkbox.dataset.key, item.metadata?.g);
      await requestAuthorizedRelease(deleted?.objectRef, "manual-bulk-delete").catch(error => {
        safeConsole.warn("Bulk release deferred:", error);
      });
      removeItemsFromLocalLedger(provider, [checkbox.dataset.key]);
    }
    updateSelectedR2ActionButtonsState();
  } catch (error) {
    await showCustomAlert(`一括削除に失敗しました: ${redactSecrets(error.message)}`, "❌ エラー");
  }
  return;

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
    const isImage = !isVideo && (file.previewUrl || ["jpg", "jpeg", "png", "webp", "gif", "avif", "jxl"].includes(ext) || file.isCivitai);

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
    if (isImage && ext === "jxl") {
      attachJxlPreviewFallback(btn.querySelector("img"), { onFailure: image => {
        image.remove();
        btn.classList.add("format-badge");
        btn.textContent = "JXL";
      } });
    }
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
      safeConsole.warn("Failed to redirect existing window:", e);
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
    safeConsole.warn("navigator.clipboard failed, trying execCommand fallback:", err);
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
      safeConsole.error("execCommand copy failed:", fallbackErr);
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
  const safeUrl = safeMediaUrl(url);
  if (!safeUrl) throw new Error("Invalid download URL");
  const link = document.createElement("a");
  link.href = safeUrl;
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
        safeConsole.warn("Failed to resolve URL via /api/resolve-url:", e);
      }

      copyBtn.dataset.url = finalUrl;
      await copyToClipboard(finalUrl, copyBtn, "📋 URLコピー");
    } catch (err) {
      safeConsole.warn("Failed to copy civitai url:", err);
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
  const baseDomain = customWorkerUrl.replace(/\/api\/cividge-kv\/?$/, "").replace(/\/$/, "");
  return `${baseDomain}/api/upload`;
}

// 選択中の投稿先ストレージ種別を取得 ("filebase" | "r2")
function getSelectedUploadStorage() {
  return uploadStorageSelect?.value || "filebase";
}

// 外部投稿は管理 API トークンを流用せず、投稿専用 credential だけを使う。
// 保存先は接続中の Worker endpoint ごとに分ける。localStorage は UI の
// recoverable cache であり、credential の authority ではない。
function getUploadTokenStorageKey(endpoint = getDedicatedUploadEndpoint()) {
  if (!endpoint) return "";
  try {
    return "uploadApiToken:" + new URL(endpoint).origin;
  } catch (_) {
    return "";
  }
}

function getUploadApiToken() {
  const storageKey = getUploadTokenStorageKey();
  return (uploadApiTokenInput?.value || (storageKey ? localStorage.getItem(storageKey) : "") || "").trim();
}

function loadUploadApiTokenForCurrentWorker() {
  if (!uploadApiTokenInput) return;
  const storageKey = getUploadTokenStorageKey();
  uploadApiTokenInput.value = storageKey ? (localStorage.getItem(storageKey) || "") : "";
  isUploadTokenVerified = false;
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
    return normalizeHttpsOrigin(uploadReturnDomainSelect.value);
  }
  return normalizeHttpsOrigin(getSelectedR2Domain(getSelectedUploadStorage()));
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

async function getStoredUploadTokenVerification(token, endpoint) {
  try {
    const raw = JSON.parse(localStorage.getItem("uploadTokenVerifiedState") || "null");
    if (raw?.token) localStorage.removeItem("uploadTokenVerifiedState");
    if (raw && raw.tokenDigest === await tokenDigest(token) && raw.endpoint === endpoint) {
      return Boolean(raw.verified);
    }
  } catch (_) {}
  return null;
}

async function setStoredUploadTokenVerification(token, endpoint, verified) {
  try {
    if (token && endpoint) {
      localStorage.setItem("uploadTokenVerifiedState", JSON.stringify({ tokenDigest: await tokenDigest(token), endpoint, verified: Boolean(verified) }));
    } else {
      localStorage.removeItem("uploadTokenVerifiedState");
    }
  } catch (_) {}
}

// 🔑 Worker と通信して UPLOAD_TOKEN の正誤を検証（Local-First: キャッシュ優先）
async function verifyUploadToken({ force = false } = {}) {
  const token = getUploadApiToken();
  const endpoint = getDedicatedUploadEndpoint();
  const dict = i18nDict[getAppLanguage()] || i18nDict.ja;

  if (!endpoint) {
    if (uploadTokenStatusBadge) {
      uploadTokenStatusBadge.innerHTML = `<span style="color: var(--muted);">${dict.uploadTokenStatusNeedWorker}</span>`;
    }
    isUploadTokenVerified = false;
    setStoredUploadTokenVerification("", "", false);
    updateDedicatedUploadApiUI();
    return;
  }

  if (!token) {
    if (uploadTokenStatusBadge) {
      uploadTokenStatusBadge.innerHTML = `<span style="color: var(--muted);">${dict.uploadTokenStatusUnknown}</span>`;
    }
    isUploadTokenVerified = false;
    setStoredUploadTokenVerification("", "", false);
    updateDedicatedUploadApiUI();
    return;
  }

  // 🚀 [INV-CORE-005] 手元キャッシュがある場合は通信を完全スキップ（0回）
  if (!force) {
    const cachedStatus = await getStoredUploadTokenVerification(token, endpoint);
    if (token !== getUploadApiToken() || endpoint !== getDedicatedUploadEndpoint()) return;
    if (cachedStatus !== null) {
      isUploadTokenVerified = cachedStatus;
      if (uploadTokenStatusBadge) {
        uploadTokenStatusBadge.innerHTML = cachedStatus
          ? `<span style="color: #22c55e; font-weight: 600;">${dict.uploadTokenStatusValid}</span>`
          : `<span style="color: #ef4444; font-weight: 600;">${dict.uploadTokenStatusInvalid}</span>`;
      }
      updateDedicatedUploadApiUI();
      return;
    }
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
      if (token !== getUploadApiToken() || endpoint !== getDedicatedUploadEndpoint()) return;
      if (data.valid || data.success) {
        if (uploadTokenStatusBadge) {
          uploadTokenStatusBadge.innerHTML = `<span style="color: #22c55e; font-weight: 600;">${dict.uploadTokenStatusValid}</span>`;
        }
        isUploadTokenVerified = true;
        setStoredUploadTokenVerification(token, endpoint, true);
      } else {
        if (uploadTokenStatusBadge) {
          uploadTokenStatusBadge.innerHTML = `<span style="color: #ef4444; font-weight: 600;">${dict.uploadTokenStatusInvalid}</span>`;
        }
        isUploadTokenVerified = false;
        setStoredUploadTokenVerification(token, endpoint, false);
      }
    } else {
      if (uploadTokenStatusBadge) {
        uploadTokenStatusBadge.innerHTML = `<span style="color: #ef4444; font-weight: 600;">${dict.uploadTokenStatusInvalid}</span>`;
      }
      isUploadTokenVerified = false;
      setStoredUploadTokenVerification(token, endpoint, false);
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
    verifyUploadToken({ force: true });
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
      uploadTokenNotice.innerHTML = "⚠️ <strong>投稿用 API トークンが必要です:</strong> Worker に設定した <code>UPLOAD_TOKEN</code> または <code>TEST_UPLOAD_TOKEN</code> を入力すると、URLコピー・curl例・Windows「送る」登録を利用できます。";
    } else if (!isUploadTokenVerified) {
      uploadTokenNotice.style.display = "block";
      uploadTokenNotice.innerHTML = "❌ <strong>トークンが Worker と一致していません:</strong> 入力されたトークンでは認証に失敗しました。Worker の <code>UPLOAD_TOKEN</code> または <code>TEST_UPLOAD_TOKEN</code> と完全一致しているか確認してください。";
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
kvWorkerUrl?.addEventListener("change", () => {
  loadUploadApiTokenForCurrentWorker();
  updateDedicatedUploadApiUI();
  scheduleUploadTokenVerify(100);
});
if (uploadNamingRuleSelect) {
  uploadNamingRuleSelect.value = localStorage.getItem("uploadNamingRule") || "original";
  uploadNamingRuleSelect.addEventListener("change", () => {
    localStorage.setItem("uploadNamingRule", uploadNamingRuleSelect.value);
    updateDedicatedUploadApiUI();
  });
}
if (uploadApiTokenInput) {
  loadUploadApiTokenForCurrentWorker();
  // [INV-CORE-001] 入力中はローカル保存とUI更新のみ。文字入力ごとの通信連打を完全排除
  uploadApiTokenInput.addEventListener("input", () => {
    const token = uploadApiTokenInput.value.trim();
    const storageKey = getUploadTokenStorageKey();
    if (storageKey) {
      if (token) localStorage.setItem(storageKey, token);
      else localStorage.removeItem(storageKey);
    }
    updateDedicatedUploadApiUI();
  });
  // 入力完了時（change）のみ検証を発火
  uploadApiTokenInput.addEventListener("change", () => {
    scheduleUploadTokenVerify(100);
  });
}

// 起動時: 手元キャッシュを活用して即時反映（通信ゼロ）
setTimeout(() => {
  populateUploadReturnDomainSelect();
  verifyUploadToken({ force: false });
}, 100);

copyUploadApiUrlBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿用 API トークンが未入力です。\nWorker に設定した UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してください。");
    return;
  }
  const fullUrl = getDedicatedUploadFullUrl();
  await copyToClipboard(fullUrl, copyUploadApiUrlBtn, "📋 コピー完了!");
});

copyCurlCmdBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿用 API トークンが未入力です。\nWorker に設定した UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してください。");
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

  let curlCmd = `curl -X POST ${quotePosixShell(url.toString())}`;
  curlCmd += ` \\\n  -H ${quotePosixShell(`Authorization: Bearer ${token}`)}`;
  curlCmd += ` \\\n  -H "X-Upload-Filename: image.webp"`;
  curlCmd += ` \\\n  -H "Content-Type: application/octet-stream"`;
  curlCmd += ` \\\n  --data-binary "@/path/to/image.webp"`;

  await copyToClipboard(curlCmd, copyCurlCmdBtn, "💻 コピー完了!");
});

downloadSendToBatBtn?.addEventListener("click", async () => {
  const token = getUploadApiToken();
  if (!token) {
    alert("⚠️ 投稿用 API トークンが未入力です。Worker の UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してから登録してください。");
    return;
  }
  if (!isUploadTokenVerified) {
    alert("⚠️ 投稿用 API トークンが Worker と一致していません。正しい UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してください。");
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
  const escapedToken = quotePowerShell(token);

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

$endpoint = ${quotePowerShell(endpointUrlStr)}
$token = ${escapedToken}
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
    alert("⚠️ 投稿用 API トークンが未入力です。Worker の UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してからダウンロードしてください。");
    return;
  }
  if (!isUploadTokenVerified) {
    alert("⚠️ 投稿用 API トークンが Worker と一致していません。正しい UPLOAD_TOKEN または TEST_UPLOAD_TOKEN を入力してください。");
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

