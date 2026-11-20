import { safeConsole } from "../security/diagnostics.js";
import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { collectExpiredStorageKeys, selectFilebaseFifoCandidates, selectR2FifoCandidates } from "./fifo-policy.js";

const STREAM_MEDIA_EXT_RE = /\.(mp4|webm|mov|m4v|avi|ogv|mp3|wav|ogg|m4a|flac|aac)$/i;

function isStreamMediaItem(s3Key, linkedItems = []) {
  if (STREAM_MEDIA_EXT_RE.test(String(s3Key || ""))) return true;
  return linkedItems.some(item => {
    const name = String(item?.Key || item?.rawKey || item?.filename || "");
    const mime = String(item?.mime || item?.metadata?.mime || "").toLowerCase();
    return STREAM_MEDIA_EXT_RE.test(name) || mime.startsWith("video/") || mime.startsWith("audio/");
  });
}

function shouldReleaseWithoutKuboPin(targetKey, matchingItems, skipMediaPin, expiredKeys, hasDeleteKvCid) {
  if (!hasDeleteKvCid || matchingItems.length === 0) return false;
  if (expiredKeys && expiredKeys.has(targetKey)) return true;
  return Boolean(skipMediaPin && isStreamMediaItem(targetKey, matchingItems));
}

export function createStorageCapacityExecution({ getSetting, checkKuboOnline, getAppLanguage,
  getKuboPinnedCids, formatBytes, getStoredIpfsCid, getManagedContents, getObjectRefForUi,
  activeKuboPins, ensureAuthoritativeKuboPin, requestAuthorizedRelease, deleteKvCid,
  loadLedgerFromLocalStorage, calculateFilebaseCid, kuboPlacementApplication,
  addFileToKubo, storeIpfsCid, storeR2Hash, deleteR2Hash }) {
  async function releaseStreamMediaViaFifo(provider, s3Key, linkedItems, cid = null) {
    if (!deleteKvCid || !linkedItems.length) return false;
    const objectRef = await getObjectRefForUi(provider, s3Key, cid);
    for (const item of linkedItems) {
      const linkKey = item?.rawKey || item?.Key;
      if (!linkKey) continue;
      await deleteKvCid(linkKey, item.policyRevision ?? item.generation ?? null);
    }
    await requestAuthorizedRelease(objectRef, "fifo");
    return true;
  }
  // 🪐 Filebase FIFO（先入れ先出し）自動容量解放
  async function ensureStorageCapacityFilebase(s3, bucketName, requiredBytes = 0) {
    const isAutoFifo = getSetting("autoFifo") !== "false";
    if (!isAutoFifo || !s3 || !bucketName) return;
  
    // 上限サイズ (MB単位、Filebase上限は専用のfilebaseStorageLimitを参照、デフォルト 5000MB = 5GB)
    const limitMb = Number(getSetting("filebaseStorageLimit") || "5000");
    const limitBytes = limitMb * 1024 * 1024;
  
    try {
      const contents = [];
      let continuationToken;
      do {
        const response = await s3.send(new ListObjectsV2Command({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }));
        contents.push(...(response.Contents || []));
        if (response.IsTruncated && !response.NextContinuationToken) {
          throw new Error("Filebase一覧の続きが取得できません");
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      if (contents.length === 0) return;
  
      let currentTotalBytes = contents.reduce((acc, cur) => acc + (cur.Size || 0), 0);
  
      // 🛡️ バッファ安全設計: 新規ファイルを足しても上限の 85% 未満なら解放不要（750MB以上のバッファを常時担保）
      // （※ 容量に余裕がある平常時は Kubo 疎通チェックを行わず即座に完了する）
      if (currentTotalBytes + requiredBytes <= limitBytes * 0.85) {
        return;
      }
  
      // 🏠 Kubo 自動ピン留め設定の確認（外出先・Kuboオフライン時はファイル消失防止のため安全に中断）
      const isKuboAutoPin = getSetting("kuboAutoPin") !== "false";
      const isKuboPrioritizePinned = getSetting("kuboPrioritizePinned") !== "false";
      const skipMediaPin = getSetting("kuboSkipMediaPin") !== "false";
      let isKuboAvailable = false;
      let kuboPinnedSet = null;
      const managedList = getManagedContents() || [];
      const expiredKeys = collectExpiredStorageKeys(managedList);
      const { candidates, freedBytes } = selectFilebaseFifoCandidates(
        contents, currentTotalBytes, requiredBytes, limitBytes, isKuboPrioritizePinned, null, getStoredIpfsCid, expiredKeys
      );
      const needsKuboForFilebase = isKuboAutoPin && candidates.some(targetKey => {
        const matchingItems = managedList.filter(i => (i.rawKey || i.Key) === targetKey || i.s3Key === targetKey || i.metadata?.s3Key === targetKey);
        return !shouldReleaseWithoutKuboPin(targetKey, matchingItems, skipMediaPin, expiredKeys, Boolean(deleteKvCid));
      });
  
      if (needsKuboForFilebase) {
        const kuboCheck = await checkKuboOnline(1500);
        isKuboAvailable = kuboCheck.online;
        if (!isKuboAvailable) {
          safeConsole.warn("⚠️ 自宅 Kubo がオフラインのため、Filebase FIFO 自動容量解放をスキップしました（ファイル消失防止フェイルセーフ）。");
          if (requiredBytes > 0) {
            const isEn = getAppLanguage() === "en";
            const errMsg = isEn
              ? "Filebase storage limit (85%) reached. Upload paused because local Kubo node is unreachable (prevents existing file loss). Please connect to Tailscale or start Kubo."
              : "Filebaseの容量上限（85%）に達しています。自宅Kuboノードへの接続が確認できないため、過去ファイルの消失を防ぐためにアップロードを中断しました。Tailscale接続またはKubo起動をご確認ください。";
            throw new Error(errMsg);
          }
          return;
        }
        safeConsole.log("🏠 自宅 Kubo ノード検出: アンピン対象ファイルをローカルKuboへ救出Pin開始");
        if (isKuboPrioritizePinned) {
          try {
            kuboPinnedSet = await getKuboPinnedCids(1500);
            if (kuboPinnedSet && kuboPinnedSet.size > 0) {
              safeConsole.log(`🏠 Kubo 保管済みCIDリスト取得成功 (${kuboPinnedSet.size} 件)。保管済みファイルを優先してFilebase容量解放します。`);
            }
          } catch (e) {
            safeConsole.warn("Kubo Pin済みリスト取得失敗（通常ソートにフォールバック）:", e);
          }
        }
      }
  
      safeConsole.log(`🪐 Filebase FIFO 発動: 現在容量 ${formatBytes(currentTotalBytes)} + 新規 ${formatBytes(requiredBytes)} > 上限 ${formatBytes(limitBytes)} (85%)`);
  
      // 保護対象（pinned_ で始まるもの）を除外し、ソート
      // isKuboPrioritizePinned が有効かつ kuboPinnedSet がある場合は、Kubo保管済みを最優先にし、それぞれ古い順（LastModified 昇順）にする
      const prioritized = kuboPinnedSet
        ? selectFilebaseFifoCandidates(contents, currentTotalBytes, requiredBytes, limitBytes, isKuboPrioritizePinned, kuboPinnedSet, getStoredIpfsCid, expiredKeys)
        : { candidates, freedBytes };
      const finalCandidates = prioritized.candidates;
      const finalFreedBytes = prioritized.freedBytes;
  
      if (finalCandidates.length === 0) return;
  
      // 🛡️ 安全実行順序:
      // 1. Kubo自動Pin有効時: Filebaseから削除する「前」に、まずKuboへPin留めを成功させる！
      // 2. Pin成功確認後（またはKubo無効時、すでにKubo保管済み時）にのみ、Filebase S3 DeleteObject を実行する！
      const filesToUnpin = [];
      const kvUpdates = [];
  
      for (const targetKey of finalCandidates) {
        let cid = null;
        let meta = {};
        let kuboStatus = "not_pinned";
  
        // 🚀 [INV-CORE-005] 手元台帳から既存メタデータを取得（ループ内 fetchKvRecord 通信連打を完全排除）
        const matchingItems = managedList.filter(i => (i.rawKey || i.Key) === targetKey || i.s3Key === targetKey || i.metadata?.s3Key === targetKey);
        const cachedItem = matchingItems[0];
        if (cachedItem) {
          cid = cachedItem.cid || cachedItem.contentCid || cachedItem.metadata?.cid || null;
          meta = cachedItem.metadata || cachedItem || {};
          kuboStatus = meta.kuboStatus || cachedItem.kuboStatus || "not_pinned";
        }
  
        if (!cid) {
          cid = getStoredIpfsCid(targetKey);
        }

        if (shouldReleaseWithoutKuboPin(targetKey, matchingItems, skipMediaPin, expiredKeys, Boolean(deleteKvCid))) {
          try {
            await releaseStreamMediaViaFifo("filebase", meta?.s3Key || targetKey, matchingItems, cid);
            safeConsole.log(expiredKeys.has(targetKey)
              ? `🪐 Filebase FIFO: 期限切れのためKuboへPinせずLinkごと削除しました: ${targetKey}`
              : `🪐 Filebase FIFO: 動画・音声のためKuboへPinせずLinkごと削除しました: ${targetKey}`);
          } catch (mediaErr) {
            safeConsole.warn(`Filebase FIFO direct release failed on ${targetKey}:`, mediaErr);
          }
          continue;
        }
  
        const isAlreadyKuboPinned = cid && kuboPinnedSet && kuboPinnedSet.has(cid);
        const objectRef = cid ? await getObjectRefForUi("filebase", meta?.s3Key || targetKey, cid) : "";
  
        // Kuboへ事前にPin留め
        if (isKuboAvailable && isKuboAutoPin && cid && kuboStatus !== "pinned" && !isAlreadyKuboPinned) {
          activeKuboPins.add(cid);
          try {
            await ensureAuthoritativeKuboPin(objectRef, cid);
            kuboStatus = "pinned";
            safeConsole.log(`🏠 Kubo 事前救出Pin成功: ${targetKey} (${cid})`);
          } catch (pErr) {
            safeConsole.warn(`🏠 Kubo Pin通信エラー:`, pErr);
            if (requiredBytes > 0) {
              throw new Error(`自宅KuboへのPin通信エラーのためアンピンを中断しました: ${targetKey} (${pErr.message})`);
            }
            continue;
          } finally {
            activeKuboPins.delete(cid);
          }
        } else if (isAlreadyKuboPinned) {
          try {
            await ensureAuthoritativeKuboPin(objectRef, cid, { requestPin: false });
            kuboStatus = "pinned";
            safeConsole.log(`🏠 Kubo 保管済み確認（Pinスキップ）: ${targetKey} (${cid})`);
          } catch (error) {
            safeConsole.warn(`Kubo authority confirmation failed for ${targetKey}:`, error);
            continue;
          }
        }
  
        filesToUnpin.push(targetKey);
        if (cid) {
          kvUpdates.push({ key: targetKey, cid, meta, kuboStatus });
        }
      }
  
      if (filesToUnpin.length > 0) {
        safeConsole.log(`🪐 Filebase FIFO 自動アンピン実行: ${filesToUnpin.join(", ")} (${formatBytes(finalFreedBytes)} 解放)`);
        for (const update of kvUpdates) {
          try {
            const objectRef = await getObjectRefForUi("filebase", update.meta?.s3Key || update.key, update.cid);
            await requestAuthorizedRelease(objectRef, "fifo", "filebase");
          } catch (kvErr) {
            safeConsole.warn(`Failed to update unpinned status in KV for ${update.key}:`, kvErr);
          }
        }
      }
    } catch (err) {
      safeConsole.warn("Filebase FIFO ensureStorageCapacity error:", err);
      if (requiredBytes > 0) {
        throw err;
      }
    }
  }
  
  // ⚡ R2 FIFO: R2 側の上限到達時に古い実体を自動回収。
  // 自宅 Kubo への自動 Pin（kuboAutoPinR2）が有効な場合、消去前に Kubo へ実体を保存し、
  // 公開 URL を IPFS / 自宅 Kubo 経由で維持したまま R2 バケット容量を安全に解放する。
  async function ensureStorageCapacityR2(s3, bucketName, requiredBytes = 0) {
    if (getSetting("r2AutoFifo") === "false" || !s3 || !bucketName) return;
  
    const limitMb = Number(getSetting("r2StorageLimit") || getSetting("storageLimit") || "5000");
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
  
      // 🚀 [INV-CORE-005] 手元台帳キャッシュから参照（kv.list 全件走査ゼロ化）
      const kvFiles = (getManagedContents() && getManagedContents().length > 0)
        ? getManagedContents()
        : (loadLedgerFromLocalStorage("r2") || []);
      const expiredKeys = collectExpiredStorageKeys(kvFiles);

      const itemsToDelete = selectR2FifoCandidates(contents, totalBytes, requiredBytes, limitBytes, expiredKeys);
      if (itemsToDelete.length === 0) return;

      const isKuboAutoPinR2 = getSetting("kuboAutoPinR2") !== "false";
      const skipMediaPin = getSetting("kuboSkipMediaPin") !== "false";

      const mediaItems = [];
      const preserveItems = [];
      for (const item of itemsToDelete) {
        const linkedItems = kvFiles.filter(kv => (kv.metadata?.s3Key || kv.metadata?.k_s3 || kv.s3Key || kv.Key) === item.Key);
        if (shouldReleaseWithoutKuboPin(item.Key, linkedItems, skipMediaPin, expiredKeys, Boolean(deleteKvCid))) {
          mediaItems.push({ item, linkedItems });
        } else {
          preserveItems.push({ item, linkedItems });
        }
      }

      let mediaReleasedCount = 0;
      for (const { item, linkedItems } of mediaItems) {
        try {
          await releaseStreamMediaViaFifo("r2", item.Key, linkedItems, null);
          deleteR2Hash(item.Key);
          mediaReleasedCount += 1;
        } catch (mediaErr) {
          safeConsole.warn(`R2 FIFO media release failed on ${item.Key}:`, mediaErr);
        }
      }

      if (preserveItems.length === 0) {
        if (mediaReleasedCount > 0) {
          safeConsole.log(`⚡ R2 FIFO: 動画・音声 ${mediaReleasedCount} 件をKuboへPinせずLinkごと削除して容量解放しました`);
        }
        return;
      }

      // Kubo 自動 Pin がオフの場合、保全先が無いため解放を保留して明示的に警告する。
      if (!isKuboAutoPinR2) {
        safeConsole.warn(`⚠️ R2 FIFO: 容量解放の候補が ${preserveItems.length} 件ありますが、Kubo 自動 Pin (kuboAutoPinR2) がオフのため解放を保留しました。Kubo 保全なしでは解放しません。解放するには Kubo 自動 Pin を有効にしてください。`);
        return;
      }

      const kuboStatus = await checkKuboOnline(1500);
      if (!kuboStatus.online) {
        safeConsole.warn("⚠️ 自宅 Kubo がオフラインのため、R2 FIFO 自動容量解放をスキップしました（ファイル消失防止フェイルセーフ）。");
        return;
      }

      const preservedInKuboKeys = new Set();

      // 🏠 Kubo への自動実体保存（Pin留め）
      for (const { item } of preserveItems) {
        try {
          const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: item.Key }));
          const bytes = await res.Body.transformToByteArray();
          const blob = new Blob([bytes]);
          const expectedCid = await calculateFilebaseCid(bytes);
          const objectRef = await getObjectRefForUi("r2", item.Key, expectedCid);
          await kuboPlacementApplication.acquire({
            objectRef,
            cid: expectedCid,
            performAcquire: () => addFileToKubo(blob, item.Key),
          });
          storeIpfsCid(item.Key, expectedCid);
          storeR2Hash(item.Key, expectedCid);
          preservedInKuboKeys.add(item.Key);
        } catch (pinErr) {
          safeConsole.warn(`Kubo auto-pin for R2 FIFO failed on ${item.Key}:`, pinErr);
        }
      }

      let releasedCount = 0;
      for (const { item, linkedItems } of preserveItems) {
        if (!preservedInKuboKeys.has(item.Key)) continue;
        if (linkedItems.length === 0) continue;
        await requestAuthorizedRelease(await getObjectRefForUi("r2", item.Key, null), "fifo", "r2");
        deleteR2Hash(item.Key);
        releasedCount += 1;
      }
      safeConsole.log(`⚡ R2 FIFO authority release: ${releasedCount}件 (Kubo保全確認: ${preservedInKuboKeys.size}件, 動画/音声削除: ${mediaReleasedCount}件)`);
    } catch (err) {
      safeConsole.warn("R2 FIFO ensureStorageCapacity error:", err);
    }
  }

  return { ensureStorageCapacityFilebase, ensureStorageCapacityR2 };
}
