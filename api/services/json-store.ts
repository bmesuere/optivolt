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

export async function writeJson(filePath: string, obj: unknown): Promise<void> {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, json, 'utf8');
}
