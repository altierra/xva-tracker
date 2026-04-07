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

  console.log(`afterPack: ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: "inherit" });
  console.log("afterPack: signing complete");
};
