import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", "dooers-threads/index": "src/dooers-threads/index.ts", "dooers-threads/contracts": "src/protocol/dooers-threads/contracts.ts" },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
  treeshake: true,
});
