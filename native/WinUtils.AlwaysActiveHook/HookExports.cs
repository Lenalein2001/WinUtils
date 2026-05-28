using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

public static unsafe class HookExports
{
    private const int HC_ACTION = 0;
    private const int GWLP_WNDPROC = -4;
    private const uint GA_ROOT = 2;
    private const uint WM_ACTIVATE = 0x0006;
    private const uint WM_SETFOCUS = 0x0007;
    private const uint WM_KILLFOCUS = 0x0008;
    private const uint WM_NCDESTROY = 0x0082;
    private const uint WM_NCACTIVATE = 0x0086;
    private const uint WM_ACTIVATEAPP = 0x001C;
    private const uint WINUTILS_RESTORE_MESSAGE = 0x8066;
    private const int WA_INACTIVE = 0;
    private const int MaxProtectedWindows = 64;

    private static readonly nint[] ProtectedWindows = new nint[MaxProtectedWindows];
    private static readonly nint[] OriginalWindowProcedures = new nint[MaxProtectedWindows];

    [StructLayout(LayoutKind.Sequential)]
    private struct CwpStruct
    {
        public nint lParam;
        public nint wParam;
        public uint message;
        public nint hwnd;
    }

    [UnmanagedCallersOnly(EntryPoint = "WinUtilsCallWndProc", CallConvs = new[] { typeof(CallConvStdcall) })]
    public static nint CallWndProc(int code, nint wParam, nint lParam)
    {
        if (code >= HC_ACTION && lParam != 0)
        {
            CwpStruct* message = (CwpStruct*)lParam;
            if (ShouldProtectWindow(message->hwnd))
            {
                ProtectWindow(message->hwnd);
            }
        }

        return CallNextHookEx(0, code, wParam, lParam);
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvStdcall) })]
    private static nint ProtectedWndProc(nint hwnd, uint message, nint wParam, nint lParam)
    {
        int slot = FindProtectedWindow(hwnd);
        nint originalProcedure = slot >= 0 ? OriginalWindowProcedures[slot] : 0;

        if (message == WINUTILS_RESTORE_MESSAGE || message == WM_NCDESTROY)
        {
            RestoreWindow(hwnd, slot, originalProcedure);
            if (message == WINUTILS_RESTORE_MESSAGE)
            {
                return 0;
            }
        }

        if (message == WM_ACTIVATEAPP && wParam == 0)
        {
            return 0;
        }

        if (message == WM_ACTIVATE && ((long)wParam & 0xffffL) == WA_INACTIVE)
        {
            return 0;
        }

        if (message == WM_KILLFOCUS)
        {
            PostMessage(hwnd, WM_SETFOCUS, 0, 0);
            return 0;
        }

        if (message == WM_NCACTIVATE && wParam == 0)
        {
            return 1;
        }

        return originalProcedure != 0
            ? CallWindowProc(originalProcedure, hwnd, message, wParam, lParam)
            : DefWindowProc(hwnd, message, wParam, lParam);
    }

    private static bool ShouldProtectWindow(nint hwnd)
    {
        return hwnd != 0
            && IsWindow(hwnd)
            && IsWindowVisible(hwnd)
            && GetAncestor(hwnd, GA_ROOT) == hwnd;
    }

    private static void ProtectWindow(nint hwnd)
    {
        if (FindProtectedWindow(hwnd) >= 0)
        {
            return;
        }

        int slot = FindFreeSlot();
        if (slot < 0)
        {
            return;
        }

        nint newProcedure = (nint)(delegate* unmanaged[Stdcall]<nint, uint, nint, nint, nint>)&ProtectedWndProc;
        nint originalProcedure = SetWindowLongPtr(hwnd, GWLP_WNDPROC, newProcedure);
        if (originalProcedure == 0 || originalProcedure == newProcedure)
        {
            return;
        }

        ProtectedWindows[slot] = hwnd;
        OriginalWindowProcedures[slot] = originalProcedure;
    }

    private static void RestoreWindow(nint hwnd, int slot, nint originalProcedure)
    {
        if (slot < 0 || originalProcedure == 0)
        {
            return;
        }

        SetWindowLongPtr(hwnd, GWLP_WNDPROC, originalProcedure);
        ProtectedWindows[slot] = 0;
        OriginalWindowProcedures[slot] = 0;
    }

    private static int FindProtectedWindow(nint hwnd)
    {
        for (int index = 0; index < ProtectedWindows.Length; index++)
        {
            if (ProtectedWindows[index] == hwnd)
            {
                return index;
            }
        }

        return -1;
    }

    private static int FindFreeSlot()
    {
        for (int index = 0; index < ProtectedWindows.Length; index++)
        {
            if (ProtectedWindows[index] == 0)
            {
                return index;
            }
        }

        return -1;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint CallNextHookEx(nint hookHandle, int code, nint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern nint SetWindowLongPtr(nint hwnd, int index, nint newLong);

    [DllImport("user32.dll", EntryPoint = "CallWindowProcW", SetLastError = true)]
    private static extern nint CallWindowProc(nint previousWndFunc, nint hwnd, uint message, nint wParam, nint lParam);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW", SetLastError = true)]
    private static extern nint DefWindowProc(nint hwnd, uint message, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindow(nint hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsWindowVisible(nint hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint GetAncestor(nint hwnd, uint flags);

    [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
    private static extern bool PostMessage(nint hwnd, uint message, nint wParam, nint lParam);
}
