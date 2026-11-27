const ALLOWED_PHOTOS = ["image/jpeg", "image/png", "image/webp"];

export async function prepareAvatar(file: File): Promise<Blob> {
  if (!ALLOWED_PHOTOS.includes(file.type)) throw new Error("請選擇 JPG、PNG 或 WebP 圖片");
  if (file.size > 20 * 1024 * 1024) throw new Error("請選擇小於 20 MB 的圖片");

  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("無法讀取圖片，請換一張"); });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("無法處理圖片，請換個瀏覽器試試");
    const edge = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge, 0, 0, 256, 256);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("無法處理圖片，請換一張"));
      }, "image/webp", 0.92);
    });
  } finally {
    bitmap.close();
  }
}
