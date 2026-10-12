# Prepare Azure Artifact Signing for tools/sign-windows.cjs, in the release workflow after azure/login (OIDC).
# Downloads Microsoft's signing client (pinned by version and SHA-256), finds signtool, writes the metadata, and
# exports SIGNTOOL, AZURE_SIGNING_DLIB and AZURE_SIGNING_METADATA to the following steps. The identity comes from
# the repository variables WINDOWS_SIGNING_* (tools/setup-signing.ps1 sets them). Same as filestar/build-scripts.
$ErrorActionPreference = 'Stop'
foreach ($v in 'WINDOWS_SIGNING_ENDPOINT', 'WINDOWS_SIGNING_ACCOUNT', 'WINDOWS_SIGNING_PROFILE') {
    if (-not [Environment]::GetEnvironmentVariable($v)) { throw "$v is not set (run tools/setup-signing.ps1); Yaho must not ship unsigned" }
}

$ClientVersion = '1.0.128'
$ClientSha256 = '74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b'
$Work = Join-Path $env:RUNNER_TEMP 'signing'
New-Item -ItemType Directory -Force $Work | Out-Null
$nupkg = "$Work/client.nupkg"
Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/$ClientVersion/microsoft.artifactsigning.client.$ClientVersion.nupkg" -OutFile $nupkg
$got = (Get-FileHash -Algorithm SHA256 $nupkg).Hash.ToLowerInvariant()
if ($got -ne $ClientSha256) { throw "Microsoft.ArtifactSigning.Client $ClientVersion is $got, expected $ClientSha256" }
Expand-Archive $nupkg "$Work/client" -Force
$Dlib = "$Work/client/bin/x64/Azure.CodeSigning.Dlib.dll"
if (-not (Test-Path $Dlib)) { throw 'Azure.CodeSigning.Dlib.dll not found in the signing client package' }

$SignTool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/10.*/x64/signtool.exe" |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending | Select-Object -First 1
if (-not $SignTool) { throw 'signtool.exe not found (Windows SDK)' }

$Metadata = "$Work/metadata.json"
@{
    Endpoint               = $env:WINDOWS_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:WINDOWS_SIGNING_ACCOUNT
    CertificateProfileName = $env:WINDOWS_SIGNING_PROFILE
    # Only the Azure CLI's login (from azure/login) may be used.
    ExcludeCredentials     = @('ManagedIdentityCredential', 'EnvironmentCredential', 'WorkloadIdentityCredential',
                               'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
                               'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
} | ConvertTo-Json | Set-Content -Encoding utf8 $Metadata

"SIGNTOOL=$($SignTool.FullName)" >> $env:GITHUB_ENV
"AZURE_SIGNING_DLIB=$Dlib" >> $env:GITHUB_ENV
"AZURE_SIGNING_METADATA=$Metadata" >> $env:GITHUB_ENV
Write-Output "signing ready: $($SignTool.FullName)"
