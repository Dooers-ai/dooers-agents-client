import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", "maestro/index": "src/maestro/index.ts", "maestro/contracts": "src/protocol/maestro/contracts.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
  treeshake: true,
});
