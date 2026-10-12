const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|m4v|mkv|3gp|ts)$/i;
export const MEDIA_FILE_ACCEPT = "image/*,video/*,.mp4,.mov,.webm,.m4v,.mkv,.3gp,.ts";

/** Browser MIME detection is incomplete for files dragged from mobile apps. */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith("image/")) return false;
  return file.type.startsWith("video/") || VIDEO_EXTENSIONS.test(file.name);
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("video/")) return false;
  return file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|avif|heic|heif)$/i.test(file.name);
}
