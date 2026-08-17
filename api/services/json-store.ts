import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '../../data');

export function resolveDataDir(envVar = 'DATA_DIR'): string {
  return path.resolve(process.env[envVar] ?? DEFAULT_DATA_DIR);
}

export async function readJson<T>(filePath: string): Promise<T> {
  const txt = await fs.readFile(filePath, 'utf8');
  return JSON.parse(txt) as T;
}

// Per-path promise chain so concurrent writeJson calls to the same file are
// serialized instead of interleaving. Keyed by resolved absolute path.
const writeQueues = new Map<string, Promise<void>>();

export async function writeJson(filePath: string, obj: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const previousTail = writeQueues.get(resolvedPath) ?? Promise.resolve();
  const tail = previousTail.then(
    () => writeJsonAtomic(resolvedPath, obj),
    () => writeJsonAtomic(resolvedPath, obj),
  );

  // Keep the chain alive for the next caller regardless of outcome, but
  // don't let a rejection here become an unhandled rejection.
  writeQueues.set(
    resolvedPath,
    tail.then(
      () => undefined,
      () => undefined,
    ),
  );

  return tail;
}

async function writeJsonAtomic(resolvedPath: string, obj: unknown): Promise<void> {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  const dir = path.dirname(resolvedPath);
  await fs.mkdir(dir, { recursive: true });

  // Same-directory temp file so the rename below is an atomic operation on
  // the same filesystem (not guaranteed across directories/filesystems).
  const tmpPath = path.join(
    dir,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    const fh = await fs.open(tmpPath, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      // Flush the temp file's contents to disk before the rename, so a
      // power loss right after the rename can't leave the new directory
      // entry pointing at data that never made it past the page cache.
      await fh.sync();
    } finally {
      await fh.close();
    }

    await fs.rename(tmpPath, resolvedPath);
    await syncDirectoryBestEffort(dir);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

// Syncing the parent directory persists the rename itself (the new/updated
// directory entry), so recovery after a power loss yields either the
// complete old file or the complete new file, never a missing/partial one.
// Directory fsync is supported on Linux (the deployment target) but some
// platforms (e.g. Windows) reject opening a directory as a file handle, so
// this is best-effort and swallows that specific failure.
async function syncDirectoryBestEffort(dir: string): Promise<void> {
  let dh: fs.FileHandle | undefined;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch {
    // Best-effort: not all platforms/filesystems support fsync on a
    // directory handle. The file rename above is still durable on those
    // that don't support it, just without the extra directory-entry guarantee.
  } finally {
    try {
      await dh?.close();
    } catch {
      // Ignore close errors too — nothing more we can do here.
    }
  }
}
