/**
 * GeneralBlueprint is a separate repository. The bridge installs it only from
 * this pin: the v1.1.0-beta.1 tag, which is also the commit named in that
 * release's validation note. main has moved since the tag; the pin does not
 * float, so a source install and the 5.8.1 binary stay traceable to one commit.
 *
 * Release bytes are checked with SHA-256. GitHub records a digest on each
 * asset, and the release also publishes SHA256SUMS.txt. Both are the same
 * hash of the zip. There is no separate sigstore/minisign signature.
 */

export const GENERAL_BLUEPRINT = {
  owner: 'cc8887',
  repo: 'GeneralBlueprint',
  gitUrl: 'https://github.com/cc8887/GeneralBlueprint.git',
  sourceTag: 'v1.1.0-beta.1',
  sourceCommit: '6c0d8e12aaad83ead5a39439a173cde58b240607',
} as const;

export const PLUGIN_NAME = 'GeneralBlueprint';
export const MARKER_NAME = '.ue-bridge-install.json';

/** Hosts a release-asset download is allowed to redirect to. */
export const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export const USER_AGENT = 'ue-bridge-plugin-setup';

/**
 * Observed on the published UE 5.8.1 Win64 zip (v1.1.0-beta.1), not assumed:
 * `Binaries/Win64/UnrealEditor.modules` BuildId is 55116800, while
 * UE5.8.1-Validation.md calls the engine "CL 56057345". Those numbers differ,
 * so a Build.version changelist is not treated as the module BuildId.
 * `.uplugin` EngineVersion in that zip is the packaging baseline "5.8.0".
 */
export const OBSERVED_UE581 = {
  asset: 'GeneralBlueprint-UE_5.8.1-Win64.zip',
  sha256: 'ea1039f52626b0a6781f9dc9ef3c02e269739e0e739ea04a80f42f0fabb8bdbd',
  modulesBuildId: '55116800',
  validationChangelist: '56057345',
  descriptorEngineVersion: '5.8.0',
} as const;
