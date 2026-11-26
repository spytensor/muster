// Xcode 27 rejects pod targets whose deployment target is below 15.0 (several still say 9.0–12.4).
// Every pod target gets the app's own minimum after CocoaPods writes the project.
const { withDangerousMod } = require("expo/config-plugins");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const TARGET = "15.1";
const MARK = "# muster: pods deployment target";
const SNIPPET = `
    ${MARK}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${TARGET}'
      end
    end`;

module.exports = (config) =>
  withDangerousMod(config, [
    "ios",
    (config) => {
      const path = join(config.modRequest.platformProjectRoot, "Podfile");
      const podfile = readFileSync(path, "utf8");
      if (!podfile.includes(MARK)) {
        const hook = /post_install do \|installer\|\n/;
        if (!hook.test(podfile))
          throw new Error("Podfile has no post_install hook to set the pods deployment target.");
        writeFileSync(
          path,
          podfile.replace(hook, (line) => `${line}${SNIPPET}\n`),
        );
      }
      return config;
    },
  ]);
