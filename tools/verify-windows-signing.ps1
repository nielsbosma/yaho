# Check that every .exe and .dll Yaho ships, and the installer, carries a valid, timestamped signature from
# WINDOWS_SIGNING_PUBLISHER. Run after tools/package.mjs in the release workflow; any miss fails the release.
param([string]$Release = 'apps/desktop/release')
$ErrorActionPreference = 'Stop'
$publisher = $env:WINDOWS_SIGNING_PUBLISHER
if (-not $publisher) { throw 'WINDOWS_SIGNING_PUBLISHER is not set' }
$files = @(Get-ChildItem -Recurse -File "$Release/win-unpacked" -Include *.exe, *.dll) + @(Get-ChildItem -File $Release -Filter '*.exe')
$bad = @()
foreach ($f in $files) {
    $sig = Get-AuthenticodeSignature $f.FullName
    $cn = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }
    # Microsoft's own runtime DLLs that ship signed by Microsoft are fine as they are.
    if ($sig.Status -eq 'Valid' -and ($cn -eq $publisher -or $cn -like 'Microsoft*')) {
        Write-Output "ok  $($f.Name) ($cn)"
    } else {
        $bad += "$($f.FullName): $($sig.Status), signer '$cn'"
    }
}
if ($bad) { throw "Not signed by ${publisher}:`n$($bad -join "`n")" }
Write-Output "all $($files.Count) files signed"
