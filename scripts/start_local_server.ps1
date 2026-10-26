

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$frontendPath = Join-Path $projectPath 'frontend'
$vitePath = Join-Path $frontendPath 'node_modules\vite\bin\vite.js'
$serverUrl = 'http://127.0.0.1:5173/'

function Test-AppReady {
    try {
        $page = Invoke-WebRequest -Uri $serverUrl -UseBasicParsing -TimeoutSec 2
        $entry = Invoke-WebRequest -Uri ($serverUrl + 'src/main.tsx') -UseBasicParsing -TimeoutSec 2
        return (
            $page.StatusCode -eq 200 -and
            $page.Content.Contains('/src/main.tsx') -and
            $entry.StatusCode -eq 200
        )
    } catch {
        return $false
    }
}

if (Test-AppReady) {
    Write-Output "Already running: $serverUrl"
    exit 0
}

$listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw 'Port 5173 is occupied but the app is not responding. Close that server before retrying.'
}
if (-not (Test-Path -LiteralPath $vitePath)) {
    throw 'Frontend dependencies are missing. Run npm ci in frontend first.'
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
$logPath = Join-Path $projectPath '.local-server'
New-Item -ItemType Directory -Path $logPath -Force | Out-Null
$outputLog = Join-Path $logPath 'vite.log'
$errorLog = Join-Path $logPath 'vite.error.log'


$serverProcess = Start-Process -FilePath $nodePath `
    -ArgumentList @(
        ('"' + $vitePath + '"'),
        '--host',
        '127.0.0.1',
        '--port',
        '5173',
        '--strictPort'
    ) `
    -WorkingDirectory $frontendPath -WindowStyle Hidden `
    -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru

$timer = [System.Diagnostics.Stopwatch]::StartNew()
while ($timer.Elapsed.TotalSeconds -lt 30) {
    if (Test-AppReady) {
        Write-Output "Ready: $serverUrl"
        Write-Output "Process: $($serverProcess.Id)"
        Write-Output "Logs: $logPath"
        exit 0
    }
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) {
        Get-Content -LiteralPath $errorLog -Tail 12
        throw "Vite exited. See $errorLog"
    }
    Start-Sleep -Milliseconds 300
}

throw "The app did not respond within 30 seconds. See $outputLog and $errorLog"
