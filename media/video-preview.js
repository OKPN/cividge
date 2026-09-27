// 🖼️ 動画の0秒目（先頭フレーム）を軽量WebPサムネイルとして高速抽出
export async function captureVideoFirstFrame(videoBlob) {
  return new Promise((resolve) => {
    try {
      const video = document.createElement("video");
      const url = URL.createObjectURL(videoBlob);
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;

      let resolved = false;
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          URL.revokeObjectURL(url);
          video.remove();
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 5000); // 最大5秒でタイムアウト

      video.onloadeddata = () => {
        try {
          video.currentTime = 0;
        } catch (e) {}
      };

      video.onseeked = async () => {
        try {
          const canvas = document.createElement("canvas");
          const maxDim = 640;
          let w = video.videoWidth || 640;
          let h = video.videoHeight || 360;

          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }

          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, w, h);

          canvas.toBlob((blob) => {
            clearTimeout(timer);
            cleanup();
            resolve(blob);
          }, "image/webp", 0.82);
        } catch (err) {
          console.warn("Frame capture canvas error:", err);
          clearTimeout(timer);
          cleanup();
          resolve(null);
        }
      };

      video.onerror = () => {
        clearTimeout(timer);
        cleanup();
        resolve(null);
      };
    } catch (e) {
      console.warn("captureVideoFirstFrame error:", e);
      resolve(null);
    }
  });
}

