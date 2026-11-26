// OpenUI mounts an inspector widget in development unless this flag is already set.
// It must be imported before anything that imports @openuidev/react-lang.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;
