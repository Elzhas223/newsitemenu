param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$ServerScript = Join-Path $Root 'server.ps1'
$DataDir = Join-Path $Root 'data'

if (!(Test-Path -LiteralPath $DataDir)) {
  New-Item -ItemType Directory -Path $DataDir | Out-Null
}

$argumentList = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', "`"$ServerScript`"",
  '-Port', $Port
)

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WorkingDirectory $Root -WindowStyle Hidden -PassThru

Start-Sleep -Milliseconds 700

$url = "http://127.0.0.1:$Port/index.html"
Write-Host "Started Brilliant Menu server"
Write-Host "PID: $($process.Id)"
Write-Host "URL: $url"
