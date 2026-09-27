#!/usr/bin/env bash
# Offline whole-instance snapshot for the existing BaoTa + PM2 deployment.
# Run as the same operator that owns PM2. Only the process named "lifeos" is
# stopped; other PM2 applications are never touched.
set -Eeuo pipefail
umask 077

: "${LIFEOS_NODE_BIN:?set LIFEOS_NODE_BIN to the absolute Node 24 binary}"
: "${LIFEOS_INSTANCE_DATA_DIR:?set LIFEOS_INSTANCE_DATA_DIR to the LifeOS data volume}"
: "${LIFEOS_INSTANCE_BACKUP_ROOT:?set LIFEOS_INSTANCE_BACKUP_ROOT outside the data volume}"

project_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
data_dir="$(cd "$LIFEOS_INSTANCE_DATA_DIR" && pwd -P)"
asset_dir="$data_dir/assets"
backup_root="$LIFEOS_INSTANCE_BACKUP_ROOT"
if [[ ! -d "$asset_dir" ]]; then
  echo "拒绝备份：资产目录不存在：$asset_dir" >&2
  exit 1
fi
if [[ ! -f "$project_dir/.env" ]]; then
  echo "拒绝异地备份：项目 .env 不存在" >&2
  exit 1
fi
if [[ "$("$LIFEOS_NODE_BIN" -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  echo "整站备份需要 Node 24 或更新版本" >&2
  exit 1
fi
export PATH="$(dirname "$LIFEOS_NODE_BIN"):$PATH"
backup_parent="$(cd "$(dirname "$backup_root")" && pwd -P)"
backup_root="$backup_parent/$(basename "$backup_root")"
if [[ "$backup_root" == "$data_dir" || "$backup_root" == "$data_dir/"* || "$data_dir" == "$backup_root/"* ]]; then
  echo "备份根目录不得与数据卷互相包含" >&2
  exit 1
fi
install -d -m 700 "$backup_root"
backup_root="$(cd "$backup_root" && pwd -P)"
if [[ "$backup_root" == "$data_dir" || "$backup_root" == "$data_dir/"* || "$data_dir" == "$backup_root/"* ]]; then
  echo "备份根目录解析后与数据卷互相包含" >&2
  exit 1
fi

exec 9>"$backup_root/.lifeos-instance-backup.lock"
if ! flock -n 9; then
  echo "已有整站备份任务运行，本次跳过" >&2
  exit 1
fi
if ! pm2 pid lifeos | grep -Eq '^[1-9][0-9]*$'; then
  echo "PM2 中 lifeos 未在线，拒绝擅自启动或改变其状态" >&2
  exit 1
fi

# Probe the private bucket before any service interruption. This uploads and
# removes only an innocuous canary, never application data.
cd "$project_dir"
LIFEOS_DATA_DIR="$data_dir" "$LIFEOS_NODE_BIN" --env-file=.env scripts/backup-instance-remote.mjs check

snapshot="$backup_root/lifeos-$(date -u +%Y%m%dT%H%M%SZ)-$$"
stopped=0
restart_lifeos() {
  if [[ "$stopped" == 1 ]]; then
    pm2 start lifeos
    stopped=0
  fi
}
trap restart_lifeos EXIT
cd "$project_dir"
stopped=1
pm2 stop lifeos
"$LIFEOS_NODE_BIN" scripts/backup-instance.mjs backup \
  --source "$data_dir" --output "$snapshot" --asset-root "$asset_dir" \
  --account-mode --offline-confirmed
restart_lifeos
"$LIFEOS_NODE_BIN" scripts/backup-instance.mjs verify --snapshot "$snapshot"
LIFEOS_DATA_DIR="$data_dir" "$LIFEOS_NODE_BIN" --env-file=.env scripts/backup-instance-remote.mjs upload --snapshot "$snapshot"
echo "整站本地与异地备份完成；本地快照：$snapshot"
