import { S3Client, DeleteObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";

export function createStorageConnections({ r2AccountId, r2BucketName, r2AccessKeyId, r2SecretAccessKey, filebaseBucket, filebaseApiKey, filebaseSecretKey, getSelectedR2Domain }) {
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

  return { isR2Configured, isFilebaseConfigured, getBucketName, getS3Client, safeDeleteS3Objects };
}
