// The server a build talks to by default. Set MUSTER_SERVER_URL when building for a deployed
// server; people can still change it on the sign-in screen.
module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    serverUrl: process.env.MUSTER_SERVER_URL ?? config.extra?.serverUrl,
  },
});
