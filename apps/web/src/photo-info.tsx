import { useEffect, useState } from "react";
import type { Asset, PhotoMetadata } from "@lifeos/core";
import { apiRequest } from "./api";

export interface PhotoInfo { readonly photoMetadata?: PhotoMetadata; readonly originalName?: string; readonly mediaType?: string; readonly sizeBytes?: number }
// Format only the label; preserve the original EXIF values in the asset.
const photoNumber = (value: number, decimals: number) => String(Number(value.toFixed(decimals)));
const photoSize = (bytes: number | undefined) => bytes === undefined ? undefined : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
export function photoSummary(value: PhotoInfo | undefined) {
  const metadata = value?.photoMetadata, details = metadata?.details;
  const candidates = [
    { kind: "time", label: "拍摄时间", text: details?.capturedAt?.replace(/^(\d{4}):(\d{2}):(\d{2})/u, "$1-$2-$3").slice(0, 16) },
    { kind: "device", label: "拍摄设备", text: details?.model?.trim() || details?.make?.trim() },
    { kind: "dimensions", label: "尺寸", text: metadata ? `${metadata.width} × ${metadata.height}` : undefined },
    { kind: "size", label: "文件大小", text: photoSize(value?.sizeBytes) },
  ];
  return candidates.filter((item): item is typeof item & { text: string } => Boolean(item.text));
}
export function usePhotoInfo({ asset, assetId = asset?.id, localInfo, disabled = false }: { asset?: Asset; assetId?: string; localInfo?: PhotoInfo; disabled?: boolean }) {
  const [state, setState] = useState<{ id: string; value?: PhotoInfo; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (disabled || !assetId || assetId.startsWith("pending:")) return;
    const controller = new AbortController();
    setState(null);
    apiRequest<PhotoInfo>(`/api/assets/${encodeURIComponent(assetId)}/photo-info`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setState({ id: assetId, value }); })
      .catch(() => { if (!controller.signal.aborted) setState({ id: assetId, error: "暂时无法读取照片信息" }); });
    return () => controller.abort();
  }, [assetId, retry, disabled]);
  const local = !assetId || assetId.startsWith("pending:");
  const loading = !local && state?.id !== assetId;
  const error = !local && state?.id === assetId ? state.error : undefined;
  const value = !local && state?.id === assetId && state.value ? state.value : localInfo ?? asset;
  return { local, loading, error, value, retry: () => setRetry(v => v + 1) };
}

export function PhotoInformation({ info, mobile = false }: { info: ReturnType<typeof usePhotoInfo>; mobile?: boolean }) {
  const { local, loading, error, value, retry } = info;
  const metadata = value?.photoMetadata, details = metadata?.details;
  const identityRows: Array<[string, string | undefined]> = [
    ["拍摄时间", details?.capturedAt ? `${details.capturedAt.replace(/^(\d{4}):(\d{2}):(\d{2})/u, "$1-$2-$3")}${details.timeZoneOffset ? ` UTC${details.timeZoneOffset}` : "（时区未记录）"}` : undefined],
    ["拍摄设备", [details?.make, details?.model].filter(Boolean).join(" ") || undefined],
  ];
  const rows: Array<[string, string | undefined]> = [
    ["尺寸", metadata ? `${metadata.width} × ${metadata.height} 像素` : undefined],
    ["文件大小", photoSize(value?.sizeBytes)],
  ];
  const cameraRows: Array<[string, string | undefined]> = [
    ["焦距", details?.focalLength === undefined ? undefined : `${photoNumber(details.focalLength, 3)} mm`],
    ["光圈", details?.aperture === undefined ? undefined : `f/${photoNumber(details.aperture, 2)}`],
    ["快门", details?.exposureSeconds === undefined ? undefined : details.exposureSeconds > 0 && details.exposureSeconds < 1 ? `1/${Math.round(1 / details.exposureSeconds)} 秒` : `${photoNumber(details.exposureSeconds, 3)} 秒`],
    ["ISO", details?.iso?.toString()],
  ];
  const locationRows: Array<[string, string | undefined]> = [
    ["GPS 坐标", details?.latitude !== undefined && details.longitude !== undefined ? `${details.latitude.toFixed(6)}, ${details.longitude.toFixed(6)}` : undefined],
  ];
  const extraRows: Array<[string, string | undefined]> = [
    ["文件名", value?.originalName],
    ["格式", value?.mediaType],
    ["镜头", details?.lens],
    ["海拔", details?.altitude === undefined ? undefined : `${details.altitude.toFixed(1)} 米`],
    ["曝光补偿", details?.exposureBias === undefined ? undefined : `${photoNumber(details.exposureBias, 2)} EV`],
    ["闪光灯", details?.flash === undefined ? undefined : (details.flash & 1) === 1 ? "已闪光" : "未闪光"],
    ["白平衡", details?.whiteBalance === undefined ? undefined : details.whiteBalance === 0 ? "自动" : details.whiteBalance === 1 ? "手动" : details.whiteBalance.toString()],
    ["处理软件", details?.software], ["作者", details?.artist], ["版权", details?.copyright], ["说明", details?.description],
  ];
  const present = (source: typeof rows) => source.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== "");
  const identity = present(identityRows), basic = present(rows), camera = present(cameraRows), location = present(locationRows), extra = present(extraRows);
  const renderRows = (source: Array<[string, string]>, className?: string) => <dl className={className}>{source.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>;
  return <aside className="photo-information" aria-label="照片信息"><h2>照片信息</h2>
    {identity.length ? <dl className="photo-information-identity">{identity.map(([label, text]) => <div key={label}><dt>{label}</dt><dd className={label === "拍摄时间" ? "photo-information-capture" : undefined}>{label === "拍摄时间" ? <><span>{text.slice(0, 10)}</span>{" "}<span>{text.slice(11, 19)}</span>{" "}<small>{text.slice(20)}</small></> : text}</dd></div>)}</dl> : null}
    {basic.length ? renderRows(basic, "photo-information-specs") : null}
    {camera.length ? renderRows(camera, "photo-information-camera") : null}
    {location.length ? renderRows(location, "photo-information-location") : null}
    {loading ? <p className="photo-information-note" role="status">正在读取拍摄信息…</p> : null}
    {error ? <div className="photo-information-error"><p className="photo-information-note" role="alert">{error}</p><button type="button" className="secondary-button" onClick={retry}>重试</button></div> : null}
    {local ? <p className="photo-information-note">上传完成后可查看拍摄信息</p> : !loading && !error && !details ? <p className="photo-information-note">未读取到拍摄信息</p> : null}
    {extra.length ? mobile ? <div className="photo-information-additional">{renderRows(extra)}</div> : <details className="photo-information-more"><summary>更多信息</summary>{renderRows(extra)}</details> : null}
  </aside>;
}
