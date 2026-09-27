// Run with Node 24 and the same .env used by LifeOS. The effective owner S3
// config may come from .env or the encrypted settings file; keys are never printed.
import { readConfig } from "../apps/api/dist/src/config.js";
import { resolvedBackupS3 } from "../apps/api/dist/src/backup-config.js";
import { checkInstanceDestination, downloadInstanceSnapshot, uploadInstanceSnapshot } from "./lib/instance-remote.mjs";

function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(name + " 缺少值");
  return args[index + 1];
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!["check", "upload", "download"].includes(command)) throw new Error("用法：check | upload --snapshot <已校验快照目录> | download --manifest-key <返回的对象键> --target <全新目录>");
  const config = readConfig();
  const base = resolvedBackupS3(config);
  if (!base?.enabled) throw new Error("LifeOS 对象存储未启用或密钥无法解密；拒绝假装完成异地备份");
  const bucket = process.env.LIFEOS_INSTANCE_BACKUP_S3_BUCKET?.trim();
  if (!bucket) throw new Error("必须显式设置 LIFEOS_INSTANCE_BACKUP_S3_BUCKET 为确认私有的桶；不会默认把账号库与照片传到普通数据库备份桶");
  const s3 = {
    ...base,
    bucket,
    endpoint: process.env.LIFEOS_INSTANCE_BACKUP_S3_ENDPOINT?.trim() || base.endpoint,
    region: process.env.LIFEOS_INSTANCE_BACKUP_S3_REGION?.trim() || base.region,
    prefix: process.env.LIFEOS_INSTANCE_BACKUP_S3_PREFIX?.trim() || base.prefix,
    accessKeyId: process.env.LIFEOS_INSTANCE_BACKUP_S3_ACCESS_KEY_ID?.trim() || base.accessKeyId,
    secretAccessKey: process.env.LIFEOS_INSTANCE_BACKUP_S3_SECRET_ACCESS_KEY?.trim() || base.secretAccessKey,
    forcePathStyle: process.env.LIFEOS_INSTANCE_BACKUP_S3_FORCE_PATH_STYLE === undefined
      ? base.forcePathStyle : process.env.LIFEOS_INSTANCE_BACKUP_S3_FORCE_PATH_STYLE === "true",
  };
  const result = command === "check" ? await checkInstanceDestination({ s3 })
    : command === "upload" ? await uploadInstanceSnapshot({ snapshot: flag(args, "--snapshot"), s3 })
    : await downloadInstanceSnapshot({ manifestKey: flag(args, "--manifest-key"), target: flag(args, "--target"), s3 });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
