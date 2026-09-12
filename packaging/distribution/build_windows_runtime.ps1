param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\..\.state\distribution\windows-runtime')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = [IO.Path]::GetFullPath($RepoRoot)
$out = [IO.Path]::GetFullPath($OutDir)
$package = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'package.json version missing.' }
$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) { throw "Node >=22 is required to build File Upload Windows runtime; found $nodeVersion." }
if ((& node -p "process.platform").Trim() -ne 'win32' -or (& node -p "process.arch").Trim() -ne 'x64') {
  throw 'File Upload Windows runtime must be built on Windows x64.'
}

Push-Location $repo
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'File Upload TypeScript build failed.' }
} finally { Pop-Location }

if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'package.json') -Destination $out
Copy-Item -LiteralPath (Join-Path $repo 'package-lock.json') -Destination $out
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $out 'node.exe')
Copy-Item -LiteralPath (Join-Path $repo 'dist') -Destination $out -Recurse
New-Item -ItemType Directory -Force -Path (Join-Path $out 'audit') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'audit\rheinagent-file-upload-v1.json') -Destination (Join-Path $out 'audit\rheinagent-file-upload-v1.json')
New-Item -ItemType Directory -Force -Path (Join-Path $out 'packaging\distribution') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'packaging\distribution\activation-contract.json') -Destination (Join-Path $out 'packaging\distribution\activation-contract.json')
[IO.File]::WriteAllText((Join-Path $out '.runtime-version'), "$version`n", [Text.UTF8Encoding]::new($false))

Push-Location $out
try {
  & npm ci --omit=dev --omit=optional --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally { Pop-Location }

$bundledNode = Join-Path $out 'node.exe'
if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf)) { throw 'bundled node.exe is missing.' }
$control = Join-Path $out 'dist\server.js'
$data = Join-Path $out 'dist\dataplane.js'
if (-not (Test-Path -LiteralPath $control -PathType Leaf) -or -not (Test-Path -LiteralPath $data -PathType Leaf)) {
  throw 'File Upload runtime entry points are missing.'
}
$audit = Join-Path $out 'audit\rheinagent-file-upload-v1.json'
if (-not (Test-Path -LiteralPath $audit -PathType Leaf)) { throw 'File Upload Audit profile is missing.' }

$files = Get-ChildItem -LiteralPath $out -Recurse -File
$bytes = ($files | Measure-Object Length -Sum).Sum
$runtimeMeta = [ordered]@{
  schema_version = 1
  product_slug = 'rheinagent-file-upload'
  version = $version
  platform = 'windows-amd64'
  node = $nodeVersion
  files = $files.Count
  expanded_bytes = $bytes
}
$runtimeMetaJson = ($runtimeMeta | ConvertTo-Json -Depth 4) + "`n"
[IO.File]::WriteAllText((Join-Path $out 'RHEINAGENT_NODE_RUNTIME.json'), $runtimeMetaJson, [Text.UTF8Encoding]::new($false))
Write-Output (Join-Path $out 'RHEINAGENT_NODE_RUNTIME.json')