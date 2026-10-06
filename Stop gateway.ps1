. (Join-Path $PSScriptRoot 'runtime.ps1')
$pidNames = @('gateway.pid') + @(Get-ChildItem -LiteralPath $statePath -Filter 'worker-*.pid' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
foreach ($name in $pidNames) {
    $pidPath = Join-Path $statePath $name
    if (Test-Path -LiteralPath $pidPath) {
        $taskPid = [int](Get-Content -LiteralPath $pidPath)
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid" -ErrorAction SilentlyContinue
        if ($process.CommandLine -and $process.CommandLine.Contains($PSScriptRoot) -and $process.CommandLine.Contains('gateway.py')) {
            Stop-Process -Id $taskPid -ErrorAction SilentlyContinue
        }
    }
}
