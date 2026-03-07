$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "[BetterFluxer] Building NW bridge zip..."
npm run dist:bridge:win

$zipPath = Join-Path $root "dist\nw-bridge-win64.zip"
if (-not (Test-Path $zipPath)) {
  throw "Bridge zip not found: $zipPath"
}

$wixCmd = Get-Command "wix" -ErrorAction SilentlyContinue
$wixExe = $null
if ($wixCmd) {
  $wixExe = $wixCmd.Source
} else {
  $wixCandidates = @(
    "C:\Program Files\WiX Toolset v6.0\bin\wix.exe",
    "C:\Program Files\WiX Toolset v5.0\bin\wix.exe",
    "C:\Program Files\WiX Toolset v4.0\bin\wix.exe"
  )
  foreach ($candidate in $wixCandidates) {
    if (Test-Path $candidate) {
      $wixExe = $candidate
      break
    }
  }
}
if (-not $wixExe) {
  throw "WiX CLI not found. Install WiX v4+ and ensure 'wix' is on PATH."
}

$pkg = Get-Content (Join-Path $root "package.json") | ConvertFrom-Json
$rawVersion = [string]$pkg.version
if (-not $rawVersion) { $rawVersion = "1.0.0" }

# MSI expects 3-part numeric version.
$version = $rawVersion
if ($version -notmatch "^\d+\.\d+\.\d+$") {
  if ($version -match "^(\d+)\.(\d+)\.(\d+)") {
    $version = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
  } else {
    $version = "1.0.0"
  }
}

$stageDir = Join-Path $env:TEMP "betterfluxer-bridge-msi-stage"
if (Test-Path $stageDir) {
  Remove-Item $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir | Out-Null

Write-Host "[BetterFluxer] Extracting bridge payload..."
Expand-Archive -LiteralPath $zipPath -DestinationPath $stageDir -Force

$wxsPath = Join-Path $root "installer\bridge-msi.wxs"
$msiOut = Join-Path $root ("dist\BetterFluxerBridge-{0}.msi" -f $version)

Write-Host "[BetterFluxer] Building MSI with high compression..."
& $wixExe build `
  $wxsPath `
  -arch x64 `
  -d BridgeSourceDir=$stageDir `
  -d ProductVersion=$version `
  -o $msiOut

if ($LASTEXITCODE -ne 0) {
  throw "WiX build failed with exit code $LASTEXITCODE"
}

Write-Host "[BetterFluxer] MSI created: $msiOut"
