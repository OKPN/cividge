import { safeConsole } from "../security/diagnostics.js";
import { exceedsUploadLimit } from "../upload-limit.js";
import { applyFastStartToMp4 } from "../media/mp4-faststart.js";
import { getContentTypeFromFilename, getImageDimensions } from "../media-utils.js";
import { objectIdFromFinalBytes } from "../object-id.js";
import { putUploadObject } from "./physical-put.js";

export function createUploadOrchestrator({ getS3Client, getBucketName, hasAdminAccess, calculateFilebaseCid,
  prepareManagedUpload, linkBindingRequest, lifecycleRequest, registerKvCid, findFilebaseObjectByCid,
  findR2ObjectByHash, ensureStorageCapacityFilebase, ensureStorageCapacityR2, safeDeleteS3Objects,
  getSelectedR2Domain, buildKvKey, getSelectedDeliveryUrl, getKvDeliveryBaseDomain, checkKuboPinned,
  isValidIpfsCid, setFileStoredDomain, addOrUpdateLocalLedgerItem, markCivitaiTemporaryTransfer,
  storeIpfsCid, storeR2Hash, extractCleanHost, isConversionEnabled,
  onFileState, onError, onUploadLimit, onPublicUrl, recordWorkflow, queueVideoThumbnail,
  readImageDimensions = getImageDimensions,
  onDiagnostic = error => safeConsole.error("Upload failed:", error) }) {
  async function uploadImage(result, targetProvider = "r2", customPassword = null, uploadOptions = {}) {
    if (!result || !result.blob) return false;
  
    const isFilebase = targetProvider === "filebase";
    const s3 = getS3Client(targetProvider);
    const bucketName = getBucketName(targetProvider);
    const deliveryDomain = uploadOptions.deliveryDomain || getSelectedR2Domain(targetProvider) || uploadOptions.origin;
  
    if (!s3 || !bucketName) {
      onError(`⚠️ ${isFilebase ? "Filebase" : "R2"} 接続設定を完了してください`);
      return false;
    }
  
    result.isUploading = true;
    result.uploadingProvider = targetProvider;
    onFileState(result);
  
    let managedPlan = null;
  
    try {
      const password = (typeof customPassword !== "undefined" && customPassword !== null)
        ? customPassword
        : (uploadOptions.password || "");
  
      const requestedTtl = Number(uploadOptions.requestedTtl || 0);
      const ttlSeconds = Number.isFinite(Number(uploadOptions.ttlSeconds))
        ? Math.max(0, Number(uploadOptions.ttlSeconds))
        : requestedTtl;
      const expiresAt = ttlSeconds > 0 ? (Date.now() + ttlSeconds * 1000) : null;
      const civitaiTemporary = Boolean(uploadOptions.civitaiTemporary);
      const cachePolicy = uploadOptions.cachePolicy === "PUBLISHED"
        ? "PUBLISHED" : "BOARD";
  
      const arrayBuffer = await result.blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
  
      // Source and final bytes use the same global decimal 80 MB limit.
      // See: [INV-FRONT-003].
      if (exceedsUploadLimit(bytes.length)) {
        const sizeMb = (bytes.length / 1_000_000).toFixed(1);
        await onUploadLimit(sizeMb);
        result.isUploading = false;
        result.uploadingProvider = null;
        onFileState(result);
        return false;
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
          safeConsole.warn("FastStart optimization error:", fastStartErr);
        }
      }
  
      if (exceedsUploadLimit(uploadBytes.byteLength)) {
        throw new Error(uploadOptions.formatLimitError((uploadBytes.byteLength / 1_000_000).toFixed(1)));
      }
  
      let contentType = uploadBlob.type || "";
      if (!contentType || contentType === "application/octet-stream") {
        contentType = getContentTypeFromFilename(result.name);
      }
      const imageDimensions = await readImageDimensions(uploadBlob, contentType);
      const isAttachment = ["zip", "7z", "rar", "tar", "gz"].includes(ext);
      const contentDisposition = isAttachment
        ? `attachment; filename="${encodeURIComponent(result.name)}"`
        : "inline";
  
      // 🧬 Filebase / R2 重複検査: 変換後のバイト列からCID/ハッシュを算出し、同じ中身の
      // 既存実体があればPutObjectを実行しない。新しい公開名だけをKV台帳に追加する（スマートエイリアス）。
      let calculatedCid = null;
      let calculatedHash = null;
      const objectId = await objectIdFromFinalBytes(uploadBytes);
      result.objectId = objectId;
  
      if (hasAdminAccess()) {
        calculatedCid = await calculateFilebaseCid(uploadBytes);
        managedPlan = await prepareManagedUpload(result, targetProvider, s3, bucketName, calculatedCid, objectId, deliveryDomain);
        if (managedPlan.noPut) {
          if (managedPlan.claim) {
            await linkBindingRequest({ action: "markPhysical", linkKey: managedPlan.linkKey, attemptId: managedPlan.attemptId,
              generation: managedPlan.attemptGeneration, cid: calculatedCid });
            await lifecycleRequest({ action: "reportPlacement", objectRef: managedPlan.objectRef,
              placement: targetProvider, claimId: managedPlan.claim.claimId,
              generation: managedPlan.claim.generation, operation: "acquire", outcome: "present" });
          }
          if (!managedPlan.noOp) {
            await registerKvCid(managedPlan.linkKey, calculatedCid, uploadBytes.length,
              contentType, managedPlan.storageKey, password, null, ttlSeconds, expiresAt, false, null,
              managedPlan.baseDomain, true, imageDimensions?.width, imageDimensions?.height,
              civitaiTemporary, isFilebase ? null : calculatedCid, targetProvider,
              { createOnly: true, uploadAttemptId: managedPlan.attemptId, cachePolicy, objectId, bucket: bucketName });
          }
          result.isUploaded = true;
          result.uploadedProvider = targetProvider;
          result.storageKey = managedPlan.storageKey;
          result.ipfsCid = calculatedCid;
          result.mime = contentType;
          result.kvKey = managedPlan.linkKey;
          result.proxyUrl = `${managedPlan.baseDomain}/${encodeURIComponent(result.name)}`;
          setFileStoredDomain(managedPlan.linkKey, managedPlan.baseDomain);
          if (!managedPlan.linkAlreadyBound) addOrUpdateLocalLedgerItem(targetProvider, {
            storageProvider: targetProvider, entryKind: "link", Key: result.name, name: result.name,
            rawKey: managedPlan.linkKey, s3Key: managedPlan.storageKey, Size: uploadBytes.length,
            LastModified: new Date().toISOString(), isFromS3: true, cid: calculatedCid,
             contentCid: calculatedCid, objectId, metadata: { backend: targetProvider, bucket: bucketName, s3Key: managedPlan.storageKey, cid: calculatedCid, objectId },
          });
          onPublicUrl(result.name, result.proxyUrl);
          queueVideoThumbnail(uploadBlob, result.name, objectId);
          return true;
        }
      }
  
      if (!managedPlan && isFilebase) {
        calculatedCid = await calculateFilebaseCid(uploadBytes);
        if (calculatedCid) {
          const duplicate = await findFilebaseObjectByCid(s3, bucketName, calculatedCid);
          if (duplicate) {
            if (!hasAdminAccess()) {
              throw new Error("同一CIDのファイルを検出しました。別名URLの作成にはKV Worker URLとAdmin API Tokenの設定が必要です。");
            }
  
            const baseDomain = deliveryDomain.replace(/\/$/, "");
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
  
            // [INV-CORE-006] 新名 -> 既存のS3実体キー、という別名マッピングを作る。旧URLは維持される。
            const kvKey = buildKvKey(baseDomain, result.name);
            await registerKvCid(
              kvKey,
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
              imageDimensions?.width,
              imageDimensions?.height,
              civitaiTemporary,
              null,
              "filebase",
               { confirmPlacementPresent: true, cachePolicy, objectId, bucket: bucketName }
            );
            if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);
            storeIpfsCid(kvKey, duplicate.cid);
            storeIpfsCid(result.name, duplicate.cid);
            storeIpfsCid(duplicate.key, duplicate.cid);
            result.proxyUrl = getSelectedDeliveryUrl(result);
            result.kvKey = kvKey;
            setFileStoredDomain(kvKey, baseDomain);
            onPublicUrl(result.name, result.proxyUrl);
            queueVideoThumbnail(uploadBlob, result.name, objectId);
  
            return true;
          }
        }
      } else if (!managedPlan) {
        // ⚡ R2 IPFS UnixFS CID 重複検査:
        // Filebase と同一の UnixFS CID を計算し、同一 CID の既存実体があれば PutObject をスキップしてスマートエイリアス化
        calculatedCid = await calculateFilebaseCid(uploadBytes);
        if (calculatedCid) {
          const duplicate = await findR2ObjectByHash(s3, bucketName, calculatedCid, uploadBytes.length);
          if (duplicate) {
            if (!hasAdminAccess()) {
              throw new Error("同一内容のファイルを検出しました。別名URLの作成にはKV Worker URLとAdmin API Tokenの設定が必要です。");
            }
  
            const baseDomain = deliveryDomain.replace(/\/$/, "");
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
  
            // [INV-CORE-006] 新名 -> 既存の R2 実体キー、という別名マッピングを登録（R2 容量を消費しない）
            const kvKey = buildKvKey(baseDomain, result.name);
            await registerKvCid(
              kvKey,
              calculatedCid,
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
              imageDimensions?.width,
              imageDimensions?.height,
              civitaiTemporary,
              calculatedCid,
              "r2",
               { confirmPlacementPresent: true, cachePolicy, objectId, bucket: bucketName }
            );
            if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);
            storeR2Hash(kvKey, calculatedCid);
            storeR2Hash(result.name, calculatedCid);
            storeR2Hash(duplicate.key, calculatedCid);
            storeIpfsCid(kvKey, calculatedCid);
            storeIpfsCid(result.name, calculatedCid);
            storeIpfsCid(duplicate.key, calculatedCid);
            result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
            result.kvKey = kvKey;
            setFileStoredDomain(kvKey, baseDomain);
            onPublicUrl(result.name, result.proxyUrl);
            queueVideoThumbnail(uploadBlob, result.name, objectId);
  
            safeConsole.log(`⚡ R2 重複排除（UnixFS CID照合: ${calculatedCid}）: 既存実体「${duplicate.key}」を検知したため PutObject をスキップしスマートエイリアスを作成しました。`);
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
      s3Metadata["object-id"] = objectId;
  
      const { ipfsCid } = await putUploadObject({
        s3, bucket: bucketName, key: managedPlan?.storageKey || result.name,
        bytes: uploadBytes, contentType, contentDisposition, metadata: s3Metadata,
        provider: targetProvider, isValidIpfsCid,
      });
  
      if (managedPlan) {
        if (isFilebase && ipfsCid !== calculatedCid) {
          await safeDeleteS3Objects(s3, bucketName, [managedPlan.storageKey]);
          await lifecycleRequest({ action: "reportPlacement", objectRef: managedPlan.objectRef,
            placement: targetProvider, claimId: managedPlan.claim.claimId,
            generation: managedPlan.claim.generation, operation: "acquire", outcome: "retryable",
            error: "Filebase CID did not match the preflight content CID" });
          await linkBindingRequest({ action: "abort", linkKey: managedPlan.linkKey,
            attemptId: managedPlan.attemptId, generation: managedPlan.attemptGeneration, physicalAbsent: true });
          throw new Error("Filebase CIDが事前計算と一致しないため、保存を取り消しました");
        }
        await linkBindingRequest({ action: "markPhysical", linkKey: managedPlan.linkKey,
          attemptId: managedPlan.attemptId, generation: managedPlan.attemptGeneration,
          cid: isFilebase ? ipfsCid : calculatedCid });
        await lifecycleRequest({ action: "reportPlacement", objectRef: managedPlan.objectRef,
          placement: targetProvider, claimId: managedPlan.claim.claimId,
          generation: managedPlan.claim.generation, operation: "acquire", outcome: "present" });
      }
  
      result.uploadedProvider = targetProvider;
      result.storageKey = managedPlan?.storageKey || result.name;
      result.password = password;
      result.hasPassword = Boolean(password);
      result.ttl = ttlSeconds;
      result.expiresAt = expiresAt;
      result.civitaiTemporary = civitaiTemporary;
  
      const baseDomain = deliveryDomain.replace(/\/$/, "");
  
      if (isFilebase) {
        if (ipfsCid && isValidIpfsCid(ipfsCid)) {
          result.ipfsCid = ipfsCid;
          storeIpfsCid(result.name, ipfsCid);
        }
        if (calculatedCid && ipfsCid && calculatedCid !== ipfsCid) {
          safeConsole.warn("Filebase returned a CID different from the local UnixFS calculation; duplicate detection will be retried with Filebase's CID on future uploads.", { calculatedCid, ipfsCid });
        }
        // CID の有無に関わらず、KV にメタデータ（パスワード含む）を登録（※一般ユーザー時は自動スキップ）
        // [INV-CORE-006] 🌐 選択されている配信ドメインのみを allowedHost として渡し、host:filename 均一キーで登録
        const fbKvKey = buildKvKey(baseDomain, result.name);
        await registerKvCid(
          fbKvKey,
          ipfsCid || "",
          uploadBytes.length,
          contentType,
          result.storageKey,
          password,
          uploadBlob || uploadBytes,
          ttlSeconds,
          expiresAt,
          false,
          null,
          baseDomain,
          true,
          imageDimensions?.width,
          imageDimensions?.height,
          civitaiTemporary,
          null,
          "filebase",
           managedPlan ? { createOnly: true, uploadAttemptId: managedPlan.attemptId, cachePolicy, objectId, bucket: bucketName } : { confirmPlacementPresent: true, cachePolicy, objectId, bucket: bucketName }
        );
        result.kvKey = fbKvKey;
        
        if (hasAdminAccess()) {
          const deliveryBase = getKvDeliveryBaseDomain();
          result.proxyUrl = `${deliveryBase}/${encodeURIComponent(result.name)}`;
          safeConsole.log(`🪐 cividge-kv-worker URL 生成完了: CID=${ipfsCid} -> ${result.proxyUrl}`);
        } else {
          // 一般ユーザーモードでも共有URLは配信ドメイン + ファイル名に統一する。
          result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
          safeConsole.log(`🪐 Filebase URL 生成完了: CID=${ipfsCid} -> ${result.proxyUrl}`);
        }
        result.proxyUrl = getSelectedDeliveryUrl(result) || result.proxyUrl;
  
        // 🛡️ Filebase 帯域保護（Egress 温存）:
        // アップロード直後の全量ウォームアップフェッチは Filebase のダウンロード帯域を
        // 無条件に100%消費するため行わない。実際の初回アクセス時にオンデマンドでエッジキャッシュさせる。
        setFileStoredDomain(fbKvKey, baseDomain);
      } else {
        let initialKuboStatus = null;
        if (calculatedCid) {
          try {
            if (await checkKuboPinned(calculatedCid, 500)) {
              initialKuboStatus = "pinned";
            }
          } catch (e) {}
        }
        // [INV-CORE-006] host:filename 均一キーで登録
        const r2KvKey = buildKvKey(baseDomain, result.name);
        await registerKvCid(
          r2KvKey,
          calculatedCid || "",
          uploadBytes.length,
          contentType,
          result.storageKey,
          password,
          uploadBlob || uploadBytes,
          ttlSeconds,
          expiresAt,
          false,
          initialKuboStatus,
          baseDomain,
          true,
          imageDimensions?.width,
          imageDimensions?.height,
          civitaiTemporary,
          calculatedCid,
          "r2",
          managedPlan ? { createOnly: true, uploadAttemptId: managedPlan.attemptId, cachePolicy, objectId, bucket: bucketName } : { confirmPlacementPresent: true, cachePolicy, objectId, bucket: bucketName }
        );
        result.proxyUrl = `${baseDomain}/${encodeURIComponent(result.name)}`;
        result.kvKey = r2KvKey;
        setFileStoredDomain(r2KvKey, baseDomain);
        if (calculatedCid) {
          result.ipfsCid = calculatedCid;
          storeR2Hash(r2KvKey, calculatedCid);
          storeR2Hash(result.name, calculatedCid);
          storeIpfsCid(r2KvKey, calculatedCid);
          storeIpfsCid(result.name, calculatedCid);
        }
      }
  
      result.isUploaded = true;
      if (civitaiTemporary) markCivitaiTemporaryTransfer(targetProvider, result.name, expiresAt);
  
      // Preview failure cannot alter the already-published video Link/Object.
      queueVideoThumbnail(uploadBlob, result.name, objectId);
  
      // 🧬 アップロードされたファイルのワークフロー有無をローカルストレージに記録
      // （※画像変換ONの画像はCanvasでExif/WFが削除されるため、非変換時または動画のみ保持）
      try {
        recordWorkflow(result, isConversionEnabled());
      } catch (wfSaveErr) {}
  
      onPublicUrl(result.name, result.proxyUrl);
  
      // 🚀 [INV-CORE-005] [INV-CORE-006] Local-First 台帳オプティミスティック追加（host:filename キーで即時反映）
      const finalCid = isFilebase ? (ipfsCid || result.ipfsCid || null) : (result.contentCid || calculatedCid || null);
      const uploadKvKey = result.kvKey || buildKvKey(baseDomain, result.name);
      if (!managedPlan?.linkAlreadyBound) addOrUpdateLocalLedgerItem(targetProvider, {
        storageProvider: targetProvider,
        Key: result.name,
        name: result.name,
        rawKey: uploadKvKey,
        entryKind: hasAdminAccess() ? "link" : "local",
        s3Key: result.storageKey,
        Size: uploadBytes.length,
        size: uploadBytes.length,
        LastModified: new Date().toISOString(),
        updated: new Date().toISOString(),
        isFromS3: true,
        cid: finalCid,
        contentCid: finalCid,
        objectId,
        password: password || null,
        passwordHash: password ? "hash" : null,
        expiresAt: expiresAt || null,
        ttl: ttlSeconds || 0,
        civitaiTemporary: Boolean(civitaiTemporary),
        metadata: {
          backend: targetProvider,
          size: uploadBytes.length,
          cid: finalCid || "",
          objectId,
          bucket: bucketName,
          s3Key: result.storageKey,
          expiresAt: expiresAt || null,
          ttl: ttlSeconds || 0,
          allowedHost: baseDomain,
          d: extractCleanHost(baseDomain),
          civitaiTemporary: Boolean(civitaiTemporary),
        }
      });
  
      return true;
    } catch (error) {
      result.error = error.message;
      onDiagnostic(error);
      onError(`アップロード失敗 (${targetProvider}): ${error.message}`);
      return false;
    } finally {
      result.isUploading = false;
      onFileState(result);
    }
  }

  return uploadImage;
}
