export function shareImageFilename(generatedAt: string): string {
  return `LifeOS对话_${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(generatedAt))}.jpg`;
}
export function mobileImageSave(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (matchMedia("(pointer: coarse)").matches && matchMedia("(max-width: 900px)").matches);
}
/** Invoke write immediately in the click gesture; the PNG is prepared with the preview. */
export function copyShareImage(png: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined" || (ClipboardItem.supports && !ClipboardItem.supports("image/png"))) {
    return Promise.reject(new Error("当前浏览器不支持复制图片，请保存图片"));
  }
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
export async function saveShareImage(jpeg: Blob, url: string, generatedAt: string, mobile: boolean): Promise<"downloaded" | "shared" | "long-press" | "cancelled"> {
  const name = shareImageFilename(generatedAt);
  if (mobile) {
    const file = new File([jpeg], name, { type: "image/jpeg" });
    // A website cannot choose the system's album destination. Never fall back
    // to a file download on mobile or claim that opening a share sheet saved it.
    try {
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) return "long-press";
      await navigator.share({ files: [file] });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      return "long-press";
    }
  }
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  return "downloaded";
}
