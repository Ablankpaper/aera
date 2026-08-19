param(
  [Parameter(Mandatory = $true)][string]$DistDirectory,
  [Parameter(Mandatory = $true)][string]$RuntimeSeedReference,
  [Parameter(Mandatory = $true)][string]$RuntimeSeedManifest,
  [Parameter(Mandatory = $true)][string]$DesktopVersion,
  [Parameter(Mandatory = $true)][string]$Output,
  [Parameter(Mandatory = $false)]
  [ValidateSet("authenticode", "unsigned_internal_beta")]
  [string]$SigningMode = "authenticode",
  [Parameter(Mandatory = $false)][string]$SetupArtifactName = "",
  [Parameter(Mandatory = $false)][string]$PortableArtifactName = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-ArtifactHash([System.IO.FileInfo]$File) {
  return [ordered]@{
    size = $File.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $File.FullName).Hash.ToLowerInvariant()
    sha512 = (Get-FileHash -Algorithm SHA512 -LiteralPath $File.FullName).Hash.ToLowerInvariant()
  }
}

function Assert-X64PE([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw "PE file has no MZ header: $Path" }
    $stream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
      throw "PE header offset is invalid: $Path"
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE signature is invalid: $Path" }
    if ($reader.ReadUInt16() -ne 0x8664) { throw "PE machine is not x64: $Path" }
  }
  finally {
    $stream.Dispose()
  }
}

function Verify-RuntimeSeed([string]$Directory, [string]$Reference) {
  & node scripts/verify-packaged-runtime-seed.mjs $Directory `
    --reference-dir $Reference --desktop-version $DesktopVersion
  if ($LASTEXITCODE -ne 0) { throw "Runtime Seed verification failed: $Directory" }
}

function Find-ExtractedSeed([string]$Root) {
  $seed = Get-ChildItem $Root -Directory -Recurse -Filter "agentera-runtime-seed" |
    Select-Object -First 1
  if (-not $seed) {
    foreach ($nested in @(Get-ChildItem $Root -File -Recurse -Filter "*.7z")) {
      $nestedRoot = "$($nested.FullName).unpacked"
      New-Item -ItemType Directory -Path $nestedRoot | Out-Null
      & 7z x -y "-o$nestedRoot" $nested.FullName | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "7z could not inspect $($nested.Name)" }
    }
    $seed = Get-ChildItem $Root -Directory -Recurse -Filter "agentera-runtime-seed" |
      Select-Object -First 1
  }
  if (-not $seed) { throw "Runtime Seed is missing from extracted Windows artifact" }
  return $seed.FullName
}

$dist = (Resolve-Path $DistDirectory).Path
$reference = (Resolve-Path $RuntimeSeedReference).Path
$manifest = Get-Item (Resolve-Path $RuntimeSeedManifest).Path

function Resolve-ArtifactFile(
  [string]$ProvidedName,
  [string]$DefaultName,
  [string]$Label
) {
  $name = if ([string]::IsNullOrWhiteSpace($ProvidedName)) {
    $DefaultName
  }
  else {
    $ProvidedName
  }
  if ([System.IO.Path]::GetFileName($name) -ne $name) {
    throw "$Label artifact name must be a filename"
  }
  $path = Join-Path $dist $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$Label artifact is missing: $name"
  }
  return (Get-Item -LiteralPath $path)
}
$setup = Resolve-ArtifactFile `
  $SetupArtifactName "Aera-$DesktopVersion-setup.exe" "Windows setup"
$portable = Resolve-ArtifactFile `
  $PortableArtifactName "Aera-$DesktopVersion-portable.exe" "Windows portable"
$artifacts = @(
  [ordered]@{ file = $setup; kind = "windows_setup" },
  [ordered]@{ file = $portable; kind = "windows_portable" }
)

$signerSubject = $null
$signerThumbprint = $null
$verifiedNames = @()
$timestampedNames = @()
$unsignedNames = @()
foreach ($item in $artifacts) {
  $file = $item.file
  Assert-X64PE $file.FullName
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($SigningMode -eq "authenticode") {
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "Authenticode is not valid for $($file.Name): $($signature.Status)"
    }
    if (-not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
      throw "Authenticode signer or trusted timestamp is missing for $($file.Name)"
    }
    if ($null -eq $signerSubject) {
      $signerSubject = $signature.SignerCertificate.Subject
      $signerThumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    }
    elseif (
      $signerSubject -ne $signature.SignerCertificate.Subject -or
      $signerThumbprint -ne $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
    ) {
      throw "Windows artifacts use different Authenticode identities"
    }
    & signtool verify /pa /all /v $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "signtool rejected $($file.Name)" }
    & signtool verify /pa /all /tw /v $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "signtool timestamp verification rejected $($file.Name)" }
    $verifiedNames += $file.Name
    $timestampedNames += $file.Name
  }
  else {
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
      throw "Unsigned internal-Beta artifact has unexpected Authenticode status for $($file.Name): $($signature.Status)"
    }
    if ($signature.SignerCertificate -or $signature.TimeStamperCertificate) {
      throw "Unsigned internal-Beta artifact contains signer metadata: $($file.Name)"
    }
    $unsignedNames += $file.Name
  }
}

$unpackedSeed = Join-Path $dist "win-unpacked/resources/agentera-runtime-seed"
Verify-RuntimeSeed $unpackedSeed $reference
$nativeModule = Join-Path $dist "win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
Assert-X64PE $nativeModule

$runtimeVerified = @()
foreach ($item in $artifacts) {
  $extractRoot = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $extractRoot | Out-Null
  try {
    & 7z x -y "-o$extractRoot" $item.file.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z could not inspect $($item.file.Name)" }
    Verify-RuntimeSeed (Find-ExtractedSeed $extractRoot) $reference
    $runtimeVerified += $item.file.Name
  }
  finally {
    Remove-Item $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$artifactEvidence = @()
foreach ($item in $artifacts) {
  $hash = Get-ArtifactHash $item.file
  $artifactEvidence += [ordered]@{
    name = $item.file.Name
    platform = "windows"
    arch = "x64"
    kind = $item.kind
    size = $hash.size
    sha256 = $hash.sha256
    sha512 = $hash.sha512
  }
}

$runtimeSeedManifest = [ordered]@{
  manifest = $manifest.Name
  manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifest.FullName).Hash.ToLowerInvariant()
}
if ($SigningMode -eq "authenticode") {
  $evidence = [ordered]@{
    arch = "x64"
    signerSubject = $signerSubject
    signerThumbprint = $signerThumbprint
    authenticodeVerifiedArtifacts = @($verifiedNames)
    timestampVerifiedArtifacts = @($timestampedNames)
    runtimeSeedVerifiedArtifacts = @($runtimeVerified)
    nativeModuleArchitecture = "x64"
    runtimeSeedManifest = $runtimeSeedManifest
    artifacts = @($artifactEvidence)
  }
}
else {
  $evidence = [ordered]@{
    arch = "x64"
    signingMode = "unsigned_internal_beta"
    unsignedVerifiedArtifacts = @($unsignedNames)
    runtimeSeedVerifiedArtifacts = @($runtimeVerified)
    nativeModuleArchitecture = "x64"
    runtimeSeedManifest = $runtimeSeedManifest
    artifacts = @($artifactEvidence)
  }
}

$parent = Split-Path -Parent $Output
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
if (Test-Path $Output) { throw "Windows evidence output already exists" }
$json = $evidence | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($Output, "$json`n", [System.Text.UTF8Encoding]::new($false))
if ($SigningMode -eq "authenticode") {
  Write-Output "Windows Authenticode, timestamp, x64, and Runtime Seed verification passed"
}
else {
  Write-Output "Windows unsigned internal-Beta, x64, and Runtime Seed verification passed"
}
