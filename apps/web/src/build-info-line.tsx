import { useEffect, useState } from "react";
import buildStamp from "virtual:lifeos-build";

/**
 * Two versions, side by side, because they can disagree.
 *
 * The bundle's own stamp is frozen in when the config loads; the server's comes
 * from `/api/health`. Same commit on both means the browser is running what the
 * server serves. A mismatch means the browser is holding an old bundle — which is
 * exactly the state that makes a just-deployed fix look like it never happened.
 */
interface HealthVersion {
  readonly version?: string;
  readonly commit?: string | null;
  readonly dirty?: boolean;
  readonly builtAt?: string | null;
}

function stamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function name(commit: string | null | undefined, dirty: boolean | undefined, fallback: string): string {
  if (commit === null || commit === undefined || commit === "") return fallback;
  return dirty === true ? `${commit}+未提交` : commit;
}

export function BuildInfoLine() {
  const [server, setServer] = useState<HealthVersion | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<HealthVersion>) : Promise.reject(new Error(String(response.status)))))
      .then((body) => { setServer(body); setFailed(false); })
      .catch((cause: unknown) => { if ((cause as { name?: string } | null)?.name !== "AbortError") setFailed(true); });
    return () => controller.abort();
  }, []);

  const serverCommit = server?.commit ?? null;
  const mismatch = serverCommit !== null && buildStamp.commit !== null && serverCommit !== buildStamp.commit;
  const bundleStamp = stamp(buildStamp.builtAt);

  return <div className="settings-build-info" data-build-mismatch={mismatch || undefined}>
    <span>界面 <b>{name(buildStamp.commit, buildStamp.dirty, "无提交")}</b>{buildStamp.version === "" ? null : <> · v{buildStamp.version}</>}</span>
    <span>服务端 <b>{failed ? "读不到" : server === null ? "读取中…" : name(serverCommit, server.dirty, "无提交")}</b></span>
    {bundleStamp ? <span>构建于 {bundleStamp}</span> : null}
    {mismatch ? <strong>浏览器在跑旧版本，刷新一次即可</strong> : null}
  </div>;
}
