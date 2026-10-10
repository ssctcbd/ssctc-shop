# Build the two zip files that are uploaded to cPanel. Changes nothing on the server.
#
#   powershell -File scripts\package-release.ps1            build the site, then package
#   powershell -File scripts\package-release.ps1 -SkipBuild package the existing web\out
#
# Output (in release\, which Git ignores):
#   ssctc-shop-web.zip   contents of web\out          -> extract in the subdomain's document root
#   ssctc-shop-api.zip   api\ without node_modules,   -> extract in the Node.js application root
#                        .env and tests
#
# Uses tar.exe (included in Windows 10 and later) rather than Compress-Archive:
# Windows PowerShell 5.1 writes zip entries with backslashes, which a Linux
# server extracts as files literally named "src\app.js".
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'release'

if (-not $SkipBuild) {
    Push-Location (Join-Path $root 'web')
    try {
        # A production build must call the API on the same origin, so no API URL override.
        Remove-Item Env:NEXT_PUBLIC_API_URL -ErrorAction SilentlyContinue
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'web build failed' }
    } finally { Pop-Location }
}

$out = Join-Path $root 'web\out'
if (-not (Test-Path (Join-Path $out 'index.html'))) { throw 'web\out not found. Run without -SkipBuild.' }
if (Select-String -Path (Join-Path $out '_next\static\chunks\*.js') -Pattern 'localhost:4000' -List -ErrorAction SilentlyContinue) {
    throw 'web\out was built with the local development API address. Remove web\.env*.local or run without -SkipBuild.'
}

New-Item -ItemType Directory -Force $release | Out-Null
$webZip = Join-Path $release 'ssctc-shop-web.zip'
$apiZip = Join-Path $release 'ssctc-shop-api.zip'
Remove-Item $webZip, $apiZip -ErrorAction SilentlyContinue

tar.exe -a -c -f $webZip -C $out .
if ($LASTEXITCODE -ne 0) { throw 'packaging web failed' }

tar.exe -a -c -f $apiZip --exclude 'node_modules' --exclude '.env' --exclude '.env.*' --exclude 'tests' -C (Join-Path $root 'api') .
if ($LASTEXITCODE -ne 0) { throw 'packaging api failed' }

Get-Item $webZip, $apiZip | ForEach-Object { '{0,-24} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB) }
'Migrations in this release:'
Get-ChildItem (Join-Path $root 'api\migrations') -Filter *.sql | ForEach-Object { '  ' + $_.Name }
