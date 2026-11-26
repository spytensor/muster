// Builds the desktop app for this machine into apps/desktop/out.
import { packager } from "@electron/packager";

const [path] = await packager({
  dir: ".",
  name: "Muster",
  appBundleId: "ai.muster.desktop",
  appCategoryType: "public.app-category.productivity",
  icon: "assets/icon",
  out: "out",
  overwrite: true,
  // The app has no runtime dependencies: only the compiled code and its assets go in.
  prune: false,
  ignore: [/^\/node_modules/, /^\/src/, /^\/scripts/, /^\/out/, /^\/tsconfig/, /^\/README/],
});
console.log(`packaged: ${path}`);
