; RunningHub AI 设计师工具箱 — Inno Setup 打包脚本
; 编译：ISCC.exe installer.iss（或运行 打包安装包.bat）
; 产物：installer\RunningHub-AI-Toolbox-Setup-<版本>.exe

#define MyAppName "RunningHub AI 设计师工具箱"
#define MyAppVersion "1.2.2"
#define MyAppPublisher "RunningHub AI"
#define MyAppExeName "RunningHubToolbox.exe"

[Setup]
AppId={{A6F1C0D2-9B34-4E7B-8C1D-2F5A7B9E3C61}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\RunningHubToolbox
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=installer
OutputBaseFilename=RunningHub-AI-Toolbox-Setup-{#MyAppVersion}
SetupIconFile=ICO\RAPI.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
VersionInfoVersion={#MyAppVersion}.0
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
; 程序无窗口，Inno 的"自动关闭应用"无法结束它，改由下方 [Code] 直接结束进程
CloseApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: checkedonce

[Files]
; 打包 PyInstaller 产物：exe + 网页资源 + 内置工具配置与封面
Source: "dist\RunningHubToolbox\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
procedure KillRunningApp;
var
  ResultCode: Integer;
begin
  // 无窗口进程：Restart Manager 关不掉，安装/卸载前先强制结束，避免文件被占用
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#MyAppExeName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(600);
end;

function InitializeSetup(): Boolean;
begin
  KillRunningApp;
  Result := True;
end;

function InitializeUninstall(): Boolean;
begin
  KillRunningApp;
  Result := True;
end;
