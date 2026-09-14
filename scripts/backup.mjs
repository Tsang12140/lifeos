import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function usage() {
  console.log("Usage: node scripts/backup.mjs [source.sqlite] [destination.sqlite]");
  console.log("Defaults: LIFEOS_DB_PATH or LIFEOS_DATA_DIR/lifeos.sqlite, and backup/lifeos-<UTC>.sqlite");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}

const dataDirectory = process.env.LIFEOS_DATA_DIR ?? "data";
const source = resolve(process.argv[2] ?? process.env.LIFEOS_DB_PATH ?? `${dataDirectory}/lifeos.sqlite`);
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
const destination = resolve(process.argv[3] ?? `backup/lifeos-${stamp}.sqlite`);

if (!existsSync(source)) {
  console.error(`SQLite source does not exist: ${source}`);
  process.exit(1);
}
if (source === destination) {
  console.error("Backup destination must differ from the source database");
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`Refusing to overwrite existing backup: ${destination}`);
  process.exit(1);
}
if (!isAbsolute(source) || !isAbsolute(destination)) {
  console.error("Database paths could not be resolved");
  process.exit(1);
}

mkdirSync(dirname(destination), { recursive: true });
const sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
try {
  const pages = await backup(sourceDb, destination);
  console.log(`SQLite backup created: ${destination} (${pages} pages)`);
} finally {
  sourceDb.close();
}
