/**
 * afterPack hook — runs after the app is built but before the DMG is created.
 * Ad-hoc signs the .app bundle so macOS doesn't show the "damaged" error.
 * This is not a real Apple Developer signature but prevents Gatekeeper from
 * rejecting the app as unsigned/damaged on macOS Sonoma and Sequoia.
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

module.exports = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName !== "darwin") return;

  const appName = "XVA Tracker.app";
  const appPath = path.join(appOutDir, appName);

  if (!fs.existsSync(appPath)) {
    console.warn(`afterPack: app not found at ${appPath}, skipping signing`);
    return;
  }

  // Strip resource forks / Finder metadata that codesign rejects.
  // Run xattr on the whole output dir so active-win native binaries are cleaned too.
  console.log(`afterPack: stripping extended attributes from ${appOutDir}`);
  execSync(`xattr -cr "${appOutDir}"`, { stdio: "inherit" });

  // dot_clean removes AppleDouble (._*) resource fork files that xattr misses
  console.log(`afterPack: running dot_clean on ${appOutDir}`);
  execSync(`dot_clean -m "${appOutDir}"`, { stdio: "inherit" });

  // Remove any remaining ._* files explicitly (belt + suspenders)
  execSync(`find "${appOutDir}" -name '._*' -delete 2>/dev/null || true`, { stdio: "inherit" });

  // Remove any pre-existing signature so codesign doesn't trip on stale state
  console.log(`afterPack: removing pre-existing signatures`);
  execSync(`codesign --remove-signature "${appPath}" 2>/dev/null || true`, { stdio: "inherit" });

  console.log(`afterPack: ad-hoc signing ${appPath}`);
  // --no-strict: macOS Sonoma/Sequoia re-adds com.apple.provenance attrs which
  // strict mode treats as "detritus"; no-strict bypasses that check safely.
  execSync(`codesign --force --deep --sign - --no-strict "${appPath}"`, { stdio: "inherit" });
  console.log("afterPack: signing complete");
};
