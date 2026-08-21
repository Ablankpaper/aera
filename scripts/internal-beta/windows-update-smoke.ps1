param(
  [Parameter(Mandatory = $true)]
  [string]$AppDirectory,
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [Parameter(Mandatory = $true)]
  [string]$PortablePath,
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [Parameter(Mandatory = $true)]
  [string]$HelperScript,
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  throw "Windows internal-Beta disposable smoke failed: $Message"
}

function Require-Path([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "$Label is missing"
  }
}

function Get-ProcessTreeIds([int]$RootId) {
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $children = @{}
  foreach ($item in $processes) {
    $parentId = [int]$item.ParentProcessId
    if (-not $children.ContainsKey($parentId)) {
      $children[$parentId] = New-Object System.Collections.Generic.List[int]
    }
    [void]$children[$parentId].Add([int]$item.ProcessId)
  }
  $seen = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]
  [void]$queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if (-not $seen.Add($id)) { continue }
    if ($children.ContainsKey($id)) {
      foreach ($child in $children[$id]) { [void]$queue.Enqueue($child) }
    }
  }
  return @($seen)
}

function Stop-ProcessTree([int]$RootId) {
  try {
    $ids = @(Get-ProcessTreeIds $RootId | Sort-Object -Descending)
  } catch {
    $ids = @($RootId)
  }
  foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ExecutableProcesses([string]$ExecutablePath) {
  $expected = [System.IO.Path]::GetFullPath($ExecutablePath)
  $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.ExecutablePath -and
      ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq $expected)
    })
  foreach ($match in $matches) {
    Stop-ProcessTree ([int]$match.ProcessId)
  }
}

function Wait-NoExecutable([string]$ExecutablePath, [int]$TimeoutSeconds) {
  $expected = [System.IO.Path]::GetFullPath($ExecutablePath)
  for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
    $matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and
        ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq $expected)
      })
    if ($matches.Count -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  Fail "launched executable left running processes"
}

function Stop-DisposableApp([int]$RootId, [string]$ExecutablePath) {
  # taskkill /T owns the Windows process-tree boundary. The CIM sweep catches
  # an Electron child that was reparented while the tree was being stopped.
  $taskkill = Start-Process -FilePath "taskkill.exe" -ArgumentList @(
    "/PID", $RootId, "/T", "/F"
  ) -Wait -PassThru -WindowStyle Hidden
  Stop-ProcessTree $RootId
  Stop-ExecutableProcesses $ExecutablePath
  Wait-NoExecutable $ExecutablePath $WaitSeconds
}

function Wait-Executable(
  [string]$ExecutablePath,
  [int]$TimeoutSeconds,
  [int]$RootId
) {
  $expected = [System.IO.Path]::GetFullPath($ExecutablePath)
  for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
    $match = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      ([int]$_.ProcessId -eq $RootId) -and
      $_.ExecutablePath -and
      ([System.IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq $expected)
    } | Select-Object -First 1
    if ($null -ne $match) { return $RootId }
    Start-Sleep -Seconds 1
  }
  Fail "launched root process did not stay running"
}

function Start-DisposableApp([string]$ExecutablePath, [string]$UserDataPath) {
  Stop-ExecutableProcesses $ExecutablePath
  $env:HERMES_DESKTOP_USER_DATA_DIR = $UserDataPath
  New-Item -ItemType Directory -Force -Path $UserDataPath | Out-Null
  $process = Start-Process -FilePath $ExecutablePath -WorkingDirectory (Split-Path -Parent $ExecutablePath) -PassThru -WindowStyle Hidden
  $processId = Wait-Executable $ExecutablePath $WaitSeconds $process.Id
  return $processId
}

function Copy-AppDirectory([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  # Enumerate with -Force so hidden packaged files are not silently dropped.
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Write-InstallJournal(
  [string]$UserDataPath,
  [string]$InstallDirectory,
  [string]$StagedDirectory,
  [string]$BackupDirectory,
  [string]$Version,
  [string]$State = "launched"
) {
  $updateRoot = Join-Path $UserDataPath "desktop-updates"
  New-Item -ItemType Directory -Force -Path (Join-Path $updateRoot "staging") | Out-Null
  $operationId = ([guid]::NewGuid()).ToString()
  $journal = [ordered]@{
    artifact_name = "Aera-Internal-Beta-$Version-windows-x64-app.zip"
    artifact_sha256 = ("0" * 64)
    artifact_sha512 = [Convert]::ToBase64String((New-Object byte[] 64))
    artifact_size = 1
    backup_path = $BackupDirectory
    current_app_path = $InstallDirectory
    failure_marker = (Join-Path $updateRoot "install-failure.json")
    operation_id = $operationId
    platform = "win32"
    rollback_state = "not_started"
    schema_version = 2
    source_version = "0.7.4-internal-beta.29"
    staged_app_path = $StagedDirectory
    state = $State
    success_marker = (Join-Path $updateRoot "install-success-$Version-$PID")
    target_version = $Version
    updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  }
  $journalPath = Join-Path $updateRoot "install-journal.json"
  $json = $journal | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText(
    $journalPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
  return [pscustomobject]@{
    Root = $updateRoot
    JournalPath = $journalPath
    MarkerPath = $journal.success_marker
    FailurePath = $journal.failure_marker
    OperationId = $operationId
  }
}

function Invoke-Helper(
  [string]$HelperSource,
  [int]$OldProcessId,
  [string]$InstallDirectory,
  [string]$StagedDirectory,
  [string]$BackupDirectory,
  [string]$TargetExecutable,
  [string]$MarkerPath,
  [string]$JournalPath,
  [string]$FailurePath,
  [string]$TargetVersion,
  [string]$OperationId,
  [string]$HelperDestination
) {
  Copy-Item -LiteralPath $HelperSource -Destination $HelperDestination -Force
  $arguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $HelperDestination,
    "-ProcessId", $OldProcessId,
    "-InstallDirectory", $InstallDirectory,
    "-StagedDirectory", $StagedDirectory,
    "-BackupDirectory", $BackupDirectory,
    "-TargetExecutable", $TargetExecutable,
    "-MarkerPath", $MarkerPath,
    "-JournalPath", $JournalPath,
    "-FailurePath", $FailurePath,
    "-HelperPath", $HelperDestination,
    "-TargetVersion", $TargetVersion,
    "-OperationId", $OperationId
  )
  $helper = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
  return $helper
}

function Assert-HealthySwap(
  [string]$AppDirectory,
  [string]$Version,
  [string]$RunRoot,
  [string]$HelperSource
) {
  $install = Join-Path $RunRoot "update-installed"
  $staging = Join-Path (Join-Path $RunRoot "success-user-data") "desktop-updates\staging\$Version"
  $userData = Join-Path $RunRoot "success-user-data"
  Copy-AppDirectory $AppDirectory $install
  Copy-AppDirectory $AppDirectory $staging
  Set-Content -LiteralPath (Join-Path $install "smoke-generation.txt") -Value "old" -NoNewline
  Set-Content -LiteralPath (Join-Path $staging "smoke-generation.txt") -Value "new" -NoNewline

  $env:HERMES_DESKTOP_USER_DATA_DIR = $userData
  $oldProcessId = Start-DisposableApp (Join-Path $install "Aera.exe") $userData
  $backup = "$install.aera-update-backup-$PID"
  $journal = Write-InstallJournal $userData $install $staging $backup $Version
  $helperPath = Join-Path $RunRoot "success-helper.ps1"
  $helper = Invoke-Helper $HelperSource $oldProcessId $install $staging $backup (Join-Path $install "Aera.exe") $journal.MarkerPath $journal.JournalPath $journal.FailurePath $Version $journal.OperationId $helperPath
  Stop-DisposableApp $oldProcessId (Join-Path $install "Aera.exe")
  $helper.WaitForExit()
  if ($helper.ExitCode -ne 0) { Fail "healthy update helper exited with $($helper.ExitCode)" }
  if ((Get-Content -LiteralPath (Join-Path $install "smoke-generation.txt") -Raw) -ne "new") { Fail "healthy update did not install staged bytes" }
  if (Test-Path -LiteralPath $backup) { Fail "healthy update left a backup" }
  if (Test-Path -LiteralPath $journal.JournalPath) { Fail "healthy update left a journal" }
  Stop-ExecutableProcesses (Join-Path $install "Aera.exe")
  Wait-NoExecutable (Join-Path $install "Aera.exe") $WaitSeconds
}

function Assert-Rollback(
  [string]$AppDirectory,
  [string]$Version,
  [string]$RunRoot,
  [string]$HelperSource
) {
  $install = Join-Path $RunRoot "rollback-installed"
  $staging = Join-Path (Join-Path $RunRoot "rollback-user-data") "desktop-updates\staging\$Version"
  $userData = Join-Path $RunRoot "rollback-user-data"
  Copy-AppDirectory $AppDirectory $install
  Copy-AppDirectory $AppDirectory $staging
  Set-Content -LiteralPath (Join-Path $install "smoke-generation.txt") -Value "keep" -NoNewline
  # A missing packaged ASAR makes the new process exit before Renderer health.
  Remove-Item -LiteralPath (Join-Path $staging "resources\app.asar") -Force

  $env:HERMES_DESKTOP_USER_DATA_DIR = $userData
  $oldProcessId = Start-DisposableApp (Join-Path $install "Aera.exe") $userData
  $backup = "$install.aera-update-backup-$PID"
  $journal = Write-InstallJournal $userData $install $staging $backup $Version
  $helperPath = Join-Path $RunRoot "rollback-helper.ps1"
  $helper = Invoke-Helper $HelperSource $oldProcessId $install $staging $backup (Join-Path $install "Aera.exe") $journal.MarkerPath $journal.JournalPath $journal.FailurePath $Version $journal.OperationId $helperPath
  Stop-DisposableApp $oldProcessId (Join-Path $install "Aera.exe")
  $helper.WaitForExit()
  if ($helper.ExitCode -eq 0) { Fail "broken candidate unexpectedly succeeded" }
  if ((Get-Content -LiteralPath (Join-Path $install "smoke-generation.txt") -Raw) -ne "keep") { Fail "rollback did not restore the old directory" }
  if (Test-Path -LiteralPath $backup) { Fail "rollback left a backup" }
  Stop-ExecutableProcesses (Join-Path $install "Aera.exe")
  Wait-NoExecutable (Join-Path $install "Aera.exe") $WaitSeconds
}

$originalUserData = $env:HERMES_DESKTOP_USER_DATA_DIR
$temporaryRoot = $env:RUNNER_TEMP
if ([string]::IsNullOrWhiteSpace($temporaryRoot)) {
  $temporaryRoot = $env:TEMP
}
$smokeRoot = Join-Path $temporaryRoot "aera-internal-beta-windows-smoke-$PID"
$smokeStage = "preflight"
try {
  Require-Path $AppDirectory "packaged Windows app directory"
  Require-Path $SetupPath "Windows setup artifact"
  Require-Path $PortablePath "Windows portable artifact"
  Require-Path $HelperScript "compiled Windows helper script"
  New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null

  # Install/start smoke for the NSIS payload on a disposable per-user path.
  $smokeStage = "setup_install"
  $setupInstall = Join-Path $smokeRoot "setup-install"
  $setupResult = Start-Process -FilePath $SetupPath -ArgumentList @("/S", "/D=$setupInstall") -Wait -PassThru -WindowStyle Hidden
  if ($setupResult.ExitCode -ne 0) { Fail "setup installer exited with $($setupResult.ExitCode)" }
  $setupExecutable = Join-Path $setupInstall "Aera.exe"
  Require-Path $setupExecutable "silent setup installation"
  $smokeStage = "setup_start"
  $setupUserData = Join-Path $smokeRoot "setup-user-data"
  $setupProcessId = Start-DisposableApp $setupExecutable $setupUserData
  Stop-DisposableApp $setupProcessId $setupExecutable

  # Start smoke for the portable payload; it must not be used as an updater.
  $smokeStage = "portable_start"
  $portableUserData = Join-Path $smokeRoot "portable-user-data"
  $portableProcessId = Start-DisposableApp $PortablePath $portableUserData
  Stop-DisposableApp $portableProcessId $PortablePath

  # Synthetic candidate swap exercises the same compiled helper used by the app.
  # It is disposable CI evidence, not a substitute for a physical-user upgrade.
  $smokeStage = "healthy_swap"
  Assert-HealthySwap $AppDirectory $Version $smokeRoot $HelperScript
  $smokeStage = "rollback"
  Assert-Rollback $AppDirectory $Version $smokeRoot $HelperScript
  $smokeStage = "complete"
  Write-Host "Windows internal-Beta disposable install/start/update/rollback smoke passed."
} catch {
  [Console]::Error.WriteLine("Windows internal-Beta disposable smoke failed: stage=$smokeStage code=windows_smoke_failed")
  exit 1
} finally {
  if ($null -eq $originalUserData) {
    Remove-Item Env:HERMES_DESKTOP_USER_DATA_DIR -ErrorAction SilentlyContinue
  } else {
    $env:HERMES_DESKTOP_USER_DATA_DIR = $originalUserData
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
