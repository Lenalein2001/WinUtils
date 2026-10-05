using System;
using System.IO;
using System.Text;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

public static unsafe class HookExports
{
    private const string OwnerProperty = "WinUtils.AlwaysActive.Owner";
    private const uint RestoreMessage = 0x8066, QueryMessage = 0x8067, NcDestroy = 0x0082;
    private const nuint SubclassId = 0x57555449;
    [StructLayout(LayoutKind.Sequential)]
    private struct CwpStruct { public nint lParam, wParam; public uint message; public nint hwnd; }

    [UnmanagedCallersOnly(EntryPoint = "WinUtilsCallWndProc", CallConvs = new[] { typeof(CallConvStdcall) })]
    public static nint CallWndProc(int code, nint wParam, nint lParam)
    {
        if (code >= 0 && lParam != 0)
        {
            var message = (CwpStruct*)lParam;
            nint hwnd = message->hwnd;
            uint ownerPid = (uint)GetProp(hwnd, OwnerProperty);
            if (ownerPid != 0 && IsWindowVisible(hwnd) && GetAncestor(hwnd, 2) == hwnd
                && message->message != RestoreMessage && message->message != NcDestroy)
                ProtectWindow(hwnd, ownerPid);
        }
        return CallNextHookEx(0, code, wParam, lParam);
    }

    private static nint Procedure => (nint)(delegate* unmanaged[Stdcall]<nint, uint, nint, nint, nuint, nuint, nint>)&ProtectedWndProc;
    private static void ProtectWindow(nint hwnd, uint ownerPid)
    {
        if (!EnsureSubclassApi() || GetWindowSubclass(hwnd, Procedure, SubclassId, out _)) return;
        nint owner = OpenProcess(0x00100000 | 0x1000, false, ownerPid);
        if (owner == 0 || WaitForSingleObject(owner, 0) != 0x102)
        {
            if (owner != 0) CloseHandle(owner);
            return;
        }
        // A callback must remain mapped even if its worker crashes or the hook
        // is removed during a callback. The OS releases this pin at process exit.
        if (!GetModuleHandleEx(0x1 | 0x4, Procedure, out _) || !SetWindowSubclass(hwnd, Procedure, SubclassId, (nuint)owner))
            CloseHandle(owner);
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvStdcall) })]
    private static nint ProtectedWndProc(nint hwnd, uint message, nint wParam, nint lParam, nuint id, nuint data)
    {
        nint owner = (nint)data;
        bool owned = (uint)GetProp(hwnd, OwnerProperty) == GetProcessId(owner) && WaitForSingleObject(owner, 0) == 0x102;
        if (message == RestoreMessage || message == NcDestroy || !owned)
        {
            if (RemoveWindowSubclass(hwnd, Procedure, id))
            {
                if ((uint)GetProp(hwnd, OwnerProperty) == GetProcessId(owner)) RemoveProp(hwnd, OwnerProperty);
                CloseHandle(owner);
                if (message == RestoreMessage) return 1;
            }
            else if (message == RestoreMessage) return 0;
            return DefSubclassProc(hwnd, message, wParam, lParam);
        }
        if (message == QueryMessage) return 1;
        if (message == 0x001C && wParam == 0) return 0;
        if (message == 0x0006 && ((long)wParam & 0xffffL) == 0) return 0;
        if (message == 0x0008) { PostMessage(hwnd, 0x0007, 0, 0); return 0; }
        if (message == 0x0086 && wParam == 0) return 1;
        return DefSubclassProc(hwnd, message, wParam, lParam);
    }

    private static readonly object ApiLock = new();
    private static nint SetProc, GetProc, RemoveProc;
    private static volatile nint DefaultProc;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ActCtx {
        public int Size; public uint Flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string Source;
        public ushort Architecture, Language;
        public nint Directory, Resource, Application, Module;
    }
    private static bool EnsureSubclassApi() {
        if (DefaultProc != 0) return true;
        lock (ApiLock) {
            if (DefaultProc != 0) return true;
            if (!GetModuleHandleEx(0x1 | 0x4, Procedure, out var ownModule)) return false;
            var file = new StringBuilder(32768);
            if (GetModuleFileName(ownModule, file, file.Capacity) == 0) return false;
            var context = new ActCtx { Size = Marshal.SizeOf<ActCtx>(), Source = Path.ChangeExtension(file.ToString(), ".manifest") };
            nint activation = CreateActCtx(ref context);
            if (activation == -1) return false;
            try {
                if (!ActivateActCtx(activation, out var cookie)) return false;
                try {
                    // Bind comctl32 v6 explicitly. Legacy hosts such as Windows
                    // PowerShell may have loaded v5, which lacks named exports.
                    nint module = LoadLibrary("comctl32.dll");
                    if (module == 0) return false;
                    nint set = GetProcAddress(module, "SetWindowSubclass");
                    nint get = GetProcAddress(module, "GetWindowSubclass");
                    nint remove = GetProcAddress(module, "RemoveWindowSubclass");
                    nint def = GetProcAddress(module, "DefSubclassProc");
                    if (set == 0 || get == 0 || remove == 0 || def == 0) return false;
                    SetProc = set; GetProc = get; RemoveProc = remove; DefaultProc = def;
                    // Keep the dependency loaded for the lifetime of callbacks.
                    return true;
                } finally { DeactivateActCtx(0, cookie); }
            } finally { ReleaseActCtx(activation); }
        }
    }
    private static bool SetWindowSubclass(nint hwnd, nint proc, nuint id, nuint data) =>
        ((delegate* unmanaged[Stdcall]<nint,nint,nuint,nuint,int>)SetProc)(hwnd,proc,id,data) != 0;
    private static bool GetWindowSubclass(nint hwnd, nint proc, nuint id, out nuint data) {
        nuint value = 0;
        bool found = ((delegate* unmanaged[Stdcall]<nint,nint,nuint,nuint*,int>)GetProc)(hwnd,proc,id,&value) != 0;
        data = value; return found;
    }
    private static bool RemoveWindowSubclass(nint hwnd, nint proc, nuint id) =>
        ((delegate* unmanaged[Stdcall]<nint,nint,nuint,int>)RemoveProc)(hwnd,proc,id) != 0;
    private static nint DefSubclassProc(nint hwnd, uint message, nint wp, nint lp) =>
        ((delegate* unmanaged[Stdcall]<nint,uint,nint,nint,nint>)DefaultProc)(hwnd,message,wp,lp);
    [DllImport("kernel32.dll", EntryPoint="GetModuleFileNameW", CharSet=CharSet.Unicode)] private static extern uint GetModuleFileName(nint module, StringBuilder path, int size);
    [DllImport("kernel32.dll", EntryPoint="CreateActCtxW", CharSet=CharSet.Unicode)] private static extern nint CreateActCtx(ref ActCtx context);
    [DllImport("kernel32.dll")] private static extern bool ActivateActCtx(nint context, out nuint cookie);
    [DllImport("kernel32.dll")] private static extern bool DeactivateActCtx(uint flags, nuint cookie);
    [DllImport("kernel32.dll")] private static extern void ReleaseActCtx(nint context);
    [DllImport("kernel32.dll", EntryPoint="LoadLibraryW", CharSet=CharSet.Unicode)] private static extern nint LoadLibrary(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] private static extern nint GetProcAddress(nint module, string name);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook, int code, nint wParam, nint lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint GetProp(nint hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint RemoveProp(nint hwnd, string name);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint hwnd, uint flags);
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] private static extern bool PostMessage(nint hwnd, uint message, nint wParam, nint lParam);
    [DllImport("kernel32.dll", EntryPoint = "GetModuleHandleExW")] private static extern bool GetModuleHandleEx(uint flags, nint address, out nint module);
    [DllImport("kernel32.dll")] private static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll")] private static extern uint GetProcessId(nint handle);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(nint handle, uint milliseconds);
}
