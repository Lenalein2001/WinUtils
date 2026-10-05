// Shared with isolated worker tests. Windows handles pin directories and files
// throughout copy/verification/deletion, refusing junctions and collisions.
export const STARTUP_FILE_MOVER_CSHARP = String.raw`
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class StartupFileMover {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref int value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileTime(SafeFileHandle handle, ref System.Runtime.InteropServices.ComTypes.FILETIME created, IntPtr accessed, ref System.Runtime.InteropServices.ComTypes.FILETIME written);
  static Exception Failure() { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static SafeFileHandle Open(string path, uint access, uint share, uint creation, uint flags, bool directory) {
    var handle=CreateFile(path,access,share,IntPtr.Zero,creation,flags | 0x00200000,IntPtr.Zero);
    if (handle.IsInvalid) { handle.Dispose(); throw Failure(); }
    Info info;
    if (!GetFileInformationByHandle(handle,out info)) { handle.Dispose(); throw Failure(); }
    if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory) { handle.Dispose(); throw new IOException("Startup helper refuses reparse points or unexpected item types."); }
    return handle;
  }
  static void PinParents(string path,List<SafeFileHandle> pinned) {
    string parent=Path.GetDirectoryName(Path.GetFullPath(path)), root=Path.GetPathRoot(parent);
    if (root.Length != 3) throw new IOException("Startup helper requires a local Windows drive.");
    pinned.Add(Open(root,0x80,3,3,0x02000000,true));
    string current=root;
    foreach (string segment in parent.Substring(root.Length).Split(Path.DirectorySeparatorChar)) {
      if (segment.Length == 0) continue;
      current=Path.Combine(current,segment); pinned.Add(Open(current,0x80,3,3,0x02000000,true));
    }
  }
  static byte[] Hash(Stream stream) { stream.Position=0; using(var hash=SHA256.Create()) return hash.ComputeHash(stream); }
  static bool Same(byte[] a,byte[] b) { if(a.Length!=b.Length)return false;for(int i=0;i<a.Length;i++)if(a[i]!=b[i])return false;return true; }
  public static void Move(string source,string target,string commonRoot,string cacheRoot) {
    source=Path.GetFullPath(source);target=Path.GetFullPath(target);
    string sourceParent=Path.GetDirectoryName(source),targetParent=Path.GetDirectoryName(target);
    if (!(String.Equals(sourceParent,commonRoot,StringComparison.OrdinalIgnoreCase) && String.Equals(targetParent,cacheRoot,StringComparison.OrdinalIgnoreCase))
      && !(String.Equals(sourceParent,cacheRoot,StringComparison.OrdinalIgnoreCase) && String.Equals(targetParent,commonRoot,StringComparison.OrdinalIgnoreCase)))
      throw new IOException("Startup helper only moves files between Common Startup and the restore cache.");
    var pinned=new List<SafeFileHandle>();
    try {
      PinParents(source,pinned);PinParents(target,pinned);
      using(var sourceHandle=Open(source,0x80010000,1,3,0,false))
      using(var input=new FileStream(sourceHandle,FileAccess.Read)) {
        if(input.Length>268435456)throw new IOException("Startup file exceeds the 256 MiB operation budget.");
        bool existing=File.Exists(target);
        using(var targetHandle=Open(target,existing?0x80000000:0xC0010000,1,existing?3u:1u,0,false))
        using(var output=new FileStream(targetHandle,existing?FileAccess.Read:FileAccess.ReadWrite)) {
          if(!existing) { input.CopyTo(output,65536);output.Flush(true); }
          if(!Same(Hash(input),Hash(output))) {
            if(!existing) { int remove=1;SetFileInformationByHandle(targetHandle,4,ref remove,4); }
            throw new IOException("Startup copy verification failed; original retained.");
          }
          if(!existing) {
            Info original;
            if(!GetFileInformationByHandle(sourceHandle,out original) || !SetFileTime(targetHandle,ref original.Created,IntPtr.Zero,ref original.Written))throw Failure();
          }
          int delete=1;
          if(!SetFileInformationByHandle(sourceHandle,4,ref delete,4))throw Failure();
        }
      }
    } finally { for(int i=pinned.Count-1;i>=0;i--)pinned[i].Dispose(); }
  }
}
`;
