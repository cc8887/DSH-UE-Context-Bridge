Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class R2 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@

$p = Get-Process UnrealEditor -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output "NO_EDITOR"; exit 1 }

[void][R2]::ShowWindow($p.MainWindowHandle, 3)
Start-Sleep -Milliseconds 800
[void][R2]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 800

$r = New-Object R2+RECT
[void][R2]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L
$ht = $r.B - $r.T
Write-Output ("rect=" + $w + "x" + $ht)

# CopyFromScreen reads the composited desktop, which unlike PrintWindow does
# include the D3D viewport.
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$repo = Split-Path -Parent $PSScriptRoot
$bmp.Save((Join-Path $repo "pie_hello.png"))
$g.Dispose()
$bmp.Dispose()
Write-Output "saved"
