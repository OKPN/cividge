import { defineConfig } from "vite";
import { assertSafePublicArtifacts } from "./security/public-artifacts.js";

export default defineConfig({
  plugins: [{ name: "exclude-secret-configuration", apply: "build", buildStart() { assertSafePublicArtifacts("public"); },
    closeBundle() { assertSafePublicArtifacts("dist"); } }],
  base: "./",
  worker: {
    format: "es",
  },
});
