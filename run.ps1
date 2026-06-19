#!/usr/bin/env pwsh
# WeEdit task runner — one entry point for every way to run the code.
#
# Wraps the npm scripts in package.json (plus a couple of Rust/setup helpers)
# behind short, memorable commands so you don't have to remember which npm
# script maps to "the desktop app" vs "the web build".
#
# Usage
#   ./run.ps1 <command> [extra args passed through to the tool]
#   ./run.ps1 help            # list every command
#   ./run.ps1 list            # same as help
#
# Examples
#   ./run.ps1 dev             # Vite dev server (browser build)
#   ./run.ps1 app             # Tauri desktop app in dev mode
#   ./run.ps1 build           # type-check + production web build
#   ./run.ps1 build:app       # full desktop installer build
#   ./run.ps1 check           # type-check frontend (tsc) + backend (cargo)
#   ./run.ps1 clean           # remove build artifacts (dist, installers, Linux)
#   ./run.ps1 clean -Deep     # ...and cargo clean the Rust target too
#   ./run.ps1 release         # publish Windows + Linux (.deb/.AppImage via WSL)
#   ./run.ps1 release -DryRun # build both without publishing
#   ./run.ps1 release -Push   # push HEAD to origin, then publish
#   ./run.ps1 release:notes   # preview the AI-drafted notes only
#   ./run.ps1 release:notes --past   # notes for the LAST published release
#   ./run.ps1 release:notes --past 2 # notes for the release before that
#   ./run.ps1 release:notes --past --apply  # ...and push them to that release
#   ./run.ps1 release:notes --all           # preview notes for EVERY release
#   ./run.ps1 release:notes --all --apply   # backfill notes onto every release
#   ./run.ps1 dev --port 5000 # extra flags are forwarded to vite
#
# Release notes: `release`/`release:win` auto-draft user-facing notes from the
# commits since the last release using a local Ollama model (default
# llama3.2:latest, override via $env:WEEDIT_OLLAMA_MODEL). Pass -Notes "..." to
# supply your own and skip generation; if ollama is unavailable it silently
# falls back to release.py's default note.
#
# Note: extra args are forwarded verbatim. Don't use a bare `--` separator —
# PowerShell parses it as an (empty) parameter name and errors out.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = 'help',

    # Everything after the command is forwarded verbatim to the underlying tool.
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Always operate from the repo root, regardless of the caller's cwd.
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

# Normalize to an array even when no extra args were supplied.
if ($null -eq $Rest) { $Rest = @() }

function Invoke-Step {
    # NOTE: don't name the array param $Args — it collides with PowerShell's
    # automatic $Args variable and silently won't bind.
    param([string]$Exe, [string[]]$CmdArgs)
    $shown = (@($Exe) + $CmdArgs) -join ' '
    Write-Host "==> $shown" -ForegroundColor Cyan
    & $Exe @CmdArgs
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $shown" }
}

# Remove regenerable build artifacts. All of these are gitignored output that a
# build recreates, so deleting them is safe. -IncludeRust also runs `cargo clean`
# (forces a full Rust recompile next build). Returns the count of paths removed.
# $PSScriptRoot is the repo root (run.ps1 lives there).
function Clear-BuildArtifacts {
    param([switch]$IncludeRust)
    $removed = 0
    $paths = @(
        'dist', 'dist-web', 'dist-ssr', 'dist-linux',          # web + Linux build output
        'src-tauri/target/release/bundle/msi',                  # Windows installers
        'src-tauri/target/release/bundle/nsis',
        'src-tauri/target/release/bundle/latest.json',          # updater manifest
        'tsconfig.tsbuildinfo', 'tsconfig.node.tsbuildinfo'     # tsc -b incremental cache
    )
    foreach ($rel in $paths) {
        $full = Join-Path $PSScriptRoot $rel
        if (Test-Path -LiteralPath $full) {
            Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $full)) {
                Write-Host "   removed $rel" -ForegroundColor DarkGray
                $removed++
            }
        }
    }
    if ($IncludeRust) {
        Write-Host "==> cargo clean (next Rust build is a full recompile)" -ForegroundColor Cyan
        Invoke-Step cargo @('clean', '--manifest-path', 'src-tauri/Cargo.toml')
    }
    return $removed
}

# Load the Tauri updater signing key into the environment for release builds.
# Without it, `tauri build` produces the installers fine but then fails at the
# signing step ("A public key has been found, but no private key").
function Initialize-SigningKey {
    $keyPath = Join-Path $HOME '.tauri/weedit.key'
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        if (Test-Path $keyPath) {
            $env:TAURI_SIGNING_PRIVATE_KEY = [System.IO.File]::ReadAllText((Resolve-Path $keyPath).Path)
            Write-Host "==> Using signing key: $keyPath" -ForegroundColor Cyan
        } else {
            throw "No signing key found. Set `$env:TAURI_SIGNING_PRIVATE_KEY, or place the key at $keyPath."
        }
    }
    # Tauri needs the password var to EXIST even if the key has no password,
    # otherwise it fails with a misleading 'incorrect password' error.
    if (-not (Test-Path Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
    }
}

# Find a Python launcher for scripts/release.py (the Windows+Linux orchestrator).
function Get-PythonExe {
    foreach ($p in 'python', 'py', 'python3') {
        if (Get-Command $p -ErrorAction SilentlyContinue) { return $p }
    }
    throw "Python not found on PATH. Install Python to run scripts/release.py."
}

# Translate the PowerShell-style switches this runner accepts (-DryRun, -Push,
# -Notes) into the flags scripts/release.py expects (--dry-run, --push, --notes).
# Anything else is passed through untouched.
function ConvertTo-ReleaseArgs {
    param([string[]]$In)
    $out = @()
    foreach ($a in $In) {
        switch -Regex ($a) {
            '^-DryRun$' { $out += '--dry-run' }
            '^-Push$'   { $out += '--push' }
            '^-Notes$'  { $out += '--notes' }
            default     { $out += $a }
        }
    }
    return $out
}

# Did the caller already supply their own release notes? If so we don't generate.
function Test-HasNotesArg {
    param([string[]]$In)
    foreach ($a in $In) { if ($a -match '^(-Notes|--notes)$') { return $true } }
    return $false
}

# Run git and return its stdout (trimmed), or $null on non-zero exit. Native
# stderr is discarded WITHOUT aborting the script: redirecting a native command's
# stderr under ErrorActionPreference=Stop in Windows PowerShell 5.1 otherwise
# raises a terminating error (e.g. `git describe` on the very first release,
# whose parent has no prior tag, writes "fatal: No tags can describe ...").
function Get-GitOutput {
    param([Parameter(Mandatory)][string[]]$GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& git @GitArgs 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
        return (($out -join "`n").Trim())
    }
    finally { $ErrorActionPreference = $prev }
}

# The Nth most recent published release tag (0 = latest). $null if out of range.
function Get-ReleaseTag {
    param([int]$Index = 0)
    $tags = @(& git tag --list 'build-*' --sort=-creatordate)
    if ($Index -ge 0 -and $Index -lt $tags.Count) { return $tags[$Index] }
    return $null
}

# Tags of all releases that actually exist on GitHub (newest first). Unlike
# local build-* tags, this skips tags that were never published as releases.
function Get-PublishedReleaseTags {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "gh (GitHub CLI) not found on PATH. Install: https://cli.github.com/"
    }
    $json = (& gh release list --limit 1000 --json tagName 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $json) { return @() }
    return @(($json | ConvertFrom-Json) | ForEach-Object { $_.tagName } | Where-Object { $_ -like 'build-*' })
}

# Generate notes for one published release tag (diffing from its previous
# release, found via `git describe` so non-consecutive tags still work) and,
# with -Apply, push them onto that GitHub release. Returns $true if notes were
# produced. Never throws on an individual release -- bulk callers keep going.
function Update-ReleaseNotes {
    param([Parameter(Mandatory)][string]$Tag, [switch]$Apply)
    $base = Get-GitOutput @('describe', '--tags', '--abbrev=0', '--match', 'build-*', "$Tag^")
    Write-Host "==> Notes for $Tag" -ForegroundColor Cyan
    $notes = New-ReleaseNotes -Since $base -Until $Tag
    if (-not $notes) { Write-Host "   (no user-facing notes for $Tag; skipped)" -ForegroundColor Yellow; return $false }
    Write-Host "`n$notes`n"
    if ($Apply) {
        Invoke-Step gh @('release', 'edit', $Tag, '--notes', $notes)
        Write-Host "==> Updated $Tag on GitHub." -ForegroundColor Green
    }
    return $true
}

# Run a prompt through Ollama and return the completion text. Prefers the local
# HTTP API (non-streaming -> clean text, no terminal control codes), and falls
# back to the `ollama run` CLI (stripping ANSI cursor codes) if the server isn't
# reachable. Returns $null on failure.
function Invoke-Ollama {
    param([Parameter(Mandatory)][string]$Model, [Parameter(Mandatory)][string]$Prompt)
    # 1. HTTP API -- the reliable path. stream=$false returns the whole response
    # in one JSON payload, so there are none of the cursor/rewrap artifacts the
    # CLI emits when it streams to a terminal.
    try {
        $body = @{
            model   = $Model
            prompt  = $Prompt
            stream  = $false
            options = @{ temperature = 0.2 }
        } | ConvertTo-Json -Depth 5
        $resp = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/generate' `
            -Body $body -ContentType 'application/json' -TimeoutSec 600
        if ($resp.response) { return ([string]$resp.response).Trim() }
    }
    catch { }  # server not running / unreachable -> try the CLI
    # 2. CLI fallback. ollama interleaves ANSI cursor codes on a TTY; strip them.
    try {
        $out = ($Prompt | & ollama run $Model)
        $clean = ((($out -join "`n") -replace "\x1B\[[0-?]*[ -/]*[@-~]", '').Trim())
        if ($clean) { return $clean }
    }
    catch { }
    return $null
}

# Clean up small-model output into tidy notes: normalize bullets, strip commit-
# type prefixes and stray sub-headers, drop placeholder/no-op bullets, and remove
# any '### Added/Fixed/Changed' section left with no bullets under it.
function Format-ReleaseNotes {
    param([Parameter(Mandatory)][string]$Text)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($raw in ($Text -split "`r?`n")) {
        $l = $raw.Trim()
        if (-not $l) { $out.Add(''); continue }
        if ($l -match '^#{1,6}\s*(Added|Fixed|Changed)\s*:?\s*$') { $out.Add("### $($Matches[1])"); continue }
        # Bullet, or a stray sub-heading/plain line we coerce into a bullet.
        $item = $l
        if ($item -match '^\s*[\*\-•]\s+(.*)$') { $item = $Matches[1] }
        $item = ($item -replace '^#{1,6}\s*', '').Trim()                       # stray ### inside a bullet
        $item = ($item -replace '^(feat|fix|chore|docs|refactor|build|ci|perf|style|test)(\([^)]*\))?:\s*', '').Trim()  # commit prefix
        if (-not $item) { continue }
        if ($item -match '^[\(\[]?\s*(no\b.*chang|none|n/?a|nothing\b)') { continue }  # placeholder/no-op
        $out.Add("- " + ($item -replace '\s+', ' '))
    }
    # Drop section headers that have no bullet before the next header.
    $kept = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $out.Count; $i++) {
        if ($out[$i] -match '^### ') {
            $has = $false
            for ($j = $i + 1; $j -lt $out.Count -and $out[$j] -notmatch '^### '; $j++) {
                if ($out[$j] -match '^- ') { $has = $true; break }
            }
            if (-not $has) { continue }
        }
        $kept.Add($out[$i])
    }
    return ((($kept -join "`n") -replace "`n{3,}", "`n`n").Trim())
}

# Draft user-facing release notes from the commits since the last release,
# using a local Ollama model. Returns $null on ANY failure (no ollama, no model,
# no new commits, no user-facing changes) so notes generation never blocks a
# release -- release.py just falls back to its default note in that case.
# Pass -Since <ref> to summarize commits since a specific tag/commit, and
# -Until <ref> to set the endpoint (default HEAD; used by --past to regenerate
# notes for a past release). Override the model with $env:WEEDIT_OLLAMA_MODEL.
function New-ReleaseNotes {
    param([string]$Since, [string]$Until = 'HEAD')
    $model = if ($env:WEEDIT_OLLAMA_MODEL) { $env:WEEDIT_OLLAMA_MODEL } else { 'llama3.2:latest' }
    try {
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
            Write-Host "==> ollama not found; falling back to default release notes" -ForegroundColor Yellow
            return $null
        }
        # Determine the commit range base. With -Since, diff against that ref.
        # Otherwise, when summarizing up to HEAD, auto-detect the previous
        # release tag (build-*); if HEAD itself is already tagged (a re-release/
        # resume), look from its parent so we don't diff against HEAD's own tag
        # and get an empty range. First release (no such tag yet) -> last 30.
        if ($Since) {
            $base = $Since
        } elseif ($Until -eq 'HEAD') {
            $describeRef = 'HEAD'
            if (@(& git tag --points-at HEAD --list 'build-*').Count -gt 0) { $describeRef = 'HEAD^' }
            $base = Get-GitOutput @('describe', '--tags', '--abbrev=0', '--match', 'build-*', $describeRef)
        } else {
            $base = $null
        }
        if ($base) {
            $log = (& git log --no-merges --pretty=format:'- %s' "$base..$Until")
        } else {
            $log = (& git log --no-merges -n 30 --pretty=format:'- %s' $Until)
        }
        $baseLabel = if ($base) { $base } else { 'the last release' }
        if (-not $log) {
            Write-Host "==> no new commits since $baseLabel; using default note" -ForegroundColor Yellow
            return $null
        }
        # Drop clearly-internal commits before the model sees them, so build/CI/
        # tooling noise can't leak into user-facing notes. If that leaves nothing,
        # there were no user-facing changes -> caller uses the default note.
        $internal = '(?i)(^- (chore|ci|build|refactor|test|docs|style)(\(|:))|gitignore|github actions|workflow|bump.*version|version.*bump|release\.(ps1|py)|run\.ps1|tauri\.conf|signing key|updater'
        $userLog = @($log | Where-Object { $_ -notmatch $internal })
        if ($userLog.Count -eq 0) {
            Write-Host "==> only internal/tooling commits in that range; using default note" -ForegroundColor Yellow
            return $null
        }
        $log = $userLog
        $commits = ($log -join "`n")
        $rangeLabel = if ($base) { "$base..$Until" } else { "$Until~30..$Until" }
        Write-Host "==> Summarizing $(@($log).Count) commit(s) ($rangeLabel)" -ForegroundColor DarkGray
        $prompt = @"
You write release notes for WeEdit, a desktop video editor for Twitch VODs. The audience is END USERS.
Turn the commit subjects below into short markdown release notes.

Rules:
- Use only these section headers, in this exact order: '### Added', '### Fixed', '### Changed'.
- Under each header, write plain '- ' bullets: one short sentence per change, describing what the user can now see or do.
- OMIT a whole section if it has no items. Never invent content and never write placeholder bullets like "No changes".
- Only include user-facing changes. IGNORE internal/developer commits entirely: build/release scripts, CI or GitHub Actions, version bumps, .gitignore, config files, and pure refactors.
- Do NOT include commit prefixes (feat:, fix:, chore:), commit hashes, file names, or sub-headings (no '####').
- Output ONLY the markdown. No preamble, no explanation, no closing remarks.

Commits:
$commits
"@
        Write-Host "==> Drafting release notes with ollama ($model)..." -ForegroundColor Cyan
        $clean = Invoke-Ollama -Model $model -Prompt $prompt
        if (-not $clean) {
            Write-Host "==> ollama returned no notes; using default" -ForegroundColor Yellow
            return $null
        }
        $clean = Format-ReleaseNotes -Text $clean
        # If the model filtered every commit out (no bullets survived), treat as
        # no user-facing changes.
        if (@($clean -split "`n" | Where-Object { $_ -match '^- ' }).Count -eq 0) {
            Write-Host "==> no user-facing changes in that range; using default note" -ForegroundColor Yellow
            return $null
        }
        return $clean
    }
    catch {
        Write-Host "==> release-notes generation failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

# command name -> description + the action to run. Action receives $Rest.
$Tasks = [ordered]@{
    'install'       = @{ Desc = 'Install npm dependencies';                       Run = { Invoke-Step npm (@('install') + $Rest) } }
    'dev'           = @{ Desc = 'Desktop app + web dev server together (browser at :5173)'; Run = { Invoke-Step npm (@('run','tauri:dev','--') + $Rest) } }
    'app'           = @{ Desc = 'Alias of `dev` - Tauri desktop app, hot reload';          Run = { Invoke-Step npm (@('run','tauri:dev','--') + $Rest) } }
    'web'           = @{ Desc = 'Web only: Vite dev server, no desktop window';            Run = { Invoke-Step npm (@('run','dev','--') + $Rest) } }
    'tauri'         = @{ Desc = 'Raw `tauri` CLI passthrough';                    Run = { Invoke-Step npm (@('run','tauri','--') + $Rest) } }
    'build'         = @{ Desc = 'Type-check + production web build';              Run = { Invoke-Step npm (@('run','build') + $Rest) } }
    'build:web'     = @{ Desc = 'Production build using vite.web.config.ts';      Run = { Invoke-Step npm (@('run','build:web') + $Rest) } }
    'build:app'     = @{ Desc = 'Full desktop installer build';                   Run = { Invoke-Step npm (@('run','tauri:build') + $Rest) } }
    'build:release' = @{ Desc = 'Signed desktop release build';                   Run = { Initialize-SigningKey; Invoke-Step npm (@('run','tauri:build:release') + $Rest) } }
    'preview'       = @{ Desc = 'Preview the production web build locally';       Run = { Invoke-Step npm (@('run','preview','--') + $Rest) } }
    'preview:web'   = @{ Desc = 'Preview the vite.web.config.ts build';           Run = { Invoke-Step npm (@('run','preview:web','--') + $Rest) } }
    'check'         = @{ Desc = 'Type-check frontend (tsc) + backend (cargo)';    Run = {
            Invoke-Step npx (@('tsc','-b'))
            Invoke-Step cargo (@('check','--manifest-path','src-tauri/Cargo.toml') + $Rest)
        } }
    'fetch-binaries'  = @{ Desc = 'Download bundled ffmpeg binaries';             Run = { Invoke-Step npm (@('run','fetch-binaries') + $Rest) } }
    'clean-installers'= @{ Desc = 'Remove stale installer artifacts';            Run = { Invoke-Step npm (@('run','clean-installers') + $Rest) } }
    'clean'           = @{ Desc = 'Remove build artifacts (dist, installers, Linux bundles, tsbuildinfo). -Deep also cargo-cleans'; Run = {
            $deep = [bool](@($Rest) -match '^--?deep$')
            Write-Host "==> Cleaning build artifacts..." -ForegroundColor Cyan
            $n = Clear-BuildArtifacts -IncludeRust:$deep
            Write-Host "==> Done. Removed $n artifact path(s)." -ForegroundColor Green
        } }
    'release'         = @{ Desc = 'Build, sign & publish a release: Windows + Linux (.deb/.AppImage via WSL)'; Run = {
            $relArgs = ConvertTo-ReleaseArgs $Rest
            if (-not (Test-HasNotesArg $Rest)) {
                $notes = New-ReleaseNotes
                if ($notes) { $relArgs += @('--notes', $notes) }
            }
            # Clear stale Linux artifacts so old versions aren't re-uploaded
            # (Windows installers are pruned by clean-installers in the build).
            $distLinux = Join-Path $PSScriptRoot 'dist-linux'
            if (Test-Path -LiteralPath $distLinux) {
                Remove-Item -LiteralPath $distLinux -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "==> cleared old dist-linux artifacts" -ForegroundColor DarkGray
            }
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release-all') + $relArgs)
        } }
    'release:win'     = @{ Desc = 'Windows-only release (skip the Linux build)';   Run = {
            $relArgs = ConvertTo-ReleaseArgs $Rest
            if (-not (Test-HasNotesArg $Rest)) {
                $notes = New-ReleaseNotes
                if ($notes) { $relArgs += @('--notes', $notes) }
            }
            Invoke-Step (Get-PythonExe) (@('scripts/release.py','release') + $relArgs)
        } }
    'release:notes'   = @{ Desc = 'Preview AI notes. Args: <base-ref> | --past [N] | --all [--apply]'; Run = {
            # Parse args:
            #   --past [N]  notes for the Nth-from-latest published release (1=last)
            #   --all       notes for EVERY published GitHub release (backfill)
            #   --apply     push generated notes onto the release(s) via gh
            #   <ref>       (bare) diff base for notes up to HEAD
            $past = $false; $all = $false; $apply = $false; $n = 1; $since = $null
            for ($i = 0; $i -lt @($Rest).Count; $i++) {
                if ($Rest[$i] -match '^--?past$') {
                    $past = $true
                    if (($i + 1) -lt @($Rest).Count -and $Rest[$i + 1] -match '^\d+$') { $n = [int]$Rest[$i + 1]; $i++ }
                } elseif ($Rest[$i] -match '^--?all$') { $all = $true }
                elseif ($Rest[$i] -match '^--?apply$') { $apply = $true }
                elseif (-not $since) { $since = $Rest[$i] }
            }
            if ($apply -and -not ($past -or $all)) {
                throw "--apply needs --past or --all (it updates existing releases). For HEAD, run a real release with ./run.ps1 release."
            }

            if ($all) {
                $tags = Get-PublishedReleaseTags
                if ($tags.Count -eq 0) { Write-Host 'No published releases found.' -ForegroundColor Yellow; return }
                $verb = if ($apply) { 'Updating' } else { 'Previewing' }
                Write-Host "==> $verb notes for $($tags.Count) release(s)..." -ForegroundColor Cyan
                $done = 0; $idx = 0
                foreach ($t in $tags) {
                    $idx++
                    Write-Host "--- [$idx/$($tags.Count)] $t ---" -ForegroundColor DarkGray
                    try {
                        if (Update-ReleaseNotes -Tag $t -Apply:$apply) { $done++ }
                    }
                    catch {
                        Write-Host "   (failed for ${t}: $($_.Exception.Message))" -ForegroundColor Yellow
                    }
                }
                Write-Host "==> Backfill complete: $done/$($tags.Count) release(s) had notes." -ForegroundColor Green
                return
            }

            if ($past) {
                $until = Get-ReleaseTag -Index ($n - 1)
                if (-not $until) { Write-Host "No release tag found $n back." -ForegroundColor Yellow; return }
                [void](Update-ReleaseNotes -Tag $until -Apply:$apply)
                return
            }

            # Default: notes for the next release (since the last one) up to HEAD.
            $notes = New-ReleaseNotes -Since $since
            if ($notes) { Write-Host "`n$notes`n" } else { Write-Host 'No notes generated.' -ForegroundColor Yellow }
        } }
}

function Show-Help {
    Write-Host ''
    Write-Host 'WeEdit task runner' -ForegroundColor Green
    Write-Host '  Usage: ./run.ps1 <command> [extra args forwarded to the tool]'
    Write-Host ''
    Write-Host 'Commands:' -ForegroundColor Green
    $width = ($Tasks.Keys | Measure-Object -Property Length -Maximum).Maximum
    foreach ($name in $Tasks.Keys) {
        $pad = $name.PadRight($width)
        Write-Host ("  {0}  {1}" -f $pad, $Tasks[$name].Desc)
    }
    Write-Host ''
}

switch ($Command.ToLowerInvariant()) {
    { $_ -in @('help', '-h', '--help', '/?', 'list') } { Show-Help; break }
    default {
        if ($Tasks.Contains($Command)) {
            & $Tasks[$Command].Run
        }
        else {
            Write-Host "Unknown command: '$Command'" -ForegroundColor Red
            Show-Help
            exit 1
        }
    }
}
