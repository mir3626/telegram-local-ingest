try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $utf8NoBom
  [Console]::OutputEncoding = $utf8NoBom
  $writer = New-Object System.IO.StreamWriter -ArgumentList ([Console]::OpenStandardOutput()), $utf8NoBom
  $writer.AutoFlush = $true
  [Console]::SetOut($writer)
  $root = (Get-Location).Path
  $emojiTarget = [char]::ConvertFromUtf32(0x1F3AF); $emojiThought = [char]::ConvertFromUtf32(0x1F4AD); $emojiWrench = [char]::ConvertFromUtf32(0x1F527)
  $emojiStopwatch = "$([char]::ConvertFromUtf32(0x23F1))$([char]0xFE0F)"; $emojiWarning = "$([char]::ConvertFromUtf32(0x26A0))$([char]0xFE0F)"; $emojiLabel = "$([char]::ConvertFromUtf32(0x1F3F7))$([char]0xFE0F)"

  function Read-JsonOptional([string]$Path) {
    try {
      if (Test-Path $Path) {
        return Get-Content $Path -Raw | ConvertFrom-Json
      }
    } catch {
      return $null
    }

    return $null
  }

  function Read-StatuslineInput() {
    if ($env:VIBE_STATUSLINE_READ_STDIN -ne '1') { return $null }
    try {
      if (-not [Console]::IsInputRedirected) { return $null }
      $raw = [Console]::In.ReadToEnd()
      if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
      return $raw | ConvertFrom-Json
    } catch { return $null }
  }
  function Get-FiniteNumber($Value) {
    try {
      $number = [double]$Value
      if ($null -eq $Value -or [double]::IsNaN($number) -or [double]::IsInfinity($number)) { return 0 }
      return $number
    } catch { return 0 }
  }
  function Get-ClaudeTokens($InputData) {
    $transcriptPath = Get-NonEmptyString $InputData.transcript_path
    if ($null -eq $transcriptPath -or -not (Test-Path -LiteralPath $transcriptPath -PathType Leaf)) {
      return $null
    }

    $total = 0
    foreach ($line in [System.IO.File]::ReadLines($transcriptPath)) {
      if ([string]::IsNullOrWhiteSpace($line)) {
        continue
      }
      try {
        $entry = $line | ConvertFrom-Json
        $usage = if ($entry.message -and $entry.message.usage) { $entry.message.usage } else { $entry.usage }
        if ($null -ne $usage) {
          $total += (Get-FiniteNumber $usage.input_tokens) + (Get-FiniteNumber $usage.output_tokens)
        }
      } catch {
      }
    }
    return $total
  }
  function Get-NonEmptyString($Value) {
    if ($Value -is [string] -and $Value.Trim().Length -gt 0) {
      return $Value.Trim()
    }

    return $null
  }

  function Normalize-Version([string]$Version) {
    return $Version.Trim() -replace "^[vV]", ""
  }

  function Get-VersionParts([string]$Version) {
    $normalized = Normalize-Version $Version
    if ($normalized -notmatch "^\d+(\.\d+)*$") {
      return $null
    }

    return @($normalized.Split(".") | ForEach-Object { [int]$_ })
  }

  function Compare-VersionParts($Left, $Right) {
    $length = [math]::Max($Left.Count, $Right.Count)
    for ($index = 0; $index -lt $length; $index += 1) {
      $leftPart = if ($index -lt $Left.Count) { [int]$Left[$index] } else { 0 }
      $rightPart = if ($index -lt $Right.Count) { [int]$Right[$index] } else { 0 }
      if ($leftPart -ne $rightPart) {
        if ($leftPart -gt $rightPart) {
          return 1
        }

        return -1
      }
    }

    return 0
  }

  function Get-HarnessVersionSuffix([string]$Root) {
    $config = Read-JsonOptional (Join-Path $Root ".vibe/config.json")
    $installedRaw = Get-NonEmptyString $config.harnessVersionInstalled
    if ($null -eq $installedRaw) {
      $installedRaw = Get-NonEmptyString $config.harnessVersion
    }

    $installedParts = if ($null -ne $installedRaw) { Get-VersionParts $installedRaw } else { $null }
    if ($null -eq $installedRaw -or $null -eq $installedParts) {
      return $null
    }

    $installedVersion = Normalize-Version $installedRaw
    $syncCache = Read-JsonOptional (Join-Path $Root ".vibe/sync-cache.json")
    $latestRaw = Get-NonEmptyString $syncCache.latestVersion
    $latestParts = if ($null -ne $latestRaw) { Get-VersionParts $latestRaw } else { $null }
    if ($null -ne $latestRaw -and $null -ne $latestParts -and (Compare-VersionParts $installedParts $latestParts) -lt 0) {
      return "v$installedVersion $([char]0x26A0) v$(Normalize-Version $latestRaw) (/vibe-sync)"
    }

    return "v$installedVersion"
  }

  $statusPath = Join-Path $root ".vibe/agent/sprint-status.json"
  if (-not (Test-Path $statusPath)) {
    exit 0
  }

  $status = Get-Content $statusPath -Raw | ConvertFrom-Json
  $statuslineInput = Read-StatuslineInput
  $claudeTokens = Get-ClaudeTokens $statuslineInput
  $sprints = @($status.sprints)
  $pendingRisks = @($status.pendingRisks)
  $sprintsSinceLastAudit = if ($null -ne $status.sprintsSinceLastAudit) {
    [int]$status.sprintsSinceLastAudit
  } else {
    0
  }
  $currentSprintId = if ($status.handoff -and $status.handoff.currentSprintId) {
    [string]$status.handoff.currentSprintId
  } else {
    "idle"
  }
  $passedCount = @($sprints | Where-Object { $_.status -eq "passed" }).Count
  $totalCount = $sprints.Count
  $openRisks = @($pendingRisks | Where-Object { $_.status -eq "open" }).Count
  $parts = [System.Collections.Generic.List[string]]::new()
  $parts.Add("$emojiTarget $currentSprintId ($passedCount/$totalCount)")
  [void]$sprintsSinceLastAudit
  $tokensPath = Join-Path $root ".vibe/agent/tokens.json"
  if (Test-Path $tokensPath) {
    $tokens = Get-Content $tokensPath -Raw | ConvertFrom-Json
    $elapsedSeconds = if ($null -ne $tokens.elapsedSeconds) { [double]$tokens.elapsedSeconds } else { 0 }
    $cumulativeTokens = if ($null -ne $tokens.cumulativeTokens) { [double]$tokens.cumulativeTokens } else { 0 }
    $parts.Add("$emojiStopwatch $([math]::Round($elapsedSeconds / 60))m")
    if ($null -ne $claudeTokens) {
      $parts.Add("$emojiThought Claude $([math]::Floor($claudeTokens / 1000))K")
    }
    $parts.Add("$emojiWrench Codex $([math]::Floor($cumulativeTokens / 1000))K")
  } elseif ($null -ne $claudeTokens) {
    $parts.Add("$emojiThought Claude $([math]::Floor($claudeTokens / 1000))K")
  }

  $parts.Add("$emojiWarning $openRisks")
  $versionSuffix = Get-HarnessVersionSuffix $root
  if ($null -ne $versionSuffix) {
    $parts.Add("$emojiLabel $versionSuffix")
  }
  [Console]::Out.Write(($parts -join " | "))
} catch {
  exit 0
}

exit 0
