$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$scriptPath = Join-Path $PSScriptRoot 'gateway.py'
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:4000/health' -TimeoutSec 2
    if ($health.service -eq 'dual-account-local') { return }
    throw 'Port 4000 is already used by another service.'
} catch {
    if ($_.Exception.Message -like '*already used*') { throw }
}
New-Item -ItemType Directory -Path $statePath -Force | Out-Null
Start-Process -FilePath $windowlessRuntime -ArgumentList @(('"' + $scriptPath + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
