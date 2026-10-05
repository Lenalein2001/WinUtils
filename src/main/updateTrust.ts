import { execFile } from 'node:child_process';

/** Windows validates the Authenticode chain; only its verified subject is trusted. */
export async function verifiedPublisher(file: string): Promise<string | null> {
  const quoted = `'${file.replace(/'/g, "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath ${quoted}; if ($signature.Status -eq 'Valid' -and $signature.SignerCertificate) { $signature.SignerCertificate.Subject }`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 15000, windowsHide: true, encoding: 'utf8', maxBuffer: 16384 },
      (error, output) => error ? reject(error) : resolve(output.trim() || null));
  });
}
