[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$tag = $Tag.Trim()
if ($tag -notmatch '^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$') {
    throw "Invalid release tag/version: $Tag (expected vX.Y.Z or X.Y.Z)"
}

$version = $Matches[1]
$hookRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Set-JsonVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    $json = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $json.version = $Version
    $json | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Set-CargoPackageVersion {
    param(
        [string]$Path,
        [string]$Version
    )

    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $updated = [regex]::Replace(
        $content,
        '(?m)^version\s*=\s*"[^"]+"',
        "version = `"$Version`"",
        1
    )
    if ($updated -eq $content) {
        throw "Failed to update Cargo.toml version in $Path"
    }
    Set-Content -LiteralPath $Path -Value $updated -Encoding utf8 -NoNewline
}

Set-JsonVersion -Path (Join-Path $hookRoot "package.json") -Version $version
Set-JsonVersion -Path (Join-Path $hookRoot "src-tauri\tauri.conf.json") -Version $version
Set-CargoPackageVersion -Path (Join-Path $hookRoot "src-tauri\Cargo.toml") -Version $version

Write-Host "[hook-ci-version] Synced release version to $version (from tag $tag)"
