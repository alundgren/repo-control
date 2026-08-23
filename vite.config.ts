import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    emptyOutDir: true,
    outDir: "../../dist/web",
  },
  test: {
    root: ".",
  },
});
