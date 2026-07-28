$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceDir = Split-Path -Parent $projectDir
$sourceFile = Join-Path $projectDir 'ApiHeartbeat.cs'
$outputFile = Join-Path $workspaceDir ('ANY-ERP-Heartbeat-build-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.exe')
$tempExeFile = Join-Path $workspaceDir 'ANY-ERP-Heartbeat.tmp.exe'
$configFile = Join-Path $projectDir 'heartbeat.config'
$cscCandidates = @(
    'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
    'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $csc) {
    throw 'C# compiler csc.exe was not found.'
}

$previousLocation = Get-Location
Set-Location $workspaceDir
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /out:$tempExeFile $sourceFile
$compileExitCode = $LASTEXITCODE
Set-Location $previousLocation
if ($compileExitCode -ne 0) {
    throw "Compilation failed with exit code: $compileExitCode"
}

[System.IO.File]::Copy($tempExeFile, $outputFile, $false)
Remove-Item -LiteralPath $tempExeFile -Force
Write-Host "Built: $outputFile"
Write-Host "Copy heartbeat.config next to the EXE before running it."
