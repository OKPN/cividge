import { ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";

export function createR2Content({ getStoredIpfsCid, getManagedContents }) {
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

    // 1. [INV-CORE-001] [INV-CORE-004] 手元のローカル台帳キャッシュから最優先照会（通信完全ゼロ）
    // 1ファイルアップロードごとに fetchKvFiles()（kv.list() 全件走査）を叩く異常消費を根絶。
    const kvHashMap = new Map();
    try {
      const localList = getManagedContents();
      for (const item of localList) {
        // 🛡️ [INV-STORAGE-006] R2 実体が既に解放・削除されたレコード（isFromS3 === false）は重複元として参照しない
        if (item.isFromS3 === false) continue;

        const h = item.contentCid || item.cid || item.metadata?.contentCid || item.metadata?.c_cid || item.metadata?.cid || item.metadata?.hash || item.metadata?.h_sha;
        if (h) {
          const sKey = item.s3Key || item.metadata?.s3Key || item.metadata?.k_s3 || item.Key || item.name;
          kvHashMap.set(sKey, h);
          kvHashMap.set(item.Key || item.name, h);
          if (h === targetHash) {
            return { key: sKey, hash: targetHash, size: item.Size || item.size || 0 };
          }
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

  return { calculateContentHash, getStoredR2Hash, storeR2Hash, deleteR2Hash, findR2ObjectByHash };
}
