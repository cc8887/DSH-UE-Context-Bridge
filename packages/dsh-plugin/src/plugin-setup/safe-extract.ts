/**
 * Extract a plugin zip without trusting its paths.
 *
 * Rejects absolute paths, `..`, empty segments, Windows drive prefixes,
 * backslashes, link entries (symlink or hard link), encrypted entries, and
 * zip64. Extraction stays inside the destination directory. The published
 * GeneralBlueprint zips are classic (non-zip64) archives under 4 GiB with a
 * single `GeneralBlueprint/` root.
 */

import { mkdir, writeFile, rm, readdir, lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { PLUGIN_NAME } from './constants.ts';

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 4 * 1024 * 1024 * 1024;

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
  }
}

interface CentralEntry {
  name: string;
  method: number;
  flag: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  externalAttributes: number;
}

function findEocd(data: Buffer): number {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const idx = data.lastIndexOf(sig);
  if (idx < 0 || idx + 22 > data.length) throw new UnsafeArchiveError('zip is missing an end of central directory');
  return idx;
}

function readCentralDirectory(data: Buffer): CentralEntry[] {
  if (data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])) || data.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07]))) {
    throw new UnsafeArchiveError('zip64 archives are refused');
  }
  const eocd = findEocd(data);
  const total = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > data.length) throw new UnsafeArchiveError('central directory is outside the archive');
  const entries: CentralEntry[] = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  while (pos + 46 <= end) {
    if (data.readUInt32LE(pos) !== 0x02014b50) throw new UnsafeArchiveError('broken central directory');
    const flag = data.readUInt16LE(pos + 8);
    const method = data.readUInt16LE(pos + 10);
    const compressedSize = data.readUInt32LE(pos + 20);
    const uncompressedSize = data.readUInt32LE(pos + 24);
    const nameLength = data.readUInt16LE(pos + 28);
    const extraLength = data.readUInt16LE(pos + 30);
    const commentLength = data.readUInt16LE(pos + 32);
    const externalAttributes = data.readUInt32LE(pos + 38);
    const localOffset = data.readUInt32LE(pos + 42);
    const name = data.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    const extra = data.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);
    for (let i = 0; i + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(i);
      const size = extra.readUInt16LE(i + 2);
      if (id === 0x0001) throw new UnsafeArchiveError(`zip64 entry is refused: ${name}`);
      i += 4 + size;
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new UnsafeArchiveError(`zip64 size is refused: ${name}`);
    }
    entries.push({ name, method, flag, compressedSize, uncompressedSize, localOffset, externalAttributes });
    pos += 46 + nameLength + extraLength + commentLength;
    if (entries.length > MAX_ENTRIES) throw new UnsafeArchiveError('archive has too many entries');
  }
  if (entries.length !== total && total !== 0xffff) {
    throw new UnsafeArchiveError(`central directory count ${entries.length} does not match ${total}`);
  }
  return entries;
}

function assertSafeName(name: string): string[] {
  if (name.includes('\\') || name.includes('\0')) throw new UnsafeArchiveError(`illegal path: ${name}`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new UnsafeArchiveError(`absolute path: ${name}`);
  const parts = name.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '..' || part === '.')) throw new UnsafeArchiveError(`path escapes archive: ${name}`);
  return parts;
}

function isLink(entry: CentralEntry): boolean {
  // Unix mode lives in the high 16 bits. S_IFLNK is 0120000. The version-made-by
  // OS is not reliable on Windows zippers, so a link mode is refused whenever
  // it appears. The low 16 bits are the DOS directory bit and are not a mode.
  const mode = (entry.externalAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  return type === 0o120000 || type === 0o010000;
}

function inside(root: string, target: string): boolean {
  const base = resolve(root);
  const full = resolve(target);
  return full === base || full.startsWith(base + sep);
}

async function inflateEntry(data: Buffer, entry: CentralEntry): Promise<Buffer> {
  if (entry.flag & 0x1) throw new UnsafeArchiveError(`encrypted entry: ${entry.name}`);
  if (entry.localOffset + 30 > data.length) throw new UnsafeArchiveError(`local header is outside the archive: ${entry.name}`);
  if (data.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new UnsafeArchiveError(`missing local header: ${entry.name}`);
  }
  const nameLength = data.readUInt16LE(entry.localOffset + 26);
  const extraLength = data.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = data.subarray(start, start + entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new UnsafeArchiveError(`truncated entry: ${entry.name}`);
  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) throw new UnsafeArchiveError(`stored size mismatch: ${entry.name}`);
    return Buffer.from(compressed);
  }
  if (entry.method !== 8) throw new UnsafeArchiveError(`unsupported compression method ${entry.method}: ${entry.name}`);
  const out = inflateRawSync(compressed);
  if (out.length !== entry.uncompressedSize) throw new UnsafeArchiveError(`inflated size mismatch: ${entry.name}`);
  return out;
}

export async function extractPluginArchive(zipPath: string, destination: string): Promise<string> {
  const data = await readFile(zipPath);
  const entries = readCentralDirectory(data);
  let total = 0;
  for (const entry of entries) total += entry.uncompressedSize;
  if (total > MAX_UNCOMPRESSED) throw new UnsafeArchiveError('uncompressed archive is larger than 4 GiB');

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.name.endsWith('/')) {
      const parts = assertSafeName(entry.name);
      const dir = join(destination, ...parts);
      if (!inside(destination, dir)) throw new UnsafeArchiveError(`path escapes destination: ${entry.name}`);
      await mkdir(dir, { recursive: true });
      continue;
    }
    if (isLink(entry)) throw new UnsafeArchiveError(`link entry is refused: ${entry.name}`);
    const parts = assertSafeName(entry.name);
    const target = join(destination, ...parts);
    if (!inside(destination, target)) throw new UnsafeArchiveError(`path escapes destination: ${entry.name}`);
    await mkdir(dirname(target), { recursive: true });
    const bytes = await inflateEntry(data, entry);
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return pluginRootIn(destination);
}

export async function pluginRootIn(directory: string): Promise<string> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new UnsafeArchiveError(`symlink in archive tree: ${full}`);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name === `${PLUGIN_NAME}.uplugin`) found.push(dir);
    }
  }
  await walk(directory, 0);
  if (found.length !== 1) {
    throw new UnsafeArchiveError(
      found.length === 0 ? 'archive has no GeneralBlueprint.uplugin' : 'archive has more than one GeneralBlueprint.uplugin',
    );
  }
  return found[0]!;
}
