// A recoverable local badge cache, not Object/Link authority.
export function recordUploadedWorkflow(result, isConvertOn) {
  const fileExt = (result.name || "").split(".").pop().toLowerCase();
  const isVideo = ["mp4", "webm", "mov"].includes(fileExt);
  const retainsWorkflow = (!isConvertOn || isVideo) &&
    (result.metaStatus?.hasWorkflow || result.metaStatus?.hasPrompt);
  const wfStore = JSON.parse(localStorage.getItem("comfyWfMap") || "{}");
  if (retainsWorkflow) {
    wfStore[result.name] = true;
    localStorage.setItem("comfyWfMap", JSON.stringify(wfStore));
  } else if (wfStore[result.name]) {
    delete wfStore[result.name];
    localStorage.setItem("comfyWfMap", JSON.stringify(wfStore));
  }
}
