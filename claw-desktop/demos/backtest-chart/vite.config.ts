import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Run on a different port than the main app's locked 1420 so both can run
// side by side during development.
export default defineConfig({
  plugins: [react()],
  server: { port: 1430, strictPort: true },
});
