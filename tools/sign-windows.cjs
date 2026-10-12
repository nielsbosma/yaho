// electron-builder's sign hook for Windows (win.signtoolOptions.sign): signs one file as Bosma Interactive AB with
// Azure Artifact Signing, the way filestar/build-scripts does. The release workflow prepares signtool, Microsoft's
// signing dlib and its metadata (tools/prepare-windows-signing.ps1) and logs in to Azure with OIDC, so the only
// credential is the Azure CLI's. Without that environment (a local build) files stay unsigned.
const { execFileSync } = require('node:child_process');

exports.default = async function sign(configuration) {
  const { SIGNTOOL, AZURE_SIGNING_DLIB, AZURE_SIGNING_METADATA } = process.env;
  if (!SIGNTOOL || !AZURE_SIGNING_DLIB || !AZURE_SIGNING_METADATA) {
    console.log(`  not signed (no signing environment): ${configuration.path}`);
    return;
  }
  // A timestamp is required: Artifact Signing certificates live for three days.
  const args = ['sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256'];
  args.push('/dlib', AZURE_SIGNING_DLIB, '/dmdf', AZURE_SIGNING_METADATA, configuration.path);
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(SIGNTOOL, args, { stdio: 'inherit' });
      return;
    } catch (e) {
      // The signing service throttles bursts; electron-builder signs file by file.
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
};
