. (Join-Path $PSScriptRoot 'runtime.ps1')
foreach ($name in @('gateway.pid', 'worker-a.pid', 'worker-b.pid')) {
    $pidPath = Join-Path $statePath $name
    if (Test-Path -LiteralPath $pidPath) {
        $taskPid = [int](Get-Content -LiteralPath $pidPath)
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid" -ErrorAction SilentlyContinue
        if ($process.CommandLine -and $process.CommandLine.Contains($PSScriptRoot) -and $process.CommandLine.Contains('gateway.py')) {
            Stop-Process -Id $taskPid -ErrorAction SilentlyContinue
        }
    }
}
