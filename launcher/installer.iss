; ============================================================================
; SIP 广播系统 · Windows 安装包脚本（Inno Setup 6）
;
; 编译：ISCC.exe installer.iss
; 产物：SIPBroadcast-Setup-<版本>.exe
;
; 设计要点：
;   1. 程序文件装到 {app}（默认 Program Files），只读；
;   2. 可写数据放在 {localappdata} 或安装目录旁的 data/，
;      避免 Program Files 的写权限限制；
;   3. 卸载时询问是否保留业务数据，默认保留；
;   4. 安装完成后可选择立即启动并打开管理页面。
; ============================================================================

#define AppName "SIP 广播系统"
#define AppNameEn "SIP Broadcast System"
#define AppVersion "0.1.0"
#define AppPublisher "SIP Broadcast"
#define AppExeName "SIPBroadcast.exe"

[Setup]
AppId={{8F3C2A41-9D57-4E62-B1A8-3C7E5F0D91B4}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\SIPBroadcast
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}

; 需要 64 位系统（Node 与 FreeSWITCH 均为 x64）
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

; 压缩：FreeSWITCH 内含大量 DLL，用 lzma2/ultra64 可显著减小体积
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4

WizardStyle=modern
; 安装到 Program Files 需要管理员权限；应用的可写数据会自动落到
; 用户目录（由启动器运行时判定），因此不依赖安装时的 per-user 写入。
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

OutputDir=..\dist-portable\installer
OutputBaseFilename=SIPBroadcast-Setup-{#AppVersion}

[Languages]
Name: "chinese"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加选项:"; Flags: checkedonce
Name: "quicklaunchicon"; Description: "创建快速启动栏图标"; GroupDescription: "附加选项:"; Flags: unchecked

[Files]
; ---- 启动器与配置 ----
Source: "..\dist-portable\SIPBroadcast-Portable\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-portable\SIPBroadcast-Portable\config.json"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\dist-portable\SIPBroadcast-Portable\说明.txt"; DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "..\dist-portable\SIPBroadcast-Portable\调试启动.bat"; DestDir: "{app}"; Flags: ignoreversion

; ---- 前端与后端（程序文件，只读）----
Source: "..\dist-portable\SIPBroadcast-Portable\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

; 安装标记：启动器据此判定为「安装模式」，把可写数据放到用户目录，
; 从而不受 Program Files 写权限限制
Source: "..\launcher\install-marker.txt"; DestDir: "{app}"; DestName: ".installed"; Flags: ignoreversion

; ---- Node 运行时 ----
Source: "..\dist-portable\SIPBroadcast-Portable\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs

; ---- FreeSWITCH 引擎 ----
; 安装到 {app}，但运行时会把可写目录（log/db/recordings）指向数据目录
Source: "..\dist-portable\SIPBroadcast-Portable\data\freeswitch\*"; DestDir: "{app}\data\freeswitch"; Flags: ignoreversion recursesubdirs createallsubdirs

; ---- 初始数据 ----
; 不在此处写入用户目录：安装以管理员身份运行，写 localappdata 会落到
; 管理员账户而非实际使用者的账户。改为由启动器首次运行时自动创建。

; 启动器源码保留（排障用）；排除字节码缓存与打包脚本
Source: "..\dist-portable\SIPBroadcast-Portable\launcher\*"; DestDir: "{app}\launcher"; \
    Excludes: "__pycache__\*,*.pyc,build.spec,build-portable.ps1,installer.iss,extract-freeswitch.py"; \
    Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{group}\管理页面（需先启动）"; Filename: "http://127.0.0.1:3000/"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: quicklaunchicon

[Run]
; 安装完成后可选启动（默认勾选）
Filename: "{app}\{#AppExeName}"; Description: "立即启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只清理运行时生成的目录，不动 data（可能在用户数据目录）
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\runtime"

[Code]
// ---------------------------------------------------------------------------
// 卸载前询问是否保留业务数据
// ---------------------------------------------------------------------------
var
  KeepData: Boolean;

function InitializeUninstall(): Boolean;
begin
  KeepData := True;
  if MsgBox('是否保留业务数据？' + #13#10 + #13#10 +
            '数据包含：SIP 账号、分区、定时计划、广播记录、' + #13#10 +
            '上传的音频文件、系统配置。' + #13#10 + #13#10 +
            '选择「是」将保留数据，重新安装后可继续使用；' + #13#10 +
            '选择「否」将永久删除全部业务数据。',
            mbConfirmation, MB_YESNO or MB_DEFBUTTON1) = IDNO then
  begin
    KeepData := False;
    if MsgBox('确认要永久删除全部业务数据吗？此操作不可恢复。',
              mbCriticalError, MB_YESNO or MB_DEFBUTTON2) = IDNO then
      KeepData := True;
  end;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not KeepData) then
  begin
    // 数据可能存在于多个账户的用户目录下（安装时用管理员、运行时用普通用户），
    // 这里清理当前上下文能触及的位置；其余需用户手动删除。
    DelTree(ExpandConstant('{localappdata}\SIPBroadcast'), True, True, True);
    DelTree(ExpandConstant('{userappdata}\SIPBroadcast'), True, True, True);
    DelTree(ExpandConstant('{app}\data'), True, True, True);
    DelTree(ExpandConstant('{app}\logs'), True, True, True);
    DelTree(ExpandConstant('{app}\runtime'), True, True, True);
  end;
end;

// ---------------------------------------------------------------------------
// 安装前检查：应用正在运行时提示关闭
// ---------------------------------------------------------------------------
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  // 若检测到残留进程，尝试结束（升级安装场景常见）
  Exec('cmd.exe', '/C taskkill /F /IM SIPBroadcast.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('cmd.exe', '/C taskkill /F /IM FreeSwitchConsole.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1200);
end;
