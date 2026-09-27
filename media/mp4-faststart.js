// ==========================================
// 🎬 MP4 FastStart 最適化エンジン (moov atom 先頭再配置)
// ==========================================
export async function applyFastStartToMp4(mp4BlobOrBuffer) {
  try {
    const buffer = (mp4BlobOrBuffer instanceof ArrayBuffer) ? mp4BlobOrBuffer : await mp4BlobOrBuffer.arrayBuffer();
    const view = new DataView(buffer);
    const length = buffer.byteLength;

    let offset = 0;
    let ftypAtom = null;
    let moovAtom = null;
    let moovOffset = -1;
    let mdatOffset = -1;

    while (offset < length - 8) {
      let atomSize = view.getUint32(offset);
      const atomType = String.fromCharCode(
        view.getUint8(offset + 4),
        view.getUint8(offset + 5),
        view.getUint8(offset + 6),
        view.getUint8(offset + 7)
      );

      if (atomSize === 1) {
        // 64-bit extended size
        atomSize = Number(view.getBigUint64(offset + 8));
      } else if (atomSize === 0) {
        atomSize = length - offset;
      }

      if (atomSize <= 0 || offset + atomSize > length) break;

      if (atomType === "ftyp" && !ftypAtom) {
        ftypAtom = new Uint8Array(buffer, offset, atomSize);
      } else if (atomType === "moov") {
        moovAtom = new Uint8Array(buffer, offset, atomSize);
        moovOffset = offset;
      } else if (atomType === "mdat" && mdatOffset === -1) {
        mdatOffset = offset;
      }

      offset += atomSize;
    }

    // moov が存在し、mdat より後ろにある場合のみ先頭（ftypの直後）へ引っ越しさせる
    if (!moovAtom || mdatOffset === -1 || moovOffset < mdatOffset) {
      return mp4BlobOrBuffer; // 既に先頭にあるか、未対応
    }

    const moovSize = moovAtom.byteLength;
    // moov 内の stco (32-bit offset) と co64 (64-bit offset) を moovSize 分だけ前方シフト修正
    const patchedMoov = new Uint8Array(moovAtom);
    const moovView = new DataView(patchedMoov.buffer, patchedMoov.byteOffset, patchedMoov.byteLength);

    for (let i = 0; i < patchedMoov.length - 8; i++) {
      const tag = String.fromCharCode(
        patchedMoov[i],
        patchedMoov[i + 1],
        patchedMoov[i + 2],
        patchedMoov[i + 3]
      );

      if (tag === "stco") {
        const count = moovView.getUint32(i + 8);
        let entryOffset = i + 12;
        for (let c = 0; c < count; c++) {
          const curVal = moovView.getUint32(entryOffset);
          moovView.setUint32(entryOffset, curVal + moovSize);
          entryOffset += 4;
        }
      } else if (tag === "co64") {
        const count = moovView.getUint32(i + 8);
        let entryOffset = i + 12;
        for (let c = 0; c < count; c++) {
          const curVal = moovView.getBigUint64(entryOffset);
          moovView.setBigUint64(entryOffset, curVal + BigInt(moovSize));
          entryOffset += 8;
        }
      }
    }

    // 新しい MP4 の組み立て: [ftyp] + [patchedMoov] + [mdat以降のデータ(moov以外)]
    const newLength = length;
    const resultBuffer = new Uint8Array(newLength);
    let writePos = 0;

    if (ftypAtom) {
      resultBuffer.set(ftypAtom, writePos);
      writePos += ftypAtom.byteLength;
    }

    resultBuffer.set(patchedMoov, writePos);
    writePos += patchedMoov.byteLength;

    // ftyp 以降から moov 以外の部分をコピー
    const startAfterFtyp = ftypAtom ? ftypAtom.byteLength : 0;
    const beforeMoov = new Uint8Array(buffer, startAfterFtyp, moovOffset - startAfterFtyp);
    resultBuffer.set(beforeMoov, writePos);
    writePos += beforeMoov.byteLength;

    const afterMoovOffset = moovOffset + moovSize;
    if (afterMoovOffset < length) {
      const afterMoov = new Uint8Array(buffer, afterMoovOffset, length - afterMoovOffset);
      resultBuffer.set(afterMoov, writePos);
    }

    return new Blob([resultBuffer], { type: "video/mp4" });
  } catch (err) {
    console.warn("MP4 FastStart optimization skipped due to error:", err);
    return mp4BlobOrBuffer;
  }
}

