<#
.SYNOPSIS
  让 Windows 时间同步（NTP）绕开代理虚拟网卡，防止系统时钟跳变。

.DESCRIPTION
  背景：机器上装了 Clash/Mihomo 之类的代理软件时，会创建一块 TUN 虚拟网卡
  （网段 198.18.0.0/15）。若 NTP 客户端把代理的 fake-ip（如 198.18.1.35）
  当成了时间服务器地址，时间同步就会经由该虚拟网卡，导致系统时钟发生跳变。

  FreeSWITCH 对时钟跳变极其敏感：`switch_time` 检测到 forward clock skew 后
  会重同步时钟，实测曾导致 FreeSWITCH 静默退出、ESL 端口 8021 失效，表现为
  管理页面能打开但首页数据加载失败（connect ECONNREFUSED 127.0.0.1:8021）。

  本脚本做三件事：
    1. 诊断：显示当前 NTP 源、是否落在代理网段、以及到 198.18.1.35 的路由；
    2. 修复（需管理员）：把时间同步改回直连的公共 NTP 服务器；
    3. 验证：重新查询状态，确认 NTP 源不再是 198.18.x.x。

  注意：修改系统时间同步需要管理员权限。请以管理员身份运行 PowerShell。

.PARAMETER DiagnoseOnly
  只诊断不修改。

.PARAMETER NtpServer
  要使用的 NTP 服务器（可多个，逗号分隔）。默认国内可达的公共源。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\fix-ntp-proxy.ps1 -DiagnoseOnly

.EXAMPLE
  # 以管理员身份运行
  powershell -ExecutionPolicy Bypass -File scripts\fix-ntp-proxy.ps1
#>

[CmdletBinding()]
param(
  [switch]$DiagnoseOnly,
  [string]$NtpServer = "ntp.aliyun.com,time1.cloud.tencent.com,cn.pool.ntp.org"
)

Set-StrictMode -Version Latest
# 诊断类脚本：不要让原生命令的 stderr 输出（如 w32tm 的提示）中断整个流程
$ErrorActionPreference = "Continue"

# 编码处理（这里有个容易踩的坑）：
#   · 本脚本自身的中文是 UTF-8，输出到管道/终端都应是 UTF-8；
#   · 但 w32tm 等系统原生命令按「控制台 OEM 代码页」（简中为 GBK）输出。
# 若全局把 OutputEncoding 改成 GBK，本脚本自己的中文就乱了；
# 若保持 UTF-8，原生命令的中文又会乱。
# 解法：只在对原生命令的调用前后临时切换编码，调用完立刻恢复 UTF-8。
$script:Utf8Encoding = New-Object System.Text.UTF8Encoding($false)

function Invoke-NativeText {
  param([scriptblock]$Command)
  $original = [Console]::OutputEncoding
  try {
    $oem = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
    [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding($oem)
  } catch {
    # 取不到就沿用原编码，仅影响显示
  }
  try {
    return (& $Command 2>&1 | Out-String)
  } finally {
    try { [Console]::OutputEncoding = $original } catch { }
  }
}

function Write-Native([string]$Text) {
  # 原生命令的多行输出：按 UTF-8 重新写出，避免乱码
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  foreach ($line in ($Text.Trim() -split "`r?`n")) {
    Write-Host "    $line" -ForegroundColor DarkGray
  }
}

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string]$Message){ Write-Host "    $Message" -ForegroundColor Yellow }
function Write-Err2([string]$Message) { Write-Host "    $Message" -ForegroundColor Red }

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NtpSourceIp {
  # w32tm 输出为本地化文本，直接抓取第一个 IPv4 形如地址
  $status = Invoke-NativeText { w32tm /query /status }
  $match = [regex]::Match($status, '\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b')
  if ($match.Success) { return $match.Groups[1].Value }
  return ""
}

# 198.18.0.0/15 是 RFC 2544 基准测试保留段，被代理软件广泛用作 fake-ip
function Test-ProxyFakeIp([string]$Ip) {
  if ([string]::IsNullOrWhiteSpace($Ip)) { return $false }
  $parts = $Ip.Split(".")
  if ($parts.Length -ne 4) { return $false }
  $first = 0; $second = 0
  if (-not [int]::TryParse($parts[0], [ref]$first)) { return $false }
  if (-not [int]::TryParse($parts[1], [ref]$second)) { return $false }
  return ($first -eq 198 -and ($second -eq 18 -or $second -eq 19))
}

# ------------------------------------------------------------------ 诊断

Write-Host "`nWindows 时间同步 · 代理网卡排除工具" -ForegroundColor White

Write-Step "1. 当前时间同步状态"
$sourceIp = Get-NtpSourceIp
$statusText = Invoke-NativeText { w32tm /query /status }
Write-Native $statusText

Write-Step "2. 判定"
$isProxy = Test-ProxyFakeIp $sourceIp
if (-not $sourceIp) {
  Write-Warn2 "未能从 w32tm 输出中解析出 NTP 源 IP（可能未启用或输出语言不受支持）。"
} elseif ($isProxy) {
  Write-Err2 "检测到 NTP 源 $sourceIp 落在代理虚拟网卡网段（198.18.0.0/15）。"
  Write-Err2 "这会让系统时钟经由代理同步，可能发生跳变并导致 FreeSWITCH 退出。"
} else {
  Write-Ok "NTP 源 $sourceIp 不在代理网段，正常。"
}

Write-Step "3. 到代理 fake-ip 的路由（确认它确实走虚拟网卡）"
$route = (Find-NetRoute -RemoteIPAddress "198.18.1.35" -ErrorAction SilentlyContinue |
  Select-Object -First 3 IPAddress, InterfaceAlias, NextHop |
  Format-Table -AutoSize | Out-String)
if ($route.Trim()) { $route.Trim() -split "`r?`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
else { Write-Host "    （无输出）" -ForegroundColor DarkGray }

Write-Step "4. 当代理虚拟网卡"
$adapters = (Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceDescription -match "Mihomo|Clash|TUN|TAP|WireGuard|OpenVPN|Wintun" } |
  Select-Object Name, InterfaceDescription, Status, ifIndex |
  Format-Table -AutoSize | Out-String)
if ($adapters.Trim()) { $adapters.Trim() -split "`r?`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
else { Write-Host "    （未发现常见代理虚拟网卡）" -ForegroundColor DarkGray }

if ($DiagnoseOnly) {
  Write-Host "`n（-DiagnoseOnly 指定，未做任何修改）`n" -ForegroundColor Yellow
  if ($isProxy) { exit 2 } else { exit 0 }
}

# ------------------------------------------------------------------ 修复

Write-Step "5. 应用修复"

if (-not (Test-IsAdmin)) {
  Write-Err2 "修改系统时间同步需要管理员权限，当前会话不是管理员。"
  Write-Warn2 "请右键以「以管理员身份运行」打开 PowerShell，再执行："
  Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\fix-ntp-proxy.ps1" -ForegroundColor White
  Write-Host ""
  exit 1
}

Write-Ok "已具备管理员权限。"

# 说明：不用 sc.exe triggerinfo 那种「按触发器重定向」，而是直接指定 NTP 服务器。
# 因为问题根源是「同步目标本身是代理 fake-ip」，而非「触发时机不对」。
Write-Host "    设置时间同步源为: $NtpServer" -ForegroundColor DarkGray
Write-Native (Invoke-NativeText { w32tm /config /manualpeerlist:$NtpServer /syncfromflags:manual /update })

Write-Native (Invoke-NativeText { w32tm /resync /rediscover })

Start-Sleep -Seconds 3

# ------------------------------------------------------------------ 验证

Write-Step "6. 验证结果"
$afterIp = Get-NtpSourceIp
$afterStatus = Invoke-NativeText { w32tm /query /status }
Write-Native $afterStatus

Write-Host ""
if ($afterIp -and -not (Test-ProxyFakeIp $afterIp)) {
  Write-Ok "修复成功：NTP 源为 $afterIp，已不在代理网段。"
  Write-Host ""
  exit 0
} elseif (-not $afterIp) {
  Write-Warn2 "已应用配置，但暂时读不到新的 NTP 源 IP。"
  Write-Warn2 "时间同步可能需要几分钟才生效，可稍后重跑本脚本确认。"
  Write-Host ""
  exit 0
} else {
  Write-Err2 "仍检测到代理网段地址 $afterIp。"
  Write-Warn2 "可能原因：代理软件在接管 DNS，把 NTP 域名也解析成了 fake-ip。"
  Write-Warn2 "建议在代理软件里把 NTP 域名加入直连（DIRECT）规则，或改用其 IP 直连同步。"
  Write-Host ""
  exit 2
}
