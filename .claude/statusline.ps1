try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $scriptPath = Join-Path $scriptDir "statusline.mjs"
  node $scriptPath
} catch {
  exit 0
}

exit 0
