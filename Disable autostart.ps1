$ErrorActionPreference = 'Stop'
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder 'Codex local account gateway.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
    Write-Output 'Gateway autostart disabled. The currently running gateway is unchanged.'
} else {
    Write-Output 'Gateway autostart is already disabled.'
}
