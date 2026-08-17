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

// Per-path promise chain so concurrent writeJson calls to the same file serialize.
const writeQueues = new Map<string, Promise<void>>();

export async function writeJson(filePath: string, obj: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const previousTail = writeQueues.get(resolvedPath) ?? Promise.resolve();
  const tail = previousTail.then(
    () => writeJsonAtomic(resolvedPath, obj),
    () => writeJsonAtomic(resolvedPath, obj),
  );

  // Chain must not reject, or it would break the queue for the next caller.
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

  // Same-directory temp file so the rename below is atomic (same filesystem).
  const tmpPath = path.join(
    dir,
    `.${path.basename(resolvedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  try {
    const fh = await fs.open(tmpPath, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      // Flush to disk before rename, or a power loss could leave the renamed file empty/partial.
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

// Persists the rename itself. Best-effort: some platforms (e.g. Windows)
// can't fsync a directory handle, so failures here are swallowed.
async function syncDirectoryBestEffort(dir: string): Promise<void> {
  let dh: fs.FileHandle | undefined;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch {
    // ignore
  } finally {
    try {
      await dh?.close();
    } catch {
      // ignore
    }
  }
}
