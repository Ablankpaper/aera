param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$HarnessRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedHarnessRoot = [System.IO.Path]::GetFullPath($HarnessRoot)
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempPrefix = $tempRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) {
  throw "ProjectRoot must be an existing directory"
}
if (-not $resolvedHarnessRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "HarnessRoot must be a child of the system temporary directory"
}

New-Item -ItemType Directory -Force -Path $resolvedHarnessRoot | Out-Null
$harnessTest = Join-Path $resolvedProjectRoot "scripts/release/windows-model-recovery-harness.test.mjs"
if (-not (Test-Path -LiteralPath $harnessTest -PathType Leaf)) {
  throw "Windows recovery harness test is missing"
}

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @(
  $harnessTest,
  "--run-harness",
  "--root",
  $resolvedHarnessRoot,
  "--force-windows-kill"
)
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$output = @()
$nodeExitCode = 1
try {
  $env:TEMP = $tempRoot
  $env:TMP = $tempRoot
  $output = & $node @arguments 2>&1
  $nodeExitCode = $LASTEXITCODE
} finally {
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
}
if ($nodeExitCode -ne 0) {
  throw "Windows recovery harness failed (exit $nodeExitCode): $($output -join [Environment]::NewLine)"
}

$jsonText = $output -join [Environment]::NewLine
try {
  $evidence = $jsonText | ConvertFrom-Json
} catch {
  throw "Windows recovery harness returned invalid JSON: $jsonText"
}
if ($evidence.ok -ne $true) {
  throw "Windows recovery harness did not report ok=true"
}
if (@($evidence.outcomes).Count -ne 9) {
  throw "Windows recovery harness returned an incomplete stage matrix"
}

$evidencePath = Join-Path $resolvedHarnessRoot "windows-recovery-evidence.json"
$jsonText | Set-Content -LiteralPath $evidencePath -Encoding UTF8
Write-Output $jsonText
