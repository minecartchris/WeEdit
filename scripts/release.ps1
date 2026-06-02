#!/usr/bin/env pwsh
# Build, sign, and publish a WeEdit release to GitHub from your machine.
#
# This does locally what .github/workflows/release.yml does in CI: derives a
# monotonic version from the git commit count, builds the signed installer +
# updater artifacts, writes latest.json, and publishes a GitHub Release tagged
# by commit hash. Existing installs auto-update from the "latest" release.
#
# Prerequisites
#   - GitHub CLI installed and authenticated:         gh auth login
#   - Node deps installed once:                        npm install
#   - Your minisign PRIVATE key in an env var so the updater artifacts get
#     signed (the matching public key is already in src-tauri/tauri.conf.json):
#         $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content path\to\weedit.key -Raw
#     If the key has a password, also set:
#         $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "..."
#
# Usage
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1
#   ...-File scripts/release.ps1 -DryRun     # build + sign only, don't publish
#   ...-File scripts/release.ps1 -Push       # push HEAD to its remote first
#
# Note: a release tag must point at a commit that exists on GitHub. If HEAD
# isn't pushed yet, pass -Push (or push it yourself first). Be aware that
# pushing to main ALSO triggers the CI release for the same commit -- use this
# script for commits you are NOT pushing to main, or rely on CI for ones you are.

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Push,
    [string]$Notes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Run from the repo root regardless of where the script was invoked from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Assert-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' not found on PATH. $Hint"
    }
}

# --- 1. Preconditions -----------------------------------------------------
Assert-Command git  "Install Git."
Assert-Command node "Install Node.js."
Assert-Command npm  "Install Node.js."
Assert-Command gh   "Install the GitHub CLI: https://cli.github.com/"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "TAURI_SIGNING_PRIVATE_KEY is not set. Set it to your minisign private key (file contents or a path) so the update artifacts are signed."
}

& gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw "GitHub CLI is not authenticated. Run: gh auth login" }

$repo = (& gh repo view --json nameWithOwner -q .nameWithOwner).Trim()
if (-not $repo) { throw "Could not determine the GitHub repo from 'gh repo view'." }

# --- 2. Derive version + tag (same scheme as CI) --------------------------
$confPath = Join-Path $RepoRoot 'src-tauri/tauri.conf.json'
$base     = (& node -p "require('./src-tauri/tauri.conf.json').version.split('.').slice(0,2).join('.')").Trim()
$count    = (& git rev-list --count HEAD).Trim()
$version  = "$base.$count"
$shortSha = (& git rev-parse --short HEAD).Trim()
$fullSha  = (& git rev-parse HEAD).Trim()
$tag = "build-$shortSha"
if (-not $Notes) { $Notes = "Automated build of commit $shortSha." }

Write-Host "==> Releasing $version (tag $tag, commit $shortSha) to $repo" -ForegroundColor Cyan

# --- 3. Make sure the commit exists on the remote (tags must reference it) -
if ($Push) {
    Write-Host "==> Pushing HEAD to origin" -ForegroundColor Cyan
    & git push origin HEAD
    if ($LASTEXITCODE -ne 0) { throw "git push failed." }
} else {
    $onRemote = (& git branch -r --contains HEAD) -join ''
    if (-not $onRemote.Trim()) {
        throw "This commit isn't on the remote yet, so GitHub can't tag it. Push it first (git push origin HEAD) or re-run with -Push. Pushing main also triggers the CI release."
    }
}

# --- 4. Inject the derived version, build + sign, then restore the config -
# We patch the version in tauri.conf.json the same way CI does, build, then put
# the original file back so the working tree stays clean.
$confBackup = [System.IO.File]::ReadAllText($confPath)
try {
    & node -e "const f='./src-tauri/tauri.conf.json';const fs=require('fs');const c=JSON.parse(fs.readFileSync(f));c.version='$version';fs.writeFileSync(f, JSON.stringify(c,null,2)+'\n')"
    if ($LASTEXITCODE -ne 0) { throw "Failed to patch version into tauri.conf.json." }

    Write-Host "==> Building signed release (this takes a while)" -ForegroundColor Cyan
    & npm run tauri:build:release
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }
}
finally {
    [System.IO.File]::WriteAllText($confPath, $confBackup)
}

# --- 5. Locate the signed artifacts + build latest.json -------------------
$bundleDir = Join-Path $RepoRoot 'src-tauri/target/release/bundle'
$sigFiles = @(Get-ChildItem -Path $bundleDir -Recurse -Filter *.sig -ErrorAction SilentlyContinue)
if ($sigFiles.Count -eq 0) {
    throw "No .sig files found under $bundleDir. Signing did not run -- check TAURI_SIGNING_PRIVATE_KEY and that the release config set createUpdaterArtifacts."
}

# Prefer the NSIS setup installer as the update artifact when present.
$updaterSig = $sigFiles | Where-Object { $_.Name -like '*setup.exe.sig' } | Select-Object -First 1
if (-not $updaterSig) { $updaterSig = $sigFiles | Select-Object -First 1 }

$updaterArtifact = Get-Item ($updaterSig.FullName -replace '\.sig$', '')
$signature = ([System.IO.File]::ReadAllText($updaterSig.FullName)).Trim()
$artifactUrl = "https://github.com/$repo/releases/download/$tag/$($updaterArtifact.Name)"

$latest = [ordered]@{
    version   = $version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $artifactUrl
        }
    }
}
$latestPath = Join-Path $bundleDir 'latest.json'
[System.IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 10))

# Assets: the installer (serves both humans and the updater), the .msi if built,
# and latest.json (the updater endpoint reads this from the "latest" release).
$assets = New-Object System.Collections.Generic.List[string]
$assets.Add($updaterArtifact.FullName)
$msi = Get-ChildItem -Path $bundleDir -Recurse -Filter *.msi -ErrorAction SilentlyContinue | Select-Object -First 1
if ($msi) { $assets.Add($msi.FullName) }
$assets.Add($latestPath)

Write-Host "==> Artifacts:" -ForegroundColor Cyan
$assets | ForEach-Object { Write-Host "    $_" }

if ($DryRun) {
    Write-Host "==> Dry run: built + signed, latest.json written. Not publishing." -ForegroundColor Yellow
    exit 0
}

# --- 6. Publish to GitHub -------------------------------------------------
& gh release view $tag *> $null
$releaseExists = ($LASTEXITCODE -eq 0)

if ($releaseExists) {
    Write-Host "==> Release $tag exists -- uploading assets (clobbering)" -ForegroundColor Cyan
    & gh release upload $tag $assets.ToArray() --clobber
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed." }
} else {
    Write-Host "==> Creating release $tag" -ForegroundColor Cyan
    & gh release create $tag $assets.ToArray() `
        --title "WeEdit $version ($shortSha)" `
        --notes $Notes `
        --target $fullSha
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed." }
}

Write-Host "==> Done. Released $version at https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
