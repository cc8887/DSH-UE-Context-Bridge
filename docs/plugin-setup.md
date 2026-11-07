# GeneralBlueprint setup

The bridge can install [GeneralBlueprint](https://github.com/cc8887/GeneralBlueprint) for the project it is already pointed at. The entry point is a loopback page started with the DSH plugin (`GeneralBlueprint setup UI:` in the host log), not a model tool and not a DSH `shell.overlay` client. DSH can host browser panels, but a client plugin that fails to load blocks the whole Web UI, and this repository does not depend on that client runtime. The page is a real document with an install button. Loading it does not download, write, or compile.

`pluginSetup: false` disables the page. `pluginSetupAutoOpen: false` leaves it available without opening a browser. After "稍后", the same situation does not open the browser again. A different engine or install state does.

## Which engine, and which kind

Engine choice reuses `engine-selection.json`. A recorded choice or a high-confidence `.uproject` association is used. An engine found only by walking upward is shown and not installed against until someone picks one.

Launcher versus source uses Unreal's own markers together:

- launcher: `Engine/Build/InstalledBuild.txt`, or a `UE_*` row in the launcher manifest
- source: `Engine/Build/SourceDistribution.txt`, or a GUID under the per-user Builds registry key
- both, or neither: the page asks. The buttons are the decision. A failed launcher install does not then clone, and a source install does not then unpack a zip.

The directory path is not a signal.

## Release packages

Only `https://github.com/cc8887/GeneralBlueprint` release assets named `GeneralBlueprint-UE_<version>-Win64.zip` are eligible. The zip URL is built from the tag and the file name. SHA-256 comes from the GitHub asset digest and from `SHA256SUMS.txt` when both exist; they must agree, and the downloaded bytes must match. Those are hashes of the zip, not a signature.

| Engine | Asset | How it is chosen |
| --- | --- | --- |
| 4.26, 4.27, 5.0–5.7, any patch | `GeneralBlueprint-UE_<major>.<minor>-Win64.zip` on `v1.0.0-beta.1` | The release did not publish separate patch zips. |
| 5.8.0 | `GeneralBlueprint-UE_5.8-Win64.zip` on `v1.0.0-beta.1` | Patch 0 keeps the unsuffixed package. |
| 5.8.1 | `GeneralBlueprint-UE_5.8.1-Win64.zip` on `v1.1.0-beta.1` | Exact patch name wins. |
| 5.8.2 or any unpublished version | none | The page says so. It does not pick 5.8.1 or start a source build. |

The 5.8.1 zip layout, checked against the published archive, is `GeneralBlueprint/GeneralBlueprint.uplugin` plus `GeneralBlueprint/Binaries/Win64/UnrealEditor.modules` and the Win64 editor DLLs. That manifest's `BuildId` is `55116800`. The validation note calls the same engine "CL 56057345". Those are different numbers. The `.uplugin` `EngineVersion` is `5.8.0`, which the release describes as the packaging baseline, not the build id.

A precompiled package is placed only when the plugin `UnrealEditor.modules` `BuildId` equals `Engine/Binaries/Win64/UnrealEditor.modules` `BuildId`. If the editor manifest is missing, the page does not pretend the changelist is that id; installation waits for an explicit confirmation. A mismatch stops before the project plugin directory is replaced.

## Source engines

Source installs fetch `https://github.com/cc8887/GeneralBlueprint.git` at `v1.1.0-beta.1` (`6c0d8e12aaad83ead5a39439a173cde58b240607`) and then run that engine's `Engine/Build/BatchFiles/Build.bat` or `Linux/Build.sh` for the `UnrealEditor` target. UE 5.8 checkouts also receive the MCP modules the repository's `Stage-Ue58Plugin.ps1` adds to the staged descriptor. Older engines do not. The engine's own `ModelContextProtocol` plugin is not edited.

The build log is on the page. Failure leaves the staged tree and a marker so a retry compiles again instead of cloning twice. Success writes the same marker with status `installed`.

## Where files go

The default target is `<project>/Plugins/GeneralBlueprint`. The `.uproject` gains `{ "Name": "GeneralBlueprint", "Enabled": true }` and nothing else; a copy of the previous descriptor is saved beside it. The engine-directory target is `<engine>/Engine/Plugins/GeneralBlueprint`, only with the extra confirmation, and only if that `Engine/Plugins` directory is writable.

An existing plugin without this installer's marker, or whose `.uplugin` changed after install, is left in place until "覆盖" is checked. The previous directory is copied under `~/.dsh/ue-bridge/generalblueprint-backups/`, outside `Plugins/`, so Unreal does not load the backup as a second plugin.

## What this machine did not prove

The automated tests use a fake engine, a fake release zip, and a stand-in build script. They do not compile a real Unreal editor DLL and they do not load the plugin inside Unreal Editor.
