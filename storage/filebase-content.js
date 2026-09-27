import { importer as importUnixFs } from "ipfs-unixfs-importer";
import { BlackHoleBlockstore } from "blockstore-core";
import { ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";

export function createFilebaseContent({ isValidIpfsCid, getStoredIpfsCid, storeIpfsCid, getManagedContents }) {
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

    // 1. [INV-CORE-001] [INV-CORE-004] 手元のローカル台帳キャッシュを最優先照会（通信完全ゼロ）
    try {
      const localList = getManagedContents();
      const matched = localList.find(item => {
        // 🛡️ [INV-STORAGE-006] Filebase 実体が既に解放・削除されたレコード（isFromS3 === false）は重複元として参照しない
        if (item.isFromS3 === false) return false;
        const c = item.contentCid || item.cid || item.metadata?.cid || item.metadata?.c || getStoredIpfsCid(item.Key || item.name);
        return c === targetCid;
      });
      if (matched) {
        return { key: matched.s3Key || matched.Key || matched.name, cid: targetCid, size: matched.Size || matched.size || 0 };
      }
    } catch (_) {}

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

  return { getIpfsCidFromS3Response, calculateFilebaseCid, findFilebaseObjectByCid };
}
