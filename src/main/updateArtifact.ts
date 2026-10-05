import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';

export interface VerifiedInstaller {
  path: string;
  version: string;
  size: number;
  sha256: string;
}

const RELEASES = 'https://api.github.com/repos/Lenalein2001/WinUtils/releases/tags/';
const DOWNLOADS = 'https://github.com/Lenalein2001/WinUtils/releases/download/';

/** Bind the installer to the exact asset published in the application's repository. */
export async function verifyReleaseInstaller(file: string, version: string, signal?: AbortSignal): Promise<VerifiedInstaller> {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.length > 40) throw new Error('Invalid update version.');
  const tag = `v${version}`;
  const response = await fetch(`${RELEASES}${tag}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WinUtils' },
  });
  if (!response.ok) throw new Error(`Installer verification failed with HTTP ${response.status}. Retry the download.`);
  const release = await response.json() as {
    tag_name?: string; draft?: boolean; prerelease?: boolean;
    assets?: Array<{ name?: string; size?: number; digest?: string; browser_download_url?: string }>;
  };
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('Update does not match a published stable WinUtils release.');
  }
  const name = `WinUtils-${version}-setup.exe`;
  const assets = release.assets.filter(asset => asset.name === name);
  const asset = assets[0];
  if (assets.length !== 1 || asset?.browser_download_url !== `${DOWNLOADS}${tag}/${name}`
    || !Number.isSafeInteger(asset.size) || asset.size! <= 0 || asset.size! > 1_073_741_824
    || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
    throw new Error('GitHub did not provide a trusted installer digest. Use the release page or retry later.');
  }
  const verified = { path: file, version, size: asset.size!, sha256: asset.digest!.slice(7) };
  await verifyInstallerBytes(verified, signal);
  return verified;
}

/** Check again immediately before installation; a cached download may have changed. */
export async function verifyInstallerBytes(installer: VerifiedInstaller, signal?: AbortSignal): Promise<void> {
  const before = await lstat(installer.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(installer.size)) {
    throw new Error('Downloaded installer size or file type changed. Download it again.');
  }
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(installer.path, { signal })) digest.update(bytes);
  const after = await lstat(installer.path, { bigint: true });
  if (digest.digest('hex') !== installer.sha256 || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
    throw new Error('Downloaded installer does not match the published GitHub asset. Download it again.');
  }
}
