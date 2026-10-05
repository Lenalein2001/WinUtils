import { execFile } from 'node:child_process';
import { quoteWindowsArgument } from './windowsArguments';
import { STARTUP_FILE_MOVER_CSHARP } from './startupFileBroker';
import path from 'node:path';
import { app } from 'electron';

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A UAC helper performs one allowlisted startup mutation, then exits. */
export async function elevatedStartupRegistry(args: string[]): Promise<void> {
  const [verb, key] = args;
  if (!['add', 'delete'].includes(verb) || !/^HKLM\\Software\\(?:WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\Run$/i.test(key)
    || args.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 16384)
    || (verb === 'delete' ? args.length !== 5 || args[2] !== '/v' || args[4] !== '/f'
      : args.length !== 9 || args[2] !== '/v' || args[4] !== '/t' || !['REG_SZ', 'REG_EXPAND_SZ'].includes(args[5]) || args[6] !== '/d' || args[8] !== '/f')) {
    throw new Error('Administrator helper only accepts machine-wide startup registry values.');
  }
  const argumentsText = args.map(quoteWindowsArgument).join(' ');
  await runElevatedStartupScript(`$ErrorActionPreference='Stop'; $info=New-Object System.Diagnostics.ProcessStartInfo; $info.FileName=Join-Path $env:SystemRoot 'System32\\reg.exe'; $info.Arguments=${quote(argumentsText)}; $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $process=[System.Diagnostics.Process]::Start($info); if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Startup registry operation timed out.' }; exit $process.ExitCode`);
}

export async function elevatedStartupFileMove(source: string, target: string): Promise<void> {
  const cacheRoot = path.join(app.getPath('userData'), 'startup-manager', 'disabled-startup-items');
  const commonRoot = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const parents = [path.dirname(path.resolve(source)), path.dirname(path.resolve(target))].map(value => value.toLowerCase());
  if (!parents.includes(cacheRoot.toLowerCase()) || !parents.includes(commonRoot.toLowerCase())) throw new Error('Invalid privileged startup file operation.');
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${STARTUP_FILE_MOVER_CSHARP}\n'@; [StartupFileMover]::Move(${quote(source)},${quote(target)},${quote(commonRoot)},${quote(cacheRoot)})`;
  await runElevatedStartupScript(script);
}

export async function runElevatedStartupScript(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > 24000) throw new Error('Startup operation exceeds the administrator helper size limit.');
  const launcher = `$ErrorActionPreference='Stop'; $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode`;
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher],
      { timeout: 120000, windowsHide: true, encoding: 'utf8', maxBuffer: 16384 },
      error => error ? reject(new Error('Windows did not complete the startup operation. Permission may have been cancelled; recovery records were retained.')) : resolve());
  });
}
