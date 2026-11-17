$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'desktop')
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Browser dependency installation failed.' }
    & node node_modules/electron/install.js
    if ($LASTEXITCODE -ne 0) { throw 'Browser runtime installation failed.' }
} finally { Pop-Location }
Write-Host 'Browser workspace installed. Open Browser in the gateway dashboard.'
