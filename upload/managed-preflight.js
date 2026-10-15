import { HeadObjectCommand } from "@aws-sdk/client-s3";

export function createManagedPreflight({ lifecycleRequest, linkBindingRequest, getSelectedR2Domain, getCurrentOrigin, buildKvKey, getIpfsCidFromS3Response }) {
  async function inspectManagedPlacement(objectRef, kind) {
    const response = await lifecycleRequest({ action: "inspect", objectRef });
    return response?.lifecycle?.placements?.[kind] || null;
  }
  
  async function headManagedStorageObject(s3, bucket, key) {
    try {
      return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || ["NotFound", "NoSuchKey"].includes(error?.name)) return null;
      throw error;
    }
  }
  
  // Link-key reservation is authoritative. A pending attempt records the exact
  // physical locator before PUT, so a later authorized browser can inspect and
  // adopt an interrupted upload instead of guessing from localStorage.
  async function prepareManagedUpload(result, provider, s3, bucket, contentCid, objectId, deliveryDomain) {
    if (!contentCid || !/^sha256:[0-9a-f]{64}$/.test(objectId || "")) throw new Error("最終バイト列のidentityを計算できませんでした");
    const kind = provider === "filebase" ? "filebase" : "r2";
    const canonicalStorageKey = `objects/${contentCid}`;
    const objectRef = objectId;
    // An ObjectId may already own a different physical locator. Its
    // durable Placement, not the new upload's filename, selects the key to
    // inspect/reacquire. Never PUT to another key for the same ObjectRef.
    const ownedPlacement = await inspectManagedPlacement(objectRef, kind);
    if (ownedPlacement && ownedPlacement.locator?.bucket !== bucket)
      throw new Error("既存Placementのbucketが現在の設定と一致しません");
    const ownedKey = ownedPlacement?.locator?.key;
    if (kind === "filebase" && ownedPlacement?.locator?.cid !== undefined &&
        ownedPlacement.locator.cid !== contentCid) throw new Error("Filebase Placement CIDが現在の最終bytesと一致しません");
    const storageKey = typeof ownedKey === "string" && ownedKey ? ownedKey : canonicalStorageKey;
    const baseDomain = (deliveryDomain || getSelectedR2Domain(provider) || getCurrentOrigin()).replace(/\/$/, "");
    const linkKey = buildKvKey(baseDomain, result.name);
    const placement = {
      kind, executor: kind === "r2" ? "worker" : "browser",
      locator: ownedPlacement?.locator || { bucket, key: storageKey, ...(kind === "filebase" ? { cid: contentCid } : {}) },
    };
    let attemptId = crypto.randomUUID();
    let physicalAlreadyPresent = false;
    let reservation;
    try {
      reservation = await linkBindingRequest({ action: "reserve", linkKey, objectRef, attemptId, placement });
    } catch (error) {
      if (error.code !== "RESERVATION_CONFLICT" ||
          error.attempt?.placement?.locator?.key !== storageKey ||
          error.attempt?.placement?.locator?.bucket !== bucket) throw error;
      if (Date.now() < Number(error.attempt.expiresAt || 0)) {
        throw new Error("このLinkのuploadはまだ進行中です。中断した場合は数分後に同じファイルを再試行してください。");
      }
      // A previous browser may have disappeared after PUT. Only adopt an exact
      // content-addressed key with matching provider metadata; never adopt an
      // arbitrary physical file based on filename alone.
      const pending = error.attempt;
      reservation = await linkBindingRequest({ action: "takeover", linkKey, objectRef,
        previousAttemptId: pending.id, attemptId });
      const head = await headManagedStorageObject(s3, bucket, storageKey);
      if (head) {
        const observedCid = getIpfsCidFromS3Response(head);
        const observedHash = head.Metadata?.hash || head.Metadata?.cid;
        if ((kind === "filebase" ? observedCid !== contentCid : observedHash !== contentCid) ||
            head.Metadata?.["object-id"] !== objectId) {
          throw new Error("未完了uploadの物理内容を確認できません。対象Linkの保留状態を確認してください。");
        }
        physicalAlreadyPresent = true;
      }
    }
  
    let current = await inspectManagedPlacement(objectRef, kind);
    const linkAlreadyBound = reservation.result === "bound";
    if (current && ["RELEASE_PENDING", "RETRYABLE", "RELEASED"].includes(current.state)) {
      // An explicit retry may settle an uncertain release only after inspecting
      // the exact durable Placement locator. No PUT happens before this check.
      let observation;
      let observedCid;
      if (kind === "filebase") {
        const head = await headManagedStorageObject(s3, bucket, storageKey);
        observedCid = head ? getIpfsCidFromS3Response(head) : null;
        if (head && (observedCid !== contentCid || head.Metadata?.["object-id"] !== objectId))
          throw new Error("既存Filebase Objectのidentityを確認できません");
        observation = head ? "present" : "absent";
      }
      await lifecycleRequest({ action: "reconcilePlacementForAcquire", objectRef, placement,
        ...(kind === "filebase" ? { observation, ...(observedCid ? { observedCid } : {}) } : {}) });
      current = await inspectManagedPlacement(objectRef, kind);
    }
    if (current?.state === "PRESENT") {
      return { linkKey, baseDomain, objectRef, storageKey: current.locator.key, contentCid,
        attemptId, attemptGeneration: reservation.binding.attempt?.generation,
        noPut: true, noOp: linkAlreadyBound, linkAlreadyBound, placement: current };
    }
    if (reservation.result === "bound") {
      reservation = await linkBindingRequest({ action: "reserve", linkKey, objectRef, attemptId, placement, acquirePlacement: true });
    }
    await lifecycleRequest({ action: "requestPlacementAcquire", objectRef, placement });
    current = await inspectManagedPlacement(objectRef, kind);
    if (current?.state === "PRESENT") {
      return { linkKey, baseDomain, objectRef, storageKey: current.locator.key, contentCid,
        attemptId, attemptGeneration: reservation.binding.attempt?.generation,
        noPut: true, noOp: false, linkAlreadyBound, placement: current };
    }
    const claimed = await lifecycleRequest({ action: "claimPlacement", objectRef, placement: kind, operation: "acquire" });
    return { linkKey, baseDomain, objectRef, storageKey, contentCid, attemptId,
      attemptGeneration: reservation.binding.attempt?.generation,
      noPut: physicalAlreadyPresent, noOp: false, adopted: physicalAlreadyPresent,
      claim: claimed.claim, placement, linkAlreadyBound };
  }

  return prepareManagedUpload;
}
