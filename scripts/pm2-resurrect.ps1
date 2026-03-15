param(
  [switch]$ForceStart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$script = Join-Path $PSScriptRoot "service.mjs"
$args = @("resurrect", "--mode", "prod")
if ($ForceStart) {
  $args += "--force-start"
}
& node $script @args
if ($LASTEXITCODE -ne 0) {
  throw "service.mjs failed with exit code $LASTEXITCODE"
}
