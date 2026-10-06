$ErrorActionPreference = 'Stop'
$legacyRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$legacyState = Join-Path $legacyRoot 'work\gateway-state'
if ((Split-Path $PSScriptRoot -Leaf) -eq 'gateway' -and (Test-Path -LiteralPath $legacyState)) {
    $statePath = $legacyState
    $venvPath = Join-Path $legacyRoot 'work\gateway-venv'
} else {
    $statePath = Join-Path $PSScriptRoot '.runtime\state'
    $venvPath = Join-Path $PSScriptRoot '.runtime\venv'
}
if ($env:CODEX_GATEWAY_STATE_DIR) { $statePath = $env:CODEX_GATEWAY_STATE_DIR }
$runtime = Join-Path $venvPath 'Scripts\python.exe'
$windowlessRuntime = Join-Path $venvPath 'Scripts\pythonw.exe'
