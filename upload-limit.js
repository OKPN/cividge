// The public UI and its final-storage path use decimal megabytes.
export const GLOBAL_UPLOAD_LIMIT_BYTES = 80_000_000;
export const exceedsUploadLimit = byteLength => Number(byteLength) > GLOBAL_UPLOAD_LIMIT_BYTES;
