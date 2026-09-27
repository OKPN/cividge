// Owns the transient upload queue and its conversion cache. Persisted Link,
// Object, and Placement state remains with the Worker authorities.
export function createUploadState() {
  let files = [];
  let results = [];
  let convertedSignature = null;

  function getFiles() { return files; }
  function getResults() { return results; }
  function addFiles(added) { files.push(...added); }
  function clear() { files = []; results = []; convertedSignature = null; }
  function removeAt(index) { files.splice(index, 1); results.splice(index, 1); convertedSignature = null; }
  function setResult(index, result) { results[index] = result; }
  function clearResults() { results = []; convertedSignature = null; }
  function beginConversion() { results = new Array(files.length).fill(null); convertedSignature = null; }
  function completeConversion(signature) { convertedSignature = signature; }
  function invalidateConversion() { convertedSignature = null; }
  function isConversionCacheValid(signature) {
    return files.length > 0 && results.length === files.length &&
      results.every(result => result && result.blob) && convertedSignature === signature;
  }

  return { getFiles, getResults, addFiles, clear, removeAt, setResult, clearResults,
    beginConversion, completeConversion, invalidateConversion, isConversionCacheValid };
}
