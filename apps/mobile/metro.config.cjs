const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
// The reply schema is shared with the server and the web app; it lives in the repository's packages.
const schema = path.resolve(__dirname, "../../packages/ui-schema");
config.watchFolders = [schema];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
// What the schema imports (OpenUI, zod) must be this app's copy, not the one pnpm linked beside it:
// two copies of OpenUI would not recognise each other's components.
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const next = resolve ?? context.resolveRequest;
  if (context.originModulePath.startsWith(schema) && !moduleName.startsWith(".")) {
    return next(
      { ...context, originModulePath: path.join(__dirname, "index.ts") },
      moduleName,
      platform,
    );
  }
  return next(context, moduleName, platform);
};
module.exports = config;
