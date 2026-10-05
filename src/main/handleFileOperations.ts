import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SerialTaskQueue } from './atomicFile';
import type { SyncRootIdentity } from './fileSyncSafety';

export interface HandleGuard {
  device: string;
  fileId: string;
  modifiedNs?: string;
  sha256?: string;
  emptyDirectory?: boolean;
}
export interface HandleRootGuard extends SyncRootIdentity { path: string }

// PowerShell hosts an ordinary-permission, demand-started helper. All filesystem
// work happens off the main thread. Directory handles refuse rename/delete while
// the source and destination are checked and changed.
export const HANDLE_FILE_OPERATIONS_CSHARP = String.raw`
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class HandleFiles {
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateDirectory(string path,IntPtr security);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr value,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileTime(SafeFileHandle handle,ref System.Runtime.InteropServices.ComTypes.FILETIME created,IntPtr accessed,ref System.Runtime.InteropServices.ComTypes.FILETIME written);
  static Exception Failure() { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static Info Read(SafeFileHandle handle) { Info info;if(!GetFileInformationByHandle(handle,out info))throw Failure();return info; }
  static string Id(Info info) { return (((ulong)info.IndexHigh<<32)|info.IndexLow).ToString(); }
  static SafeFileHandle Open(string file,uint access,uint share,uint creation,bool directory) {
    var handle=CreateFile(file,access,share,IntPtr.Zero,creation,0x00200000u|(directory?0x02000000u:0u),IntPtr.Zero);
    if(handle.IsInvalid) { handle.Dispose();throw Failure(); }
    try { var info=Read(handle);if((info.Attributes&0x400)!=0 || ((info.Attributes&0x10)!=0)!=directory)throw new IOException("Reparse point or unexpected filesystem object blocks this operation."); }
    catch { handle.Dispose();throw; }
    return handle;
  }
  static string Full(string value) {
    if(String.IsNullOrEmpty(value) || value.Length>32760 || value.IndexOf('\0')>=0)throw new IOException("Invalid filesystem path.");
    string result=Path.GetFullPath(value),root=Path.GetPathRoot(result);
    if(result.Substring(root.Length).IndexOf(':')>=0)throw new IOException("Alternate data streams are not supported.");
    return result;
  }
  static void Parents(string file,Dictionary<string,SafeFileHandle> pins) {
    string parent=Path.GetDirectoryName(file),root=Path.GetPathRoot(parent),current=root;
    if(!pins.ContainsKey(current))pins.Add(current,Open(current,0x80,3,3,true));
    foreach(string segment in parent.Substring(root.Length).Split(Path.DirectorySeparatorChar)) {
      if(segment.Length==0)continue;
      current=Path.Combine(current,segment);
      if(!pins.ContainsKey(current))pins.Add(current,Open(current,0x80,3,3,true));
    }
  }
  static void Roots(Dictionary<string,SafeFileHandle> pins,string[] roots) {
    foreach(string encoded in roots) {
      string[] values=encoded.Split('|');SafeFileHandle handle;
      if(values.Length!=3 || !pins.TryGetValue(Full(values[0]).TrimEnd((char)92),out handle)) {
        // Drive/share roots include the final separator in the pin table.
        if(values.Length!=3 || !pins.TryGetValue(Full(values[0]),out handle))throw new IOException("Required filesystem root is not pinned.");
      }
      Info info=Read(handle);
      if(info.Volume.ToString()!=values[1] || Id(info)!=values[2])throw new IOException("Filesystem root changed since Analyze; re-analyze before continuing.");
    }
  }
  static void Guard(Info info,string device,string id,string modified) {
    if(info.Volume.ToString()!=device || Id(info)!=id)throw new IOException("File changed identity; original retained.");
    if(!String.IsNullOrEmpty(modified)) {
      ulong ticks=((ulong)(uint)info.Written.dwHighDateTime<<32)|(uint)info.Written.dwLowDateTime;
      decimal ns=((decimal)ticks-116444736000000000m)*100m;
      if(ns.ToString(System.Globalization.CultureInfo.InvariantCulture)!=modified)throw new IOException("File changed since Analyze; original retained.");
    }
  }
  static void Rename(SafeFileHandle source,string target,SafeFileHandle parent) {
    byte[] name=System.Text.Encoding.Unicode.GetBytes(target+'\0');
    int offset=IntPtr.Size==8?20:12,rootOffset=IntPtr.Size==8?8:4,lengthOffset=IntPtr.Size==8?16:8;
    IntPtr buffer=Marshal.AllocHGlobal(offset+name.Length);
    try {
      for(int i=0;i<offset;i++)Marshal.WriteByte(buffer,i,0);
      Marshal.WriteIntPtr(buffer,rootOffset,IntPtr.Zero);Marshal.WriteInt32(buffer,lengthOffset,name.Length-2);
      Marshal.Copy(name,0,IntPtr.Add(buffer,offset),name.Length);
      if(!SetFileInformationByHandle(source,3,buffer,(uint)(offset+name.Length)))throw Failure();
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static void Delete(SafeFileHandle source) {
    IntPtr buffer=Marshal.AllocHGlobal(4);
    try { Marshal.WriteInt32(buffer,1);if(!SetFileInformationByHandle(source,4,buffer,4))throw Failure(); }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  static byte[] Hash(Stream stream) { stream.Position=0;using(var hash=SHA256.Create())return hash.ComputeHash(stream); }
  static bool Same(byte[] a,byte[] b) { if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true; }
  public static void Execute(string action,string source,string target,string device,string id,string modified,string[] roots,string checksum,bool emptyDirectory) {
    if(action!="move" && action!="delete")throw new IOException("Unsupported filesystem operation.");
    source=Full(source);if(action=="move")target=Full(target);
    var pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    try {
      Parents(source,pins);if(action=="move")Parents(target,pins);Roots(pins,roots);
      var attributes=File.GetAttributes(source);bool directory=(attributes&FileAttributes.Directory)!=0;
      using(var handle=Open(source,0x80010000u,1,3,directory)) {
        Info original=Read(handle);Guard(original,device,id,modified);
        if(!String.IsNullOrEmpty(checksum)) {
          if(directory)throw new IOException("Cannot verify a directory checksum.");
          using(var borrowed=new SafeFileHandle(handle.DangerousGetHandle(),false))
          using(var contents=new FileStream(borrowed,FileAccess.Read)) {
            string actual=BitConverter.ToString(Hash(contents)).Replace("-","").ToLowerInvariant();
            if(actual!=checksum)throw new IOException("Staged file changed after verification; original retained.");
          }
        }
        if(action=="delete") { Delete(handle);return; } // Windows refuses non-empty directories.
        if(directory && emptyDirectory) {
          if(Directory.GetFileSystemEntries(source).Length!=0)throw new IOException("Folder is no longer empty; original retained.");
          if(!CreateDirectory(target,IntPtr.Zero))throw Failure(); // Exclusive, including across volumes.
          using(var destination=Open(target,0x80,1,3,true)) { Delete(handle); }
          return;
        }
        Info targetParent=Read(pins[Path.GetDirectoryName(target)]);
        if(original.Volume==targetParent.Volume) { Rename(handle,target,pins[Path.GetDirectoryName(target)]);return; }
        if(directory)throw new IOException("Cross-volume directory moves require an explicit recovery workflow; original retained.");
        string temporary=Path.Combine(Path.GetDirectoryName(target),".winutils-handle-"+Guid.NewGuid().ToString("N")+".tmp");
        using(var copied=Open(temporary,0xC0010000u,1,1,false)) {
          bool published=false;
          try {
            using(var input=new FileStream(new SafeFileHandle(handle.DangerousGetHandle(),false),FileAccess.Read))
            using(var output=new FileStream(new SafeFileHandle(copied.DangerousGetHandle(),false),FileAccess.ReadWrite)) {
              input.Position=0;input.CopyTo(output,65536);output.Flush(true);
              if(!Same(Hash(input),Hash(output)))throw new IOException("Copy verification failed; source retained.");
              if(!SetFileTime(copied,ref original.Created,IntPtr.Zero,ref original.Written))throw Failure();
              Rename(copied,target,pins[Path.GetDirectoryName(target)]);published=true;
              Delete(handle);
            }
          } catch {
            if(!published && !copied.IsClosed) { try { Delete(copied); } catch {} }
            throw;
          }
        }
      }
    } finally { foreach(var handle in pins.Values)handle.Dispose(); }
  }
}
`;

const SCRIPT = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
${HANDLE_FILE_OPERATIONS_CSHARP}
'@
[Console]::Out.WriteLine('READY');[Console]::Out.Flush()
while ($null -ne ($line=[Console]::In.ReadLine())) {
  try {
    $request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    [HandleFiles]::Execute($request.action,$request.source,$request.target,$request.device,$request.fileId,$request.modifiedNs,[string[]]@($request.roots),$request.sha256,[bool]$request.emptyDirectory)
    [Console]::Out.WriteLine('OK')
  } catch { [Console]::Out.WriteLine('ERROR:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))) }
  [Console]::Out.Flush()
}`;
const operations = new SerialTaskQueue();
let worker: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let reply: ((line: string) => void) | null = null;
let failReply: ((error: Error) => void) | null = null;
const cleanupTasks = new Set<Promise<unknown>>();

async function start(): Promise<void> {
  if (worker && !worker.killed) return;
  if (starting) return starting;
  starting = (async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'winutils-files-'));
    const file = path.join(directory, 'worker.ps1');
    try { await writeFile(file, SCRIPT, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { await rmdir(directory).catch(() => undefined); throw error; }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
    worker = child;
    let buffer = '', stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 16384) { child.kill(); failReply?.(new Error('Filesystem helper exceeded its response budget.')); return; }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const line of lines) reply?.(line);
    });
    child.on('error', error => { if (worker === child) failReply?.(error); });
    child.on('close', () => {
      if (worker === child) { worker = null; failReply?.(new Error(`Filesystem helper exited. Recovery copies were retained. ${stderr}`)); }
      const cleanup = unlink(file).then(() => rmdir(directory)).catch(() => undefined);
      cleanupTasks.add(cleanup); void cleanup.finally(() => cleanupTasks.delete(cleanup));
    });
    await response(undefined, 15000);
  })().finally(() => { starting = null; });
  return starting;
}

function response(payload: object | undefined, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker?.kill(); finish(new Error('Filesystem operation timed out. Inspect recovery copies before retrying.')); }, timeout);
    const finish = (error?: Error): void => { clearTimeout(timer); reply = null; failReply = null; error ? reject(error) : resolve(); };
    reply = line => {
      if (line === (payload ? 'OK' : 'READY')) finish();
      else if (line.startsWith('ERROR:')) finish(new Error(Buffer.from(line.slice(6), 'base64').toString('utf8')));
      else finish(new Error('Invalid filesystem helper response.'));
    };
    failReply = error => finish(error);
    if (payload) worker!.stdin.write(`${Buffer.from(JSON.stringify(payload)).toString('base64')}\n`, error => { if (error) finish(error); });
  });
}

export async function handleFileOperation(action: 'move' | 'delete', source: string, target = '', guard?: HandleGuard, roots: HandleRootGuard[] = []): Promise<boolean> {
  // Node regression fixtures exercise injectable path-operation failures. Windows
  // Electron always uses handles; helper failure never falls back to path mutation.
  if (process.platform !== 'win32' || !process.versions.electron) return false;
  return operations.run(async () => {
    if (idle) clearTimeout(idle);
    const info = guard ?? await lstat(source, { bigint: true }).then(info => ({ device: String(info.dev), fileId: String(info.ino), modifiedNs: info.isFile() ? String(info.mtimeNs) : undefined }));
    await start();
    try {
      await response({ action, source: path.resolve(source), target: target ? path.resolve(target) : '', ...info,
        roots: roots.map(root => `${root.path}|${root.device}|${root.fileId}`) }, 20 * 60 * 1000);
      return true;
    } finally {
      const current = worker;
      idle = setTimeout(() => { if (worker === current) { worker = null; current?.stdin.end(); } }, 5000);
    }
  });
}

export async function stopHandleFileOperations(): Promise<void> {
  await operations.drain();
  if (idle) clearTimeout(idle);
  const current = worker; worker = null;
  if (current && current.exitCode === null) await new Promise<void>(resolve => {
    const timer = setTimeout(() => { current.kill(); resolve(); }, 5000);
    current.once('close', () => { clearTimeout(timer); resolve(); });
    current.stdin.end();
  });
  await Promise.allSettled([...cleanupTasks]);
}
