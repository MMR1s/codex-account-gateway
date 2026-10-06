$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
New-Item -ItemType Directory -Path $statePath -Force | Out-Null
$principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $statePath /inheritance:r /grant:r "${principal}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the credential directory.' }
if (-not (Test-Path -LiteralPath $runtime)) {
    & py -3.11 -m venv $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11 with the Windows py launcher, then retry.' }
}
& $runtime -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
Write-Output 'Run Start gateway.ps1, then open http://127.0.0.1:4000/ to connect and verify your accounts.'
