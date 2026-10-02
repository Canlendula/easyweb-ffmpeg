import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = path.join(ROOT, '.data', 'native-bridge');
const EXE = path.join(FOLDER, 'FrameReveal.exe');
const CONFIG = path.join(FOLDER, 'config.json');
const mode = process.argv[2] || 'build';
if (process.platform !== 'win32') throw new Error('本机唤起器仅用于 Windows');
if (!['build', 'install', 'uninstall'].includes(mode)) throw new Error('用法：node scripts/native-bridge.mjs build|install|uninstall');
const run = (exe, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { windowsHide: true, shell: false, ...options }); let out = '', err = '';
  child.stdout.on('data', d => { out += d.toString('utf8'); }); child.stderr.on('data', d => { err += d.toString('utf8'); });
  child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || out || `Exit ${code}`)));
});
const registryScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$key='HKCU:\Software\Classes\frame-local-reveal'
$expected='"'+$env:FRAME_HELPER_PATH+'" "%1"'
$existing=(Get-ItemProperty -LiteralPath ($key+'\shell\open\command') -ErrorAction SilentlyContinue).'(default)'
if ($existing -and $existing -ne $expected) { throw '该协议已由其他程序注册，未修改现有设置。' }
if ($env:FRAME_HELPER_MODE -eq 'uninstall') {
  if ($existing -eq $expected) { Remove-Item -LiteralPath $key -Recurse }
} else {
  if ((Test-Path -LiteralPath $key) -and !$existing) { throw '该协议键已存在但来源不明，未覆盖。' }
  New-Item -Path ($key+'\shell\open\command') -Force | Out-Null
  Set-Item -LiteralPath $key -Value 'URL:Frame 文件夹助手'
  New-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  Set-Item -LiteralPath ($key+'\shell\open\command') -Value $expected
}
`;
await fs.mkdir(FOLDER, { recursive: true });
let config;
try { config = JSON.parse(await fs.readFile(CONFIG, 'utf8')); } catch { config = { port: Number(process.env.PORT || 3210), secret: randomBytes(32).toString('hex'), installed: false }; }
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.secret)) throw new Error('本地助手配置无效');
if (mode !== 'uninstall') {
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const compiler = path.join(framework, 'csc.exe');
  const references = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'Microsoft.CSharp.dll'].map(r => `/reference:${path.join(framework, r)}`);
  const source = path.join(ROOT, 'native', 'FrameReveal.cs'), next = path.join(FOLDER, 'FrameReveal.next.exe');
  await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/out:${next}`, ...references, source]);
  const tests = path.join(FOLDER, 'FrameReveal.Tests.exe');
  await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:FrameRevealTests', `/out:${tests}`, ...references, source, path.join(ROOT, 'native', 'FrameRevealTests.cs')]);
  process.stdout.write(await run(tests, []));
  await fs.rename(next, EXE);
  await fs.writeFile(CONFIG, JSON.stringify(config, null, 2));
  console.log('本机助手已编译并通过参数校验测试。');
}
if (mode !== 'build') {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(registryScript, 'utf16le').toString('base64')], { env: { ...process.env, FRAME_HELPER_PATH: EXE, FRAME_HELPER_MODE: mode } });
  config.installed = mode === 'install'; await fs.writeFile(CONFIG, JSON.stringify(config, null, 2));
  console.log(mode === 'install' ? '已为当前用户注册 Frame 文件夹助手。重启工作台后生效。' : '已移除当前用户的 Frame 协议注册。重启工作台后使用兼容方式。');
}
