import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-json-store-test-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

let importCounter = 0;

async function importStore() {
  // Fresh import each test so any module-level state (the write queue map)
  // starts empty and DATA_DIR is picked up freshly.
  importCounter += 1;
  return import('../../../api/services/json-store.ts?t=' + Date.now() + '-' + importCounter);
}

describe('json-store', () => {
  describe('resolveDataDir', () => {
    it('resolves from the given env var', async () => {
      const { resolveDataDir } = await importStore();
      expect(resolveDataDir()).toBe(path.resolve(tmpDir));
    });

    it('falls back to the default data dir when the env var is unset', async () => {
      delete process.env.DATA_DIR;
      const { resolveDataDir } = await importStore();
      expect(resolveDataDir()).toMatch(/[/\\]data$/);
    });
  });

  describe('readJson / writeJson round-trip', () => {
    it('writes an object and reads back an equal object', async () => {
      const { readJson, writeJson } = await importStore();
      const filePath = path.join(tmpDir, 'roundtrip.json');
      const value = { a: 1, b: { c: [1, 2, 3] }, d: 'text' };

      await writeJson(filePath, value);
      const readBack = await readJson(filePath);

      expect(readBack).toEqual(value);
    });

    it('creates the parent directory if it does not exist', async () => {
      const { readJson, writeJson } = await importStore();
      const filePath = path.join(tmpDir, 'nested', 'dir', 'file.json');

      await writeJson(filePath, { ok: true });
      const readBack = await readJson(filePath);

      expect(readBack).toEqual({ ok: true });
    });

    it('writes pretty-printed JSON terminated with a newline', async () => {
      const { writeJson } = await importStore();
      const { readFile } = await import('node:fs/promises');
      const filePath = path.join(tmpDir, 'pretty.json');

      await writeJson(filePath, { a: 1 });
      const raw = await readFile(filePath, 'utf8');

      expect(raw).toBe('{\n  "a": 1\n}\n');
    });
  });

  describe('atomic writes under concurrency', () => {
    it('serializes many concurrent writes to the same path: last write wins, file stays parseable', async () => {
      const { readJson, writeJson } = await importStore();
      const filePath = path.join(tmpDir, 'concurrent.json');

      const writeCount = 50;
      const writes = [];
      for (let i = 0; i < writeCount; i++) {
        writes.push(writeJson(filePath, { i, tag: `write-${i}` }));
      }
      await Promise.all(writes);

      // The last call issued should be the last one applied, since writes
      // to the same path are serialized in call order.
      const finalValue = await readJson(filePath);
      expect(finalValue).toEqual({ i: writeCount - 1, tag: `write-${writeCount - 1}` });
    });

    it('leaves no leftover temp files after concurrent writes complete', async () => {
      const { writeJson } = await importStore();
      const filePath = path.join(tmpDir, 'no-leftovers.json');

      await Promise.all(Array.from({ length: 25 }, (_, i) => writeJson(filePath, { i })));

      const entries = await readdir(tmpDir);
      expect(entries).toEqual(['no-leftovers.json']);
    });

    it('does not interleave writes to different paths', async () => {
      const { readJson, writeJson } = await importStore();
      const pathA = path.join(tmpDir, 'a.json');
      const pathB = path.join(tmpDir, 'b.json');

      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => writeJson(pathA, { file: 'a', i })),
        ...Array.from({ length: 10 }, (_, i) => writeJson(pathB, { file: 'b', i })),
      ]);

      expect(await readJson(pathA)).toEqual({ file: 'a', i: 9 });
      expect(await readJson(pathB)).toEqual({ file: 'b', i: 9 });

      const entries = await readdir(tmpDir);
      expect(entries.sort()).toEqual(['a.json', 'b.json']);
    });
  });
});
