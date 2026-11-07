/**
 * Pick one published Win64 zip for an engine version.
 *
 * Asset names from the real releases:
 *   v1.0.0-beta.1  GeneralBlueprint-UE_<major>.<minor>-Win64.zip   (4.26 through 5.8)
 *   v1.1.0-beta.1  GeneralBlueprint-UE_5.8.1-Win64.zip              (that patch only)
 *
 * An exact major.minor.patch name wins. A major.minor name is the publisher's
 * whole minor line, and is used only when that line was not split by patch
 * (every release before 5.8.1) or when the engine patch is 0 (the unsuffixed
 * 5.8 package). A 5.8.2 engine does not receive the 5.8.1 zip or the bare 5.8
 * zip. Nothing is chosen by "closest version".
 */

import { createHash } from 'node:crypto';
import { GENERAL_BLUEPRINT, DOWNLOAD_HOSTS, USER_AGENT } from './constants.ts';
import type { BuildVersionFile } from './build-id.ts';

export interface ReleaseAsset {
  tag: string;
  name: string;
  versionLabel: string;
  major: number;
  minor: number;
  patch?: number;
  sha256?: string;
  /** Where the hash came from. Both are SHA-256 of the zip; neither is a signature. */
  sha256From?: 'github-digest+sums' | 'github-digest' | 'publisher-sums';
  downloadUrl: string;
  size?: number;
}

export type ReleaseMatch =
  | { ok: true; match: 'exact-patch' | 'minor-line'; asset: ReleaseAsset }
  | { ok: false; reason: string };

const ASSET_NAME = /^GeneralBlueprint-UE_(\d+)\.(\d+)(?:\.(\d+))?-Win64\.zip$/;
const TAG_NAME = /^[A-Za-z0-9._-]+$/;

export function parseAssetName(name: string): { major: number; minor: number; patch?: number; versionLabel: string } | undefined {
  const match = ASSET_NAME.exec(name);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? undefined : Number(match[3]);
  return {
    major,
    minor,
    ...(patch === undefined ? {} : { patch }),
    versionLabel: patch === undefined ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
  };
}

export function selectReleaseAsset(version: BuildVersionFile, assets: readonly ReleaseAsset[]): ReleaseMatch {
  const exact = assets.filter(
    (asset) =>
      asset.patch !== undefined &&
      asset.major === version.major &&
      asset.minor === version.minor &&
      asset.patch === version.patch,
  );
  if (exact.length === 1) return { ok: true, match: 'exact-patch', asset: exact[0]! };
  if (exact.length > 1) {
    return {
      ok: false,
      reason: `More than one package is named for ${version.major}.${version.minor}.${version.patch}: ${exact.map((item) => `${item.tag}/${item.name}`).join(', ')}.`,
    };
  }

  const patchSpecific = assets.filter(
    (asset) => asset.patch !== undefined && asset.major === version.major && asset.minor === version.minor,
  );
  if (version.patch !== 0 && patchSpecific.length > 0) {
    return {
      ok: false,
      reason:
        `No package is published for ${version.major}.${version.minor}.${version.patch}. ` +
        `Not using ${patchSpecific.map((item) => item.name).join(', ')}.`,
    };
  }

  const minor = assets.filter(
    (asset) => asset.patch === undefined && asset.major === version.major && asset.minor === version.minor,
  );
  if (minor.length === 1) return { ok: true, match: 'minor-line', asset: minor[0]! };
  if (minor.length > 1) {
    return {
      ok: false,
      reason: `More than one ${version.major}.${version.minor} package: ${minor.map((item) => `${item.tag}/${item.name}`).join(', ')}.`,
    };
  }
  return {
    ok: false,
    reason: `No Win64 release package for Unreal ${version.major}.${version.minor}.${version.patch}. Source compilation is not used as a substitute on a launcher engine.`,
  };
}

interface GitHubRelease {
  tag_name?: string;
  assets?: Array<{
    name?: string;
    digest?: string | null;
    size?: number;
    browser_download_url?: string;
  }>;
}

function digestHex(digest: string | null | undefined): string | undefined {
  if (!digest) return undefined;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest.trim());
  return match?.[1]?.toLowerCase();
}

function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match) out.set(match[2]!, match[1]!.toLowerCase());
  }
  return out;
}

export function releaseDownloadUrl(tag: string, name: string): string {
  if (!TAG_NAME.test(tag) || !ASSET_NAME.test(name)) {
    throw new Error(`refusing release url for tag=${tag} name=${name}`);
  }
  return `https://github.com/${GENERAL_BLUEPRINT.owner}/${GENERAL_BLUEPRINT.repo}/releases/download/${tag}/${name}`;
}

export function assertDownloadUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`download host is not allowed: ${parsed.hostname}`);
  }
  return parsed;
}

export async function loadReleaseIndex(fetchImpl: typeof fetch = fetch): Promise<ReleaseAsset[]> {
  const endpoint = `https://api.github.com/repos/${GENERAL_BLUEPRINT.owner}/${GENERAL_BLUEPRINT.repo}/releases?per_page=20`;
  const response = await fetchImpl(endpoint, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`GitHub releases request failed: HTTP ${response.status}`);
  const releases = (await response.json()) as GitHubRelease[];
  const assets: ReleaseAsset[] = [];
  for (const release of releases) {
    const tag = release.tag_name ?? '';
    if (!TAG_NAME.test(tag)) continue;
    const sumsAsset = release.assets?.find((item) => item.name === 'SHA256SUMS.txt');
    let sums = new Map<string, string>();
    if (sumsAsset?.browser_download_url) {
      const sumsUrl = new URL(sumsAsset.browser_download_url);
      if (sumsUrl.protocol === 'https:' && sumsUrl.hostname === 'github.com') {
        const sumsResponse = await fetchImpl(sumsAsset.browser_download_url, {
          headers: { 'user-agent': USER_AGENT },
        });
        if (sumsResponse.ok) sums = parseSums(await sumsResponse.text());
      }
    }
    for (const item of release.assets ?? []) {
      const name = item.name ?? '';
      const parsed = parseAssetName(name);
      if (!parsed) continue;
      const fromDigest = digestHex(item.digest);
      const fromSums = sums.get(name);
      let sha256: string | undefined;
      let sha256From: ReleaseAsset['sha256From'];
      if (fromDigest && fromSums) {
        if (fromDigest !== fromSums) {
          throw new Error(`SHA-256 mismatch for ${tag}/${name}: GitHub digest ${fromDigest}, SHA256SUMS ${fromSums}`);
        }
        sha256 = fromDigest;
        sha256From = 'github-digest+sums';
      } else if (fromDigest) {
        sha256 = fromDigest;
        sha256From = 'github-digest';
      } else if (fromSums) {
        sha256 = fromSums;
        sha256From = 'publisher-sums';
      }
      assets.push({
        tag,
        name,
        ...parsed,
        ...(sha256 ? { sha256, sha256From } : {}),
        downloadUrl: releaseDownloadUrl(tag, name),
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
      });
    }
  }
  return assets;
}

export function sha256File(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
