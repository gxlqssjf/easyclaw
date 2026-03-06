import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    clean: true,
    // Bundle `ws` so the plugin works in packaged builds where
    // extensions/node_modules is stripped by electron-builder.
    noExternal: ["ws"],
});
