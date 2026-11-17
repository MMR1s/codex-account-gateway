$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start gateway.ps1')
for ($browserAttempt = 0; $browserAttempt -lt 30; $browserAttempt++) {
    try {
        $browserResult = Invoke-RestMethod 'http://127.0.0.1:4000/admin/browser/launch' -Method Post -Headers @{'X-Gateway-Admin'='1'} -TimeoutSec 10
        Write-Host $browserResult.message
        return
    } catch { if ($browserAttempt -eq 29) { throw }; Start-Sleep -Milliseconds 500 }
}
