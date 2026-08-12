$ErrorActionPreference = 'Stop'

if (-not $env:VITE_API_BASE_URL) {
  Write-Warning 'VITE_API_BASE_URL is not set; production frontend will use same-origin /api/v1. Confirm the gateway routes /api/* to the ERP backend before publishing.'
}

$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$webRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'frontend\web'))
$distRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'frontend\dist-web'))
$publicRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'backend\public'))

foreach ($path in @($webRoot, $distRoot, $publicRoot)) {
  if (-not $path.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Build path escaped workspace: $path"
  }
}

Push-Location $webRoot
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

  npm run build -- --outDir ../dist-web --emptyOutDir
  if ($LASTEXITCODE -ne 0) { throw 'frontend build failed' }
} finally {
  Pop-Location
}

Get-ChildItem -LiteralPath $publicRoot -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $distRoot '*') -Destination $publicRoot -Recurse -Force

$indexFile = Join-Path $publicRoot 'index.html'
if (-not (Test-Path -LiteralPath $indexFile -PathType Leaf)) {
  throw "Production index.html was not generated: $indexFile"
}

$indexHtml = Get-Content -Raw -Encoding UTF8 -LiteralPath $indexFile
if ($indexHtml -match '(?:src|href)="\./assets/') {
  throw 'Production index.html contains route-relative assets; expected /assets/.'
}

Write-Host "Production web assets copied to $publicRoot"
