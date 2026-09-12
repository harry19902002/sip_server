# 组装 Windows 便携版：SIPBroadcast-Portable/
#
# 产出结构：
#   SIPBroadcast-Portable/
#     SIPBroadcast.exe          启动器（GUI + 托盘）
#     config.json               可选配置
#     说明.txt                  使用说明
#     app/                      前端产物 + 后端服务 + node_modules
#     node/node.exe             随包 Node 运行时
#     data/freeswitch/          FreeSWITCH 便携版（可用 -DownloadFreeswitch 自动获取）
#     logs/ runtime/            运行期生成
#
# 用法：
#   pwsh -File launcher/build-portable.ps1
#   pwsh -File launcher/build-portable.ps1 -DownloadFreeswitch
#   pwsh -File launcher/build-portable.ps1 -FreeswitchDir "C:\Program Files\FreeSWITCH"

[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [string]$FreeswitchDir = "",
    [string]$NodePath = "",
    [switch]$SkipFrontendBuild,
    [switch]$SkipLauncherBuild,
    [switch]$SkipInstaller,
    [switch]$DownloadFreeswitch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LauncherDir = Join-Path $ProjectRoot "launcher"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $ProjectRoot "dist-portable\SIPBroadcast-Portable"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

# StrictMode 下未定义的变量会抛异常。$LASTEXITCODE 只有执行过外部程序
# 之后才存在，因此先初始化，避免「尚未调用外部命令」时读取报错。
$global:LASTEXITCODE = 0

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    $Message" -ForegroundColor Green
}

function Assert-LastExitCode([string]$Message) {
    $code = if (Test-Path variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
    if ($code -ne 0) { throw "$Message (exit code: $code)" }
}

Write-Host "SIP 广播系统 · 便携版打包" -ForegroundColor White
Write-Host "输出目录: $OutputDirectory" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. 前置检查

function Remove-DirectorySafe {
    <#
        递归删除目录。
        不使用 Remove-Item：某些环境下它被安全策略包装，会引用未定义的
        $LASTEXITCODE，在 StrictMode 下直接抛异常。这里直接用 .NET API。
    #>
    param([string]$Path)
    if (-not $Path) { return }
    if (Test-Path -LiteralPath $Path) {
        try {
            [System.IO.Directory]::Delete($Path, $true)
        } catch {
            Write-Host "    清理失败（可忽略）: $Path" -ForegroundColor DarkGray
        }
    }
}

function Join-PathSafe {
    <#
        Join-Path 的容错版本：当任一段为空时不抛异常，返回 $null。
        受限环境下部分环境变量（如 ProgramFiles(x86)）可能未定义。
    #>
    param([string]$Base, [string]$Child)
    if ([string]::IsNullOrWhiteSpace($Base)) { return $null }
    return (Join-Path $Base $Child)
}

function Get-ProgramFilesPaths {
    <#
        获取 64 位与 32 位 Program Files 目录。

        注意：PowerShell 中 $env:ProgramFiles(x86) 会被解析成字面量 "(x86)"
        （括号被当成语法），必须用 .NET 的 GetEnvironmentVariable 取值。
        同时部分受限环境会清空 $env:ProgramFiles，所以两个来源都尝试。
    #>
    $paths = [System.Collections.Generic.List[string]]::new()

    $native = [System.Environment]::GetEnvironmentVariable("ProgramFiles")
    $x86 = [System.Environment]::GetEnvironmentVariable("ProgramFiles(x86)")

    if ($native) { $paths.Add($native) }
    if ($x86) { $paths.Add($x86) }

    # 兜底：按系统盘推断
    $systemDrive = [System.Environment]::GetEnvironmentVariable("SystemDrive")
    if ($systemDrive) {
        $paths.Add("$systemDrive\Program Files")
        $paths.Add("$systemDrive\Program Files (x86)")
    }

    return ($paths | Select-Object -Unique)
}

function Resolve-NodeExecutable {
    <#
        在部分受限环境中（安全策略 shim、精简 PATH），`node` 可能无法
        通过 PATH 解析，但 node.exe 实际存在。这里按优先级搜索已知位置。
    #>
    $fromPath = Get-Command node -ErrorAction SilentlyContinue
    if ($fromPath -and $fromPath.Source) { return $fromPath.Source }

    $candidates = @()
    foreach ($pf in Get-ProgramFilesPaths) {
        $candidates += (Join-PathSafe $pf "nodejs\node.exe")
    }
    $candidates += (Join-PathSafe $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    $candidates += (Join-PathSafe $env:APPDATA "npm\node.exe")
    $candidates += (Join-PathSafe $env:USERPROFILE ".workbuddy\binaries\node\versions\22.22.2-2\node.exe")

    # WorkBuddy 托管运行时（按版本号倒序）
    $managedRoot = Join-PathSafe $env:USERPROFILE ".workbuddy\binaries\node\versions"
    if ($managedRoot -and (Test-Path -LiteralPath $managedRoot)) {
        Get-ChildItem -LiteralPath $managedRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates += (Join-Path $_.FullName "node.exe" -ErrorAction SilentlyContinue) }
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

$NodeExecutable = Resolve-NodeExecutable
if (-not $NodeExecutable) {
    throw "未找到 node.exe。请安装 Node.js，或使用 -NodePath 指定路径。"
}
Write-Ok "Node 运行时: $NodeExecutable"

$NpmExecutable = Join-Path (Split-Path $NodeExecutable) "npm.cmd"
if (-not (Test-Path -LiteralPath $NpmExecutable)) {
    $npmFromPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmFromPath) { $NpmExecutable = $npmFromPath.Source }
}
Write-Host "    npm: $NpmExecutable" -ForegroundColor DarkGray

$pythonForBuild = $null
$pythonCandidates = [System.Collections.Generic.List[string]]::new()

# 1) 依赖已有的启动器专用虚拟环境
$userProfilePath = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:USERNAME) { "C:\Users\$env:USERNAME" } else { $null }
if ($userProfilePath) {
    $pythonCandidates.Add((Join-Path $userProfilePath ".workbuddy\binaries\python\envs\sip-launcher\Scripts\python.exe"))
}
# 2) 项目内虚拟环境
$pythonCandidates.Add((Join-Path $ProjectRoot ".venv\Scripts\python.exe"))
$pythonCandidates.Add((Join-Path $LauncherDir ".venv\Scripts\python.exe"))

foreach ($candidate in $pythonCandidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { $pythonForBuild = $candidate; break }
}

if (-not $pythonForBuild) {
    $probe = Get-Command python -ErrorAction SilentlyContinue
    if ($probe) { $pythonForBuild = $probe.Source }
}
if ($pythonForBuild) { Write-Ok "打包用 Python: $pythonForBuild" }
else { Write-Host "    未找到 Python，将跳过启动器编译" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 2. 清理输出

Write-Step "准备输出目录"
if (Test-Path -LiteralPath $OutputDirectory) {
    # 仅删除可重建的子目录，保留 data/（业务数据）以免误删用户数据
    foreach ($sub in @("app", "node", "logs", "runtime")) {
        $target = Join-Path $OutputDirectory $sub
        if (Test-Path -LiteralPath $target) {
            Remove-DirectorySafe $target
        }
    }
    Write-Ok "已清理可重建目录（保留 data/）"
} else {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Write-Ok "已创建输出目录"
}
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory "data") -Force | Out-Null

# ---------------------------------------------------------------- 2.5 生成版本号

# 版本号 = 基础版本（launcher/version.py 的 BASE_VERSION）+ 构建时间戳 YYYYMMDD.HHMM。
# 生成 launcher/_build_info.py 供启动器在运行时读取，使 GUI 与安装包能显示本次构建时间。
#
# 时间戳必须在「编译启动器」前定稿，且后续步骤（含 -SkipLauncherBuild 的补跑）必须复用它，
# 否则 exe 里烘焙的版本与安装包名会不一致。因此：
#   - 正常打包：取当前时间并写入 _build_info.py
#   - -SkipLauncherBuild（沿用已编译的 exe）：优先沿用 _build_info.py 里已有的时间戳
Write-Step "生成构建版本号"
# version.py 是基础版本的唯一来源，这里读取其 BASE_VERSION，避免两处硬编码不一致
$versionPy = Join-Path $LauncherDir "version.py"
$BaseVersion = "0.1.0"
if (Test-Path -LiteralPath $versionPy) {
    $match = [regex]::Match((Get-Content -LiteralPath $versionPy -Raw), 'BASE_VERSION\s*=\s*"([^"]+)"')
    if ($match.Success) { $BaseVersion = $match.Groups[1].Value }
}

$buildInfoPath = Join-Path $LauncherDir "_build_info.py"
$BuildStamp = Get-Date -Format "yyyyMMdd.HHmm"
if ($SkipLauncherBuild -and (Test-Path -LiteralPath $buildInfoPath)) {
    $existing = [regex]::Match((Get-Content -LiteralPath $buildInfoPath -Raw), 'BUILD_STAMP\s*=\s*"([^"]+)"')
    if ($existing.Success) {
        $BuildStamp = $existing.Groups[1].Value
        Write-Host "    沿用已编译 exe 的构建戳 $BuildStamp" -ForegroundColor DarkGray
    }
}
$FullVersion = "$BaseVersion+$BuildStamp"
$buildInfoContent = @"
# 本文件由 build-portable.ps1 自动生成，请勿手工编辑。
# 每次打包时重写，用于让启动器显示「本次构建」的版本与时间。
BUILD_STAMP = "$BuildStamp"
BUILD_VERSION = "$FullVersion"
"@
# 必须写成无 BOM 的 UTF-8：Python 3 读取含 BOM 的文件会保留 \ufeff 前缀字符
[System.IO.File]::WriteAllText($buildInfoPath, $buildInfoContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "版本号 $FullVersion"

# ---------------------------------------------------------------- 3. 构建前端

if (-not $SkipFrontendBuild) {
    Write-Step "构建管理前端"
    Push-Location $ProjectRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
            Write-Host "    安装依赖 (npm ci)…" -ForegroundColor DarkGray
            & $NpmExecutable ci
            Assert-LastExitCode "npm ci 失败"
        }
        & $NpmExecutable run build
        Assert-LastExitCode "前端构建失败"
        Write-Ok "前端构建完成"
    } finally {
        Pop-Location
    }
} else {
    Write-Step "跳过前端构建"
}

# ---------------------------------------------------------------- 4. 组装 app/

Write-Step "组装 app/ 运行目录"
$appTarget = Join-Path $OutputDirectory "app"
New-Item -ItemType Directory -Path $appTarget -Force | Out-Null

# 4.1 前端产物（dist 即运行所需）
Copy-Item -LiteralPath (Join-Path $ProjectRoot "dist") -Destination (Join-Path $appTarget "dist") -Recurse -Force
Write-Ok "已复制前端产物 dist/"

# 4.2 后端 API（零依赖，直接复制源码）
$apiTarget = Join-Path $appTarget "services\freeswitch-api"
New-Item -ItemType Directory -Path $apiTarget -Force | Out-Null
foreach ($item in @("server.mjs", "healthcheck.mjs", "package.json")) {
    $source = Join-Path $ProjectRoot "services\freeswitch-api\$item"
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $apiTarget -Force }
}
Copy-Item -LiteralPath (Join-Path $ProjectRoot "services\freeswitch-api\lib") -Destination (Join-Path $apiTarget "lib") -Recurse -Force
Write-Ok "已复制后端 API"

# 4.3 FreeSWITCH 配置模板（供启动器渲染）
Copy-Item -LiteralPath (Join-Path $ProjectRoot "infra\freeswitch\config") -Destination (Join-Path $appTarget "infra\freeswitch\config") -Recurse -Force
Write-Ok "已复制 FreeSWITCH 配置模板"

# 4.4 前端运行时依赖：解析依赖闭包，只保留运行期所需
Write-Step "收集前端运行时依赖"
$nodeModulesTarget = Join-Path $appTarget "node_modules"
New-Item -ItemType Directory -Path $nodeModulesTarget -Force | Out-Null

$collectorScript = Join-Path $LauncherDir "collect-deps.py"
$depsOk = $false
if ($pythonForBuild -and (Test-Path -LiteralPath $collectorScript)) {
    & $pythonForBuild $collectorScript (Join-Path $ProjectRoot "node_modules") $nodeModulesTarget
    if ($LASTEXITCODE -eq 0) { $depsOk = $true }
}
if (-not $depsOk) {
    # 回退：无法运行 Python 时，至少复制直接依赖
    Write-Host "    回退为直接复制根依赖" -ForegroundColor Yellow
    foreach ($module in @("vinext", "vite", "react", "react-dom", "react-server-dom-webpack")) {
        $source = Join-Path $ProjectRoot "node_modules\$module"
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $nodeModulesTarget $module) -Recurse -Force
        } else {
            Write-Host "    警告: 缺少 node_modules/$module" -ForegroundColor Yellow
        }
    }
}

# 4.5 前端 package.json（vinext start 需要读取）
Copy-Item -LiteralPath (Join-Path $ProjectRoot "package.json") -Destination (Join-Path $appTarget "package.json") -Force
Write-Ok "app/ 组装完成"

# ---------------------------------------------------------------- 5. 随包 Node

Write-Step "准备 Node 运行时"
$nodeTarget = Join-Path $OutputDirectory "node"
New-Item -ItemType Directory -Path $nodeTarget -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = $NodeExecutable
}
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $nodeTarget "node.exe") -Force
Write-Ok "已复制 node.exe ($([math]::Round((Get-Item $NodePath).Length / 1MB, 1)) MB)"

# ---------------------------------------------------------------- 6. FreeSWITCH

Write-Step "准备 FreeSWITCH"
$fsTarget = Join-Path $OutputDirectory "data\freeswitch"

# 允许直接复用已解包的 FreeSWITCH（避免每次重新解包 126MB 安装包）
$prebuiltFsCandidates = @(
    (Join-Path $ProjectRoot "dist-portable\_fsdl\staging\FreeSWITCH"),
    (Join-Path $ProjectRoot ".cache\freeswitch-portable")
)
$prebuiltFs = $null
foreach ($candidate in $prebuiltFsCandidates) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate "FreeSwitchConsole.exe"))) {
        $prebuiltFs = $candidate
        break
    }
}

if (-not [string]::IsNullOrWhiteSpace($FreeswitchDir)) {
    if (-not (Test-Path -LiteralPath $FreeswitchDir)) { throw "指定的 FreeSWITCH 目录不存在: $FreeswitchDir" }
    Remove-DirectorySafe $fsTarget
    New-Item -ItemType Directory -Path $fsTarget -Force | Out-Null
    Copy-Item -Path (Join-Path $FreeswitchDir "*") -Destination $fsTarget -Recurse -Force
    Write-Ok "已从本地复制 FreeSWITCH: $FreeswitchDir"
} elseif ($DownloadFreeswitch) {
    # 下载官方 Windows 版 FreeSWITCH 并解包为便携目录。
    # 注意：MSI 通过 msiexec /a（管理安装）解包，不会真正安装到系统。
    $msiUrl = "https://files.freeswitch.org/windows/installer/x64/FreeSWITCH-1.10.12-Release-x64.msi"
    $msiPath = Join-Path $ProjectRoot "dist-portable\_fsdl\freeswitch.msi"

    if (-not (Test-Path -LiteralPath $msiPath)) {
        New-Item -ItemType Directory -Path (Split-Path $msiPath) -Force | Out-Null
        Write-Host "    下载 $msiUrl" -ForegroundColor DarkGray
        Write-Host "    （若速度过慢，可自行用下载工具获取后放到: $msiPath）" -ForegroundColor DarkGray
        $progressBackup = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        try {
            Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        } finally {
            $ProgressPreference = $progressBackup
        }
    } else {
        Write-Ok "复用已下载的安装包"
    }

    # 调用解包脚本（兼容 msiexec 被策略限制的情况）
    $extractor = Join-Path $LauncherDir "extract-freeswitch.py"
    $staging = Join-Path $ProjectRoot "dist-portable\_fsdl\staging"
    if ($pythonForBuild -and (Test-Path -LiteralPath $extractor)) {
        & $pythonForBuild $extractor $msiPath $staging
        if ($LASTEXITCODE -ne 0) { throw "FreeSWITCH 解包失败" }
    } else {
        throw "需要 Python 执行解包脚本: $extractor"
    }

    $fsConsole = Get-ChildItem -LiteralPath $staging -Recurse -Filter "FreeSwitchConsole.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $fsConsole) { throw "解包后未找到 FreeSwitchConsole.exe" }

    Remove-DirectorySafe $fsTarget
    New-Item -ItemType Directory -Path $fsTarget -Force | Out-Null
    Copy-Item -Path (Join-Path $fsConsole.Directory.FullName "*") -Destination $fsTarget -Recurse -Force
    Write-Ok "FreeSWITCH 已就位"
} elseif ($prebuiltFs) {
    Remove-DirectorySafe $fsTarget
    New-Item -ItemType Directory -Path $fsTarget -Force | Out-Null
    Copy-Item -Path (Join-Path $prebuiltFs "*") -Destination $fsTarget -Recurse -Force
    Write-Ok "已复用本地解包的 FreeSWITCH"
} else {
    if (-not (Test-Path -LiteralPath $fsTarget)) {
        New-Item -ItemType Directory -Path $fsTarget -Force | Out-Null
        Write-Host "    未提供 FreeSWITCH。请任选其一：" -ForegroundColor Yellow
        Write-Host "      - 再次运行并加 -DownloadFreeswitch（自动下载并解包）" -ForegroundColor Yellow
        Write-Host "      - 再次运行并加 -FreeswitchDir `"<已安装的 FreeSWITCH 目录>`"" -ForegroundColor Yellow
        Write-Host "      - 手动把 FreeSWITCH 文件放入: $fsTarget" -ForegroundColor Yellow
    } else {
        Write-Ok "沿用已有的 FreeSWITCH 目录"
    }
}

# ---------------------------------------------------------------- 7. 编译启动器

Write-Step "编译启动器 SIPBroadcast.exe"
$exeTarget = Join-Path $OutputDirectory "SIPBroadcast.exe"

if ($SkipLauncherBuild) {
    Write-Host "    已跳过（-SkipLauncherBuild）" -ForegroundColor Yellow
} elseif ($pythonForBuild) {
    # 先生成应用图标（exe 与安装包都会用到）
    $iconScript = Join-Path $LauncherDir "make_icon.py"
    $iconPath = Join-Path $LauncherDir "assets\app.ico"
    if ((Test-Path -LiteralPath $iconScript) -and (-not (Test-Path -LiteralPath $iconPath))) {
        & $pythonForBuild $iconScript 2>&1 | Out-Null
    }

    Push-Location $LauncherDir
    try {
        # 使用绝对路径，避免相对路径被解释到意外位置
        & $pythonForBuild -m PyInstaller --noconfirm --clean `
            --distpath $OutputDirectory `
            --workpath (Join-Path $ProjectRoot "dist-portable\.pyinstaller") `
            (Join-Path $LauncherDir "build.spec")
        if ($LASTEXITCODE -ne 0) {
            Write-Host "    PyInstaller 失败，将回退为脚本启动方式" -ForegroundColor Yellow
        } elseif (Test-Path -LiteralPath $exeTarget) {
            Write-Ok "已生成 SIPBroadcast.exe ($([math]::Round((Get-Item $exeTarget).Length / 1MB, 1)) MB)"
        } else {
            Write-Host "    PyInstaller 已执行，但未找到 $exeTarget" -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "    未找到可用的 Python，跳过 exe 编译" -ForegroundColor Yellow
}

# 兜底：无论 exe 是否生成，都放一个 .bat 便于直接运行与排查
# 注意：.bat 必须写为「无 BOM 的 UTF-8」，否则 cmd.exe 会把 BOM 当作命令的一部分
$batPath = Join-Path $OutputDirectory "调试启动.bat"
$batPython = if ($pythonForBuild) { $pythonForBuild } else { "python" }
$batContent = @"
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 调试模式：启动 SIP 广播系统（保留控制台窗口）
echo.
"$batPython" "%~dp0launcher\main.py"
if errorlevel 1 pause
"@
[System.IO.File]::WriteAllText($batPath, $batContent, (New-Object System.Text.UTF8Encoding($false)))

# 把启动器源码放进便携包，便于无 exe 时直接运行与排查
$launcherTarget = Join-Path $OutputDirectory "launcher"
if (-not (Test-Path -LiteralPath $launcherTarget)) {
    Copy-Item -LiteralPath $LauncherDir -Destination $launcherTarget -Recurse -Force
    # 移除仅用于构建的文件，保持运行目录简洁
    foreach ($name in @("build-portable.ps1", "build.spec", "debug-build.ps1")) {
        $stale = Join-Path $launcherTarget $name
        if (Test-Path -LiteralPath $stale) {
            if (Test-Path -LiteralPath $stale) { [System.IO.File]::Delete($stale) }
        }
    }
    # 移除打包过程中生成的字节码缓存
    foreach ($cacheDir in Get-ChildItem -LiteralPath $launcherTarget -Directory -ErrorAction SilentlyContinue) {
        if ($cacheDir.Name -eq "__pycache__") {
            Remove-DirectorySafe $cacheDir.FullName
        }
    }
    Write-Ok "已附带启动器源码（调试用）"
}

# ---------------------------------------------------------------- 8. 配置文件与说明

Write-Step "写入默认配置与说明"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$configPath = Join-Path $OutputDirectory "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    # config.json 必须无 BOM，否则 JSON.parse 会失败
    $configJson = @'
{
  "frontend_port": 3000,
  "api_port": 3001,
  "esl_port": 8021,
  "sip_port": 5060,
  "sip_domain": "sip.local",
  "frontend_host": "0.0.0.0",
  "api_host": "0.0.0.0",
  "auto_open_browser": true
}
'@
    [System.IO.File]::WriteAllText($configPath, $configJson, $utf8NoBom)
    Write-Ok "已写入 config.json"
}

$readmePath = Join-Path $OutputDirectory "说明.txt"
@'
SIP 广播系统 · Windows 便携版
================================

【运行】
  双击 SIPBroadcast.exe 即可。程序会自动启动全部服务并在右下角托盘常驻。
  首次启动若提示缺少 FreeSWITCH，请把 FreeSWITCH 文件放入 data\freeswitch\ 目录。

【关闭】
  关闭主窗口，或右键托盘图标选择「退出并关闭服务」，
  程序会一并停止 FreeSWITCH、业务 API 与管理前端，不会残留后台进程。

【访问】
  本机管理页面：http://127.0.0.1:3000/
  局域网访问：  http://<本机局域网IP>:3000/（启动器界面会显示完整地址）
  初始账号：admin / 123456（首次登录后请立即修改密码）
  局域网内其他设备的 SIP 终端请使用界面显示的「局域网地址」。

【端口】
  3000 管理页面 | 3001 业务 API | 5060 SIP | 16384-16484 RTP | 8021 ESL(仅本机)
  如端口被占用，可编辑 config.json 修改后重启。

【数据】
  全部数据保存在 data\ 目录内，直接拷贝整个文件夹即可迁移。
  日志位于 logs\ 目录。

【常见问题】
  · 端口被占用：改 config.json 中的端口，或关闭占用该端口的程序。
  · SIP 终端注册不上：确认终端能访问「局域网地址」，且 Windows 防火墙
    已放行 5060 TCP/UDP 与 16384-16484 UDP。
'@ | Set-Content -LiteralPath $readmePath -Encoding UTF8
Write-Ok "已写入说明.txt"

# ---------------------------------------------------------------- 9. 汇总

Write-Step "打包完成"
$totalSize = (Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host "输出目录 : $OutputDirectory" -ForegroundColor Green
Write-Host "总体积   : $([math]::Round($totalSize / 1MB, 1)) MB" -ForegroundColor Green
Write-Host "启动文件 : $exeTarget" -ForegroundColor Green
Write-Host ""
Write-Host "该目录可整体拷贝到其他 Windows 电脑直接运行（无需 Docker、无需安装 Node）。" -ForegroundColor White

# ---------------------------------------------------------------- 10. 安装包

if (-not $SkipInstaller) {
    Write-Step "编译安装包"

    # 定位 Inno Setup 编译器
    $isccCandidates = @()
    foreach ($pf in Get-ProgramFilesPaths) {
        foreach ($ver in @("Inno Setup 6", "Inno Setup 7")) {
            $isccCandidates += (Join-PathSafe $pf "$ver\ISCC.exe")
        }
    }
    # 允许通过环境变量显式指定（非标准安装位置时使用）
    if ($env:ISCC_PATH) { $isccCandidates = @($env:ISCC_PATH) + $isccCandidates }

    $iscc = $null
    foreach ($candidate in $isccCandidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { $iscc = $candidate; break }
    }

    if (-not $iscc) {
        Write-Host "    未找到 Inno Setup（ISCC.exe），跳过安装包编译" -ForegroundColor Yellow
        Write-Host "    安装方式：https://jrsoftware.org/isdl.php" -ForegroundColor DarkGray
    } else {
        $issPath = Join-Path $LauncherDir "installer.iss"
        Write-Host "    编译器: $iscc" -ForegroundColor DarkGray
        # 安装包版本用点号形式（0.1.0.20260912.1004）：文件名与「程序和功能」都安全可读，
        # 且同样包含构建日期时间。应用内仍用语义化的 0.1.0+20260912.1004。
        $installerVersion = "$BaseVersion.$BuildStamp"
        Push-Location $LauncherDir
        try {
            & $iscc "/DAppVersion=$installerVersion" $issPath
            if ($LASTEXITCODE -eq 0) {
                $setupExe = Join-Path $ProjectRoot "dist-portable\installer\SIPBroadcast-Setup-$installerVersion.exe"
                if (Test-Path -LiteralPath $setupExe) {
                    Write-Ok "已生成安装包 $([math]::Round((Get-Item $setupExe).Length / 1MB, 1)) MB"
                    Write-Ok "安装包版本 $installerVersion"
                } else {
                    Write-Host "    安装包已编译，但未找到 $setupExe" -ForegroundColor Yellow
                }
            } else {
                Write-Host "    安装包编译失败（exit $LASTEXITCODE）" -ForegroundColor Yellow
            }
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Host ""
    Write-Host "已跳过安装包编译（-SkipInstaller）" -ForegroundColor Yellow
}
