---
name: libretto-packaging
description: Build, sign and release Libretto packages (Windows NSIS, macOS signed and notarized dmg, Linux deb and AppImage, standalone server) with GitHub Actions. Use when changing desktop/package.json, build.yml, signing secrets, installers, or when a CI build or macOS signing step fails.
---

# Libretto packaging

## Layout
- `backend/`: FastAPI server. PyInstaller freezes it into `desktop/build/backend` (`desktop/scripts/build-app.js`).
- `frontend/`: React UI, built into the server bundle.
- `desktop/`: Electron shell (`main.js`) and electron-builder config (`package.json` → `build`).
- `.github/workflows/build.yml`: manual (`workflow_dispatch`) or `v*` tag build on Windows, macOS and Ubuntu.
- `.github/workflows/test.yml`: pytest, `tsc --noEmit`, `npm test` on Ubuntu for pushes and PRs.

## Run a build
```powershell
$gh = "C:\Program Files\GitHub CLI\gh.exe"
& $gh workflow run build.yml --repo Higeneko9/Libretto
$id = & $gh run list --workflow build.yml --repo Higeneko9/Libretto --limit 1 --json databaseId --jq '.[0].databaseId'
& $gh run watch $id --repo Higeneko9/Libretto --exit-status
& $gh run view $id --repo Higeneko9/Libretto --json jobs --jq '[.jobs[]|{n:.name,r:.conclusion}]'
& $gh run view $id --repo Higeneko9/Libretto --log-failed
```
- A macOS run takes about 5-8 minutes because of notarization. Use a long wait.
- Failures with `status code 504` while downloading Electron or NSIS resources are GitHub outages: rerun, don't change code.
- Artifacts expire after 3 days. Push only when the user says so; commit locally with the Copilot co-author trailer.

## Artifacts
| Artifact | Contents |
|---|---|
| `libretto-desktop-windows` | NSIS installer `.exe` |
| `libretto-desktop-macos` | signed, notarized `.dmg` (arm64) |
| `libretto-desktop-linux-deb` / `-appimage` | `.deb`, `.AppImage` |
| `libretto-server-windows` | server folder |
| `libretto-server-macos-latest`, `libretto-server-ubuntu-24.04` | `.tar.gz` (zip loses executable bits and symlinks) |

Local pack check on Windows: `cd desktop; npm run pack` (unpacked app in `desktop\release\win-unpacked`).

## Per platform
- **Windows:** `nsis` target only. `desktop/installer.nsh` asks whether to delete `%APPDATA%\Libretto` on uninstall (skipped for updates and silent runs). The installer is unsigned, so SmartScreen warns. Signing options: SignPath Foundation (public OSS repos), Azure Trusted Signing, or a CA certificate.
- **macOS:** see the signing section. The app needs `NSLocalNetworkUsageDescription` (in `mac.extendInfo`) plus a stable code signature, otherwise macOS blocks LAN access to ComfyUI with `[Errno 65] No route to host`.
- **Linux:** `deb` needs `homepage` and a `maintainer` email. `deb.afterInstall` (`desktop/scripts/linux-after-install.sh`) replaces electron-builder's default script, so it must recreate the `/usr/bin` link and set `chrome-sandbox` to mode 4755 itself.
- **PyInstaller on macOS/Linux:** `build-app.js` copies with `cp -R` because `fs.cpSync` rewrites relative symlinks to absolute CI paths, which breaks `Python` loading (`PYI-6005`).

## macOS signing and notarization (works)
Secrets (repo → Settings → Secrets and variables → Actions): `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Never paste them into chat or commit them.

How `build.yml` uses them:
1. A step **Import signing certificate** (macOS only) decodes `CSC_LINK`, creates its own keychain, imports the `.p12`, and writes `LB_MAC_SIGNED=true` to `GITHUB_ENV`.
   Do not give electron-builder `CSC_LINK`: its own keychain import fails with `security set-key-partition-list` exit code 1 on current macOS runners, even with a valid `.p12`.
2. The build step sets `CSC_IDENTITY_AUTO_DISCOVERY` to `true` when `LB_MAC_SIGNED` is set, else `false`, and passes `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization.
3. `desktop/package.json` `mac`: `hardenedRuntime`, `entitlements` and `entitlementsInherit` = `scripts/entitlements.mac.plist` (allow-jit, allow-unsigned-executable-memory, disable-library-validation: Electron and the frozen Python server need them), `notarize: true`, `gatekeeperAssess: false`. Keep entitlements under `desktop/scripts/`, not `desktop/build/` (gitignored and overwritten by build-app).
4. Without the secrets, `desktop/scripts/adhoc-sign.js` (`afterPack`) ad-hoc signs the app with `codesign --sign -`. `mac.identity: "-"` does not work (electron-builder looks for a keychain identity named `-`); `identity: null` skips signing entirely, including real certificates.

Success looks like `signing … identity=<hash>` and `notarization successful` in the log, and `1 valid identities found` in the import step.

### Getting the certificate
- Requires the Account Holder Apple ID (Individual enrollment is fine). Accept any pending Program License Agreement at developer.apple.com first; otherwise Xcode says "PLA Update available" or "only the Account Holder".
- Create a **Developer ID Application** certificate (Xcode → Settings → Apple Accounts → Manage Certificates, or the website with a Keychain Access signing request).
- Export the certificate row from Keychain Access (My Certificates, with its private key underneath) as `.p12`, then `base64 -i cert.p12 | pbcopy` into `CSC_LINK`.
- Create the app-specific password at appleid.apple.com.

## Verifying a package
- macOS: download the artifact, launch without `xattr`, and press Test connection against a LAN ComfyUI.
- Windows: install, run, uninstall and check the delete-data prompt. Desktop zoom: Ctrl +, -, 0 (`desktop/main.js` `setupZoom`).
- Data folders: Windows desktop `%APPDATA%\Libretto`, Linux desktop `~/.config/Libretto`, Linux server `~/.local/share/Libretto`.

## Releases
Pushing a `v*` tag runs `build.yml`; the `release` job then attaches the installers, the server tarballs and a zipped Windows server to a GitHub release (`softprops/action-gh-release`, generated notes). The repo is MIT licensed (`LICENSE`).

## Known gaps
- NSIS uninstall prompt and Electron zoom keys are not yet verified on a real Windows installer.
- Windows build is unsigned by decision: Store/MSIX and Azure Trusted Signing were rejected (too much friction, no active Azure subscription). The README tells users to click More info → Run anyway. If it becomes a problem, apply to SignPath Foundation (needs a public repo, OSI license, an existing release, a "Code signing policy" README section, MFA; certificate publisher would be "SignPath Foundation").

## Versioning

Format `MAJOR.YY.MMDD.BUILD` (e.g. `0.26.1108.0`). `VERSION` is the source of truth and feeds the window/tab title (`frontend/vite.config.ts`). Before tagging a release run `node scripts/version.js` (add `--major N` to change the major number); it bumps `VERSION` and updates `desktop/package.json`. The installer needs a 3-part semver, so `version` there is `MAJOR.YY.MMDD` without the leading zero (`0.26.1108`), and the full 4-part value goes in `build.buildVersion`. Commit both files, then tag.
