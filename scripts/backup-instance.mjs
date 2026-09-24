// Offline disaster-recovery copy of the *whole* persistent LifeOS data tree.
// Unlike /api/backup, this includes identity.sqlite, tenant databases, assets,
// integration config files, and prior snapshots. Never run it against a live
// writer or place the output under the source volume.
import { backupInstance, restoreInstanceBackup, verifyInstanceBackup } from "./lib/instance-backup.mjs";

function options(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (!part.startsWith("--")) throw new Error(`无法识别的参数：${part}`);
    if (part === "--offline-confirmed" || part === "--account-mode") { parsed.set(part, true); continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${part} 缺少值`);
    parsed.set(part, value);
  }
  return parsed;
}

try {
  const [command, ...args] = process.argv.slice(2);
  const flags = options(args);
  let result;
  if (command === "backup") {
    result = await backupInstance({
      source: flags.get("--source"), output: flags.get("--output"),
      accountMode: flags.get("--account-mode") === true,
      assetRoot: flags.get("--asset-root") ?? process.env.LIFEOS_ASSET_ROOT,
      offlineConfirmed: flags.get("--offline-confirmed") === true,
    });
  } else if (command === "verify") {
    if (!flags.get("--snapshot")) throw new Error("verify 需要 --snapshot");
    result = await verifyInstanceBackup(flags.get("--snapshot"));
  } else if (command === "restore") {
    if (!flags.get("--snapshot")) throw new Error("restore 需要 --snapshot");
    result = await restoreInstanceBackup({ snapshot: flags.get("--snapshot"), target: flags.get("--target") });
  } else {
    throw new Error("用法：node scripts/backup-instance.mjs backup --source <已停机的数据卷> --output <新目录> --account-mode --offline-confirmed | verify --snapshot <目录> | restore --snapshot <目录> --target <新目录>");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
