#!/usr/bin/env pwsh
# Push the WeEdit server side to the VM in one go: the signaling/collab server
# (usage counter + TURN credentials), the website, and the browser editor.
#
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-server.ps1
#   ...-File scripts/deploy-server.ps1 -SshHost me@192.168.1.242
#   ...-File scripts/deploy-server.ps1 -WithTurn -TurnHost turn.example.com
#   ...-File scripts/deploy-server.ps1 -SkipWeb      # server only, no web rebuild
#
# What it does
#   1. Builds the browser editor (dist-web/) unless -SkipWeb.
#   2. Packs server/, website/ and dist-web/ into one tarball.
#   3. Copies it to the VM with scp and runs, under sudo:
#        server/deploy/install.sh        (signaling service, nginx :8443)
#        website/deploy/deploy.sh        (landing page + /editor + /api proxy)
#        server/deploy/install-turn.sh   (only with -WithTurn)
#
# You'll be asked for your SSH login and then the sudo password on the VM —
# this script never stores or passes either.

[CmdletBinding()]
param(
    [string]$SshHost = "192.168.1.242",
    [switch]$SkipWeb,
    [switch]$WithTurn,
    [string]$TurnHost = "turn.minecartchris.cc"
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

foreach ($cmd in 'ssh', 'scp', 'tar', 'node') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' not found on PATH." }
}

# --- 1. Build the browser editor -------------------------------------------
# Node can't resolve packages through a UNC path, so build from a temporary
# drive letter when the repo lives on a network share (same as release.ps1).
$mapped = $null
try {
    if (-not $SkipWeb) {
        $buildRoot = $RepoRoot
        $real = (& node -p "require('fs').realpathSync(process.cwd())").Trim()
        if ($real -like '\\*') {
            if ($real -notmatch '^(\\\\[^\\]+\\[^\\]+)(\\.*)?$') { throw "Can't parse UNC path $real" }
            $share = $Matches[1]; $sub = $Matches[2]
            $letter = 68..90 | ForEach-Object { [char]$_ } | Where-Object { -not (Test-Path "${_}:\") } | Select-Object -First 1
            & net use "${letter}:" $share /persistent:no | Out-Null
            $mapped = "${letter}:"
            $buildRoot = "${letter}:$sub"
        }
        Write-Host "==> Building the browser editor (dist-web/)" -ForegroundColor Cyan
        Push-Location $buildRoot
        try {
            & node node_modules/typescript/bin/tsc -b
            if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
            & node node_modules/vite/bin/vite.js build --config vite.web.config.ts
            if ($LASTEXITCODE -ne 0) { throw "web build failed" }
        } finally { Pop-Location }
    }
    if (-not (Test-Path (Join-Path $RepoRoot 'dist-web/index.html'))) {
        throw "dist-web/ is missing. Run without -SkipWeb to build it."
    }

    # --- 2. Pack -------------------------------------------------------------
    $tar = Join-Path ([IO.Path]::GetTempPath()) "weedit-deploy.tar"
    Write-Host "==> Packing server/, website/, dist-web/" -ForegroundColor Cyan
    & tar -cf $tar --exclude=node_modules --exclude=data server website dist-web
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }

    # --- 3. Copy + install on the VM ----------------------------------------
    Write-Host "==> Copying to $SshHost" -ForegroundColor Cyan
    & scp $tar "${SshHost}:/tmp/weedit-deploy.tar"
    if ($LASTEXITCODE -ne 0) { throw "scp failed" }

    $turnStep = if ($WithTurn) { "&& TURN_HOST='$TurnHost' bash server/deploy/install-turn.sh" } else { "" }
    # Scripts may have Windows line endings after a checkout on Windows.
    $remote = "set -e; rm -rf /tmp/weedit-deploy && mkdir -p /tmp/weedit-deploy && cd /tmp/weedit-deploy && tar -xf /tmp/weedit-deploy.tar && find . -name '*.sh' -exec sed -i 's/\r$//' {} + && (cd server && bash deploy/install.sh) && bash website/deploy/deploy.sh $turnStep && curl -s http://127.0.0.1:4444/health && echo && curl -s http://127.0.0.1:4444/api/stats && echo"
    Write-Host "==> Installing on $SshHost (enter the sudo password when asked)" -ForegroundColor Cyan
    & ssh -t $SshHost "sudo bash -c `"$remote`""
    if ($LASTEXITCODE -ne 0) { throw "remote install failed" }

    Write-Host "==> Deployed." -ForegroundColor Green
}
finally {
    if ($mapped) { & net use $mapped /delete /y *> $null }
}
