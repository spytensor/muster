// Makes a signed, notarized build of the desktop app for this Mac's processor and puts it
// where the server offers it to the apps already installed.
//
//   pnpm --filter @muster/desktop run release
//
// What it needs, once, from the owner of the Apple developer account:
//   1. A "Developer ID Application" certificate in this Mac's keychain (Xcode > Settings >
//      Accounts > Manage Certificates > + > Developer ID Application). The "Apple
//      Development" certificate is for running on one's own devices and does not do.
//   2. Notarization credentials kept in the keychain under a name:
//        xcrun notarytool store-credentials muster-notary --apple-id <id> --team-id <team>
//      (it asks for an app-specific password; this script never sees it).
//
// And, to publish: MUSTER_RELEASE_HOST, an ssh host that runs the server in Docker.
// Without it the build is made and left in apps/desktop/out/release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packager } from "@electron/packager";

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options }).toString();
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const arch = process.arch;
// As the server reads it: three numbers. Anything else would be published and never offered.
if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version))
  throw new Error(`"${version}" is not a version the server offers: use three numbers, as 0.2.0.`);
if (!/^(arm64|x64)$/.test(arch)) throw new Error(`No release is made for ${arch}.`);
const profile = process.env.MUSTER_NOTARY_PROFILE ?? "muster-notary";
if (process.platform !== "darwin") throw new Error("A macOS build is made on a Mac.");

// The certificate, by its kind: found before anything is built, and said plainly if not.
const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
const identity =
  process.env.MUSTER_SIGN_IDENTITY ?? identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
if (!identity) {
  console.error(
    'No "Developer ID Application" certificate is in this Mac\'s keychain.\n' +
      "Make one in Xcode (Settings > Accounts > Manage Certificates > + > Developer ID Application),\n" +
      "or at developer.apple.com/account/resources/certificates. Only the account's holder can.",
  );
  process.exit(1);
}
// The credentials for notarizing, by their name in the keychain.
try {
  run("xcrun", ["notarytool", "history", "--keychain-profile", profile], {
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  console.error(
    `No notarization credentials are kept under "${profile}". Keep them once with:\n` +
      `  xcrun notarytool store-credentials ${profile} --apple-id <your Apple ID> --team-id <your team>\n` +
      "It asks for an app-specific password (appleid.apple.com > Sign-In and Security).",
  );
  process.exit(1);
}

console.log(`Muster ${version} for ${arch}, signed as ${identity.replace(/\(.*\)/, "(…)")}`);
run("pnpm", ["build"]);
// The mark of a release, which the app looks for before it asks for updates: only a
// build signed here can be replaced by another signed here.
writeFileSync("updates.json", `${JSON.stringify({ updates: true })}\n`);
// Every file signed asks Apple's timestamp server for the time, some hundreds of times in
// a row, and one answer lost on a poor connection fails the whole signing ("A timestamp
// was expected but was not found"). So there is less to sign: Electron's own menus are
// kept in the languages Muster has and no others. And what fails is tried again.
// Kept with their forms of address (en_FEMININE and the like), which the system may ask for.
const KEPT = /^(en|en_GB|zh_CN|zh_TW)(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/;
const fewerLanguages = ({ buildPath }) => {
  // Both places: the framework holds each language's words, and the app's own resources
  // hold an empty folder for each, which is what tells the system the app has that
  // language. Cut in one place only, a Mac set to German would choose German and find
  // no words for it.
  for (const resources of [
    join(buildPath, "Electron.app/Contents/Resources"),
    join(
      buildPath,
      "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources",
    ),
  ])
    for (const name of readdirSync(resources))
      if (name.endsWith(".lproj") && !KEPT.test(name))
        rmSync(join(resources, name), { recursive: true, force: true });
};
const pack = () =>
  packager({
    dir: ".",
    name: "Muster",
    appBundleId: "ai.muster.desktop",
    appCategoryType: "public.app-category.productivity",
    appVersion: version,
    icon: "assets/icon",
    out: "out",
    overwrite: true,
    platform: "darwin",
    arch,
    prune: false,
    ignore: [/^\/node_modules/, /^\/src/, /^\/scripts/, /^\/out/, /^\/tsconfig/, /^\/README/],
    afterExtract: [fewerLanguages],
    // Signed with the hardened runtime, then sent to Apple and stapled: an app that is not
    // both is stopped by the system on another person's Mac, and never updates itself.
    // A signature that fails stops here, not after Apple has been asked about a bad build.
    osxSign: { identity, continueOnError: false },
    osxNotarize: { keychainProfile: profile },
  });
let built;
try {
  for (let attempt = 1; !built && attempt <= 5; attempt++)
    try {
      [built] = await pack();
    } catch (error) {
      const lost = /timestamp/i.test(String(error?.message ?? error));
      if (!lost || attempt >= 5) throw error;
      console.log(`The timestamp server did not answer (try ${attempt} of 5): signing again.`);
      await new Promise((done) => setTimeout(done, 5000));
    }
  if (!built) throw new Error("Nothing was built.");
} finally {
  rmSync("updates.json", { force: true });
}
const app = join(built, "Muster.app");
run("codesign", ["--verify", "--deep", "--strict", app]);
run("spctl", ["--assess", "--type", "execute", app]);

// One archive, as the updater takes it, and the small file that names it.
const dir = join("out", "release");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = `Muster-${version}-darwin-${arch}.zip`;
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, join(dir, file)]);
const sha256 = createHash("sha256")
  .update(readFileSync(join(dir, file)))
  .digest("hex");
const manifest = `darwin-${arch}.json`;
writeFileSync(
  join(dir, manifest),
  `${JSON.stringify({ version, file, sha256, date: new Date().toISOString(), notes: process.env.MUSTER_RELEASE_NOTES ?? "" }, null, 2)}\n`,
);
console.log(`made: ${join(dir, file)}`);

const host = process.env.MUSTER_RELEASE_HOST;
if (!host) {
  console.log("Not published: set MUSTER_RELEASE_HOST to the ssh host that runs the server.");
  process.exit(0);
}
const container = process.env.MUSTER_RELEASE_CONTAINER ?? "deploy-muster-1";
const into = "/data/files/_desktop";
// The archive first and the file that names it last: an app that asks in between is
// offered nothing it cannot fetch.
// The archive is a hundred megabytes over a connection that is slow and drops. It goes in
// pieces of five megabytes, each sent again until it has arrived whole, is joined on the
// server, and is compared with what was made here. (macOS's own rsync cannot go on from
// where a copy stopped, and scp begins again from nothing.)
const parts = join(dir, "parts");
rmSync(parts, { recursive: true, force: true });
mkdirSync(parts);
run("split", ["-b", "5m", join(dir, file), join(parts, "part-")]);
const remote = `/tmp/muster-release-${version}`;
const ssh = (command) => run("ssh", ["-o", "ConnectTimeout=20", host, command]);
ssh(`rm -rf ${remote} && mkdir -p ${remote}`);
for (const part of readdirSync(parts).sort()) {
  const size = String(readFileSync(join(parts, part)).length);
  for (let attempt = 1; ; attempt++) {
    try {
      run("scp", [
        "-q",
        "-o",
        "ConnectTimeout=20",
        "-o",
        "ServerAliveInterval=15",
        join(parts, part),
        `${host}:${remote}/${part}`,
      ]);
      if (ssh(`stat -c %s ${remote}/${part}`).trim() === size) break;
    } catch {
      // Sent again below.
    }
    if (attempt >= 10) throw new Error(`${part} could not be copied to ${host} in 10 tries.`);
    console.log(`${part} did not arrive whole (try ${attempt}): sending it again.`);
  }
}
rmSync(parts, { recursive: true, force: true });
if (
  ssh(`cat ${remote}/part-* > /tmp/${file} && rm -rf ${remote} && sha256sum /tmp/${file}`).slice(
    0,
    64,
  ) !== sha256
)
  throw new Error("The archive on the server is not the one made here.");
run("scp", [join(dir, manifest), `${host}:/tmp/`]);
run("ssh", [
  host,
  `docker exec ${container} mkdir -p ${into} && docker cp /tmp/${file} ${container}:${into}/${file} && docker cp /tmp/${manifest} ${container}:${into}/${manifest} && rm -f /tmp/${file} /tmp/${manifest}`,
]);
console.log(`published: ${version} for darwin-${arch} on ${host}`);
