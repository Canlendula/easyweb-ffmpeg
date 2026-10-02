import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// A background helper can leave an Explorer window hidden even when the Shell API succeeds.
// Find the exact folder through Shell.Windows, explicitly show it, and verify its final state.
const WINDOWS_REVEAL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FrameExplorer {
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr reserved, uint flags);
  [DllImport("ole32.dll")] static extern void CoUninitialize();
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHParseDisplayName(string name, IntPtr bind, out IntPtr pidl, uint attributes, out uint result);
  [DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr items, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static void ShowAndActivate(IntPtr window) {
    ShowWindow(window, IsIconic(window) ? 9 : 5);
    // SWP_SHOWWINDOW explicitly sets visibility without moving or resizing an existing window.
    if (!SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    BringWindowToTop(window);
    SetForegroundWindow(window);
  }
  public static void OpenPath(string file) {
    int initialized = CoInitializeEx(IntPtr.Zero, 2);
    IntPtr pidl = IntPtr.Zero;
    try {
      uint attributes;
      Marshal.ThrowExceptionForHR(SHParseDisplayName(file, IntPtr.Zero, out pidl, 0, out attributes));
      Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0));
    } finally {
      if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
      if (initialized >= 0) CoUninitialize();
    }
  }
}
'@
  $file = [System.IO.Path]::GetFullPath($env:FRAME_REVEAL_PATH)
  $folder = [System.IO.Path]::GetDirectoryName($file)
  $leaf = [System.IO.Path]::GetFileName($file)
  $shell = New-Object -ComObject Shell.Application
  function Find-TargetWindow {
    foreach ($candidate in @($shell.Windows())) {
      try {
        $location = [string]$candidate.Document.Folder.Self.Path
        if ([string]::Equals($location.TrimEnd('\'), $folder.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return $candidate }
      } catch { }
    }
    return $null
  }
  $window = Find-TargetWindow
  $reused = $null -ne $window
  if ($null -eq $window) {
    [FrameExplorer]::OpenPath($file)
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      $window = Find-TargetWindow
      if ($null -ne $window) { break }
      Start-Sleep -Milliseconds 100
    }
  }
  if ($null -eq $window) { throw 'Explorer did not expose the requested folder window.' }
  $handle = [IntPtr]([long]$window.HWND)
  $window.Visible = $true
  $item = $window.Document.Folder.ParseName($leaf)
  if ($null -ne $item) { $window.Document.SelectItem($item, 29) }
  [FrameExplorer]::ShowAndActivate($handle)
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if ([FrameExplorer]::IsWindowVisible($handle) -and -not [FrameExplorer]::IsIconic($handle)) { break }
    Start-Sleep -Milliseconds 50
  }
  $location = [string]$window.Document.Folder.Self.Path
  $matched = [string]::Equals($location.TrimEnd('\'), $folder.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
  $selected = $false
  foreach ($entry in @($window.Document.SelectedItems())) {
    if ([string]::Equals([string]$entry.Path, $file, [StringComparison]::OrdinalIgnoreCase)) { $selected = $true }
  }
  $result = [ordered]@{
    folderMatched = $matched
    visible = [FrameExplorer]::IsWindowVisible($handle)
    minimized = [FrameExplorer]::IsIconic($handle)
    foreground = [FrameExplorer]::GetForegroundWindow() -eq $handle
    selected = $selected
    reused = $reused
    windowHandle = $handle.ToInt64()
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export function revealCommand(file, platform = process.platform, environment = process.env) {
  if (platform === 'win32') return {
    command: path.win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_REVEAL, 'utf16le').toString('base64')],
    options: { windowsHide: true, shell: false, env: { ...environment, FRAME_REVEAL_PATH: file } },
  };
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: platform === 'darwin' ? ['-R', file] : [path.dirname(file)], options: { shell: false } };
}

export async function revealFile(file, { platform = process.platform, spawnProcess = spawn } = {}) {
  await fs.access(file);
  const plan = revealCommand(file, platform);
  const output = await new Promise((resolve, reject) => {
    const child = spawnProcess(plan.command, plan.args, { ...plan.options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('打开文件位置超时，请重试')); }, 15000);
    child.stdout.on('data', data => { stdout = (stdout + data.toString('utf8')).slice(-8000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`无法打开文件位置：${error.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`无法打开文件位置：${stderr.trim() || `系统返回 ${code}`}`)); });
  });
  if (platform !== 'win32') return { ok: true, verified: false, path: file };
  let result;
  try { result = JSON.parse(output.trim()); } catch { throw new Error('Windows 未返回文件夹窗口的显示状态，请重试'); }
  if (result.folderMatched !== true || result.visible !== true || result.minimized !== false || !(Number.isSafeInteger(result.windowHandle) && result.windowHandle > 0)) {
    throw new Error('文件夹窗口未成功显示。请重试，或复制路径后在资源管理器中打开。');
  }
  return { ok: true, verified: true, path: file, foreground: result.foreground === true, selected: result.selected === true, reused: result.reused === true, windowHandle: result.windowHandle };
}
