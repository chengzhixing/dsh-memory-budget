#Requires -Version 5.1
<#
  Install dsh-memory-budget into a DSH profile.

  Does two things, idempotently:
    1. copy this package into <profile>\node_modules\dsh-memory-budget
    2. append a `- insert:` block to <profile>\cordis.patch.yml (skipped if present)

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Profile web
#>
param(
  [string]$Profile = "desktop",
  [string]$Source = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path $profileDir)) { throw "profile not found: $profileDir" }

$target = Join-Path $profileDir "node_modules\dsh-memory-budget"

Write-Host "[1/3] copying package -> $target"
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in @("lib", "test", "package.json", "cordis.patch.yml", "README.md")) {
  $src = Join-Path $Source $item
  if (Test-Path $src) { Copy-Item -LiteralPath $src -Destination $target -Recurse -Force }
}

Write-Host "[2/3] registering in cordis.patch.yml"
$patch = Join-Path $profileDir "cordis.patch.yml"
$text = if (Test-Path $patch) { Get-Content -LiteralPath $patch -Raw } else { "" }

# When the profile lists dsh-memory-budget in dsh.profile.bundles, the package's own
# cordis.patch.yml already inserts the "memory" entry; adding an insert block
# here would insert the same id twice and break the composition.
$asBundle = $false
$manifestPath = Join-Path $profileDir "package.json"
if (Test-Path $manifestPath) {
  try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $manifest = $null }
  if ($manifest -and $manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $asBundle = @($manifest.dsh.profile.bundles) -contains "dsh-memory-budget"
  }
}

if ($asBundle) {
  Write-Host "      listed in dsh.profile.bundles, bundle patch supplies the entry; skipped"
} elseif ($text -match '(?m)^\s*-\s*id:\s*memory\s*$') {
  Write-Host "      already registered, skipped"
} else {
  $block = @"

# dsh-memory-budget (added by install.ps1)
- insert:
    - id: memory
      name: dsh-memory-budget
      inject: [tools]
      config:
        memoryCharLimit: 4000
        userCharLimit: 1500
        promptOrder: 120
        refreshOnWrite: true
"@
  Add-Content -LiteralPath $patch -Value $block -Encoding UTF8
  Write-Host "      appended insert block"
}

Write-Host "[3/3] done. Restart DSH, then check for the 'memory' tool and a '## 长期记忆' prompt section."
Write-Host "      memories dir: $(Join-Path $env:USERPROFILE '.dsh\memories')"
