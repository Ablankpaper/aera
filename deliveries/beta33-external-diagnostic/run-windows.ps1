param(
  [string]$App,
  [string]$Target,
  [string]$Output,
  [string]$HermesHome,
  [string]$UserData,
  [ValidateSet("external", "internal")]
  [string]$Mode = "external",
  [ValidateRange(10, 1800)]
  [int]$TimeoutSeconds = 900,
  [switch]$NoLaunch,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($SelfTest) {
  $sumsPath = Join-Path $scriptDir "SHASUMS.txt"
  if (-not (Test-Path -LiteralPath $sumsPath -PathType Leaf)) {
    throw "Collector checksum inventory is missing"
  }
  foreach ($line in Get-Content -LiteralPath $sumsPath) {
    if ($line -notmatch '^([0-9a-fA-F]{64})  ([A-Za-z0-9._-]+)$') {
      throw "Collector checksum inventory is invalid"
    }
    $expected = $Matches[1].ToLowerInvariant()
    $file = Join-Path $scriptDir $Matches[2]
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "Collector file is missing"
    }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Collector integrity check failed" }
  }
  Write-Output "Aera Windows collector self-test passed"
  exit 0
}

function Resolve-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [switch]$MustExist
  )
  try {
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
  } catch {
    $resolved = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Value))
  }
  if (-not [System.IO.Path]::IsPathRooted($resolved)) {
    throw "Path must be absolute: $Value"
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $resolved)) {
    throw "Path does not exist: $resolved"
  }
  return $resolved
}

if (-not $App) { throw "Provide -App C:\\Program Files\\Aera\\Aera.exe" }
$appPath = Resolve-AbsolutePath -Value $App -MustExist
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
  throw "Aera executable was not found: $appPath"
}

$collectorScript = Join-Path $scriptDir "aera-diagnostic.mjs"
$collectorArgs = @("--platform", "windows", "--app", $appPath, "--mode", $Mode, "--timeout-seconds", [string]$TimeoutSeconds)
if ($Target) {
  $collectorArgs += @("--target", (Resolve-AbsolutePath -Value $Target -MustExist))
}
if ($Output) {
  $collectorArgs += @("--output", (Resolve-AbsolutePath -Value $Output))
}
if ($HermesHome) {
  $collectorArgs += @("--hermes-home", (Resolve-AbsolutePath -Value $HermesHome))
}
if ($UserData) {
  $collectorArgs += @("--user-data", (Resolve-AbsolutePath -Value $UserData))
}
if ($NoLaunch) { $collectorArgs += "--no-launch" }

$hadRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$exitCode = 1
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  & $appPath $collectorScript @collectorArgs
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
} finally {
  if ($hadRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
  else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}
exit $exitCode
