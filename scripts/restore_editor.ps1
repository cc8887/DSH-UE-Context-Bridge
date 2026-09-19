Add-Type @"
using System;
using System.Runtime.InteropServices;
public class R {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

$p = Get-Process UnrealEditor -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output "NO_EDITOR"; exit 1 }

# 3 = maximize, 9 = restore. Maximize first so it cannot be minimized.
[void][R]::ShowWindow($p.MainWindowHandle, 3)
Start-Sleep -Milliseconds 1500
[void][R]::ShowWindow($p.MainWindowHandle, 9)
Start-Sleep -Milliseconds 1500
[void][R]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 1000
Write-Output ("restored pid=" + $p.Id + " handle=" + $p.MainWindowHandle)
