# Sync shared UI core: runninghub_api -> COMFYUI_api
# Keep shared files in runninghub_api only; run this after editing them.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = 'D:\project\COMFYUI_api'

$shared = @(
  'css\style.css',
  'js\store.js',
  'js\ui\form.js',
  'js\ui\toollist.js',
  'js\ui\results.js',
  'js\ui\lightbox.js',
  'js\ui\maskeditor.js',
  'js\ui\modal.js'
)

if (-not (Test-Path $dst)) {
  Write-Host "Target folder not found: $dst" -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}

$backupDir = Join-Path $dst ('.core_backup_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Write-Host ""
Write-Host "Sync shared core files" -ForegroundColor Cyan
Write-Host "  from: $src"
Write-Host "  to  : $dst"
Write-Host ""

$ok = 0
foreach ($rel in $shared) {
  $s = Join-Path $src $rel
  $d = Join-Path $dst $rel
  if (-not (Test-Path $s)) { Write-Host "  MISSING SOURCE: $rel" -ForegroundColor Yellow; continue }
  $targetDir = Split-Path $d -Parent
  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
  if (Test-Path $d) {
    $bak = Join-Path $backupDir $rel
    New-Item -ItemType Directory -Path (Split-Path $bak -Parent) -Force | Out-Null
    Copy-Item $d $bak -Force
  }
  Copy-Item $s $d -Force
  Write-Host "  OK  $rel" -ForegroundColor Green
  $ok++
}

Write-Host ""
Write-Host "Done: $ok / $($shared.Count) files synced" -ForegroundColor Cyan
Write-Host "Backup: $backupDir" -ForegroundColor DarkGray
Write-Host ""
Read-Host "Press Enter to close"
