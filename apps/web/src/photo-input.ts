import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from "react";
import { SHOT_REORDER_TYPE, type ShotDropZoneHandle } from "./shot-drop-zone";

/** Shared by the journal composer and assistant; internal photo reorders stay in ShotDropZone. */
export function usePhotoInput(ref: RefObject<ShotDropZoneHandle | null>, disabled: boolean, onVideos?: (files: readonly File[]) => void) {
  const depth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const isFiles = (event: DragEvent<HTMLElement>) => !Array.from(event.dataTransfer.types).includes(SHOT_REORDER_TYPE) && Array.from(event.dataTransfer.types).includes("Files");
  const handlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => { if (!isFiles(event)) return; event.preventDefault(); if (!disabled) { depth.current++; setDraggingFiles(true); } },
    onDragOver: (event: DragEvent<HTMLDivElement>) => { if (!isFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => { if (!isFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDraggingFiles(false); },
    onDrop: (event: DragEvent<HTMLDivElement>) => { if (!isFiles(event)) return; event.preventDefault(); depth.current = 0; setDraggingFiles(false); if (!disabled) { const files = Array.from(event.dataTransfer.files); if (onVideos) { const videos = files.filter(file => file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name)); if (videos.length) onVideos(videos); const photos = files.filter(file => !videos.includes(file)); if (photos.length) ref.current?.takeFiles(photos); } else ref.current?.takeFiles(files); } },
    onPaste: (event: ClipboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => file !== null && file.type.startsWith("image/"));
      if (!files.length) return; event.preventDefault(); ref.current?.takeFiles(files);
    },
  };
  return { draggingFiles, handlers };
}
