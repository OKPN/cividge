import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// Provider-specific physical upload. This does not reserve a Link, authorize a
// Placement, or decide whether PUT is allowed; the caller supplies that plan.
export async function putUploadObject({ s3, bucket, key, bytes, contentType, contentDisposition,
  metadata, provider, isValidIpfsCid, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const putOutput = await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    ContentDisposition: contentDisposition,
    Metadata: metadata,
  }));

  if (provider !== "filebase") return { ipfsCid: null };
  const checkAndValidateCid = raw => {
    if (!raw || typeof raw !== "string") return null;
    const candidate = raw.trim();
    return isValidIpfsCid(candidate) ? candidate : null;
  };
  const headers = putOutput?.$metadata?.httpHeaders || {};
  let ipfsCid = checkAndValidateCid(headers["x-amz-meta-cid"] || headers["x-amz-meta-ipfs-hash"]);
  for (let attempt = 0; attempt < 8 && !ipfsCid; attempt++) {
    try {
      await sleep(600 + attempt * 500);
      const headOutput = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const headHeaders = headOutput?.$metadata?.httpHeaders || {};
      const candidate = headHeaders["x-amz-meta-cid"] || headHeaders["x-amz-meta-ipfs-hash"] ||
        headOutput?.Metadata?.cid || headOutput?.Metadata?.["ipfs-hash"];
      ipfsCid = checkAndValidateCid(candidate);
    } catch (error) {
      console.warn(`HeadObject CID lookup attempt ${attempt + 1} failed:`, error);
    }
  }
  return { ipfsCid };
}
