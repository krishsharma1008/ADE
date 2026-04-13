/**
 * esbuild configuration for bundling the Combyne server into a single JS file.
 * This allows running `node server-bundle.js` without tsx or workspace deps.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// All workspace packages to bundle into the server
const workspacePaths = [
  "server",
  "packages/db",
  "packages/shared",
  "packages/adapter-utils",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/cursor-local",
  "packages/adapters/openclaw-gateway",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
];

// Collect all external npm packages (not workspace packages)
const externals = new Set();
for (const p of workspacePaths) {
  const pkgPath = resolve(repoRoot, p, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (!name.startsWith("@combyne/") && !name.startsWith("@combyne/")) {
        externals.add(name);
      }
    }
    for (const name of Object.keys(pkg.optionalDependencies || {})) {
      externals.add(name);
    }
  } catch {}
}

// These packages should be BUNDLED (not external) to avoid version mismatches
externals.delete("zod");
externals.delete("@zod/core");
externals.delete("drizzle-zod");

// Native modules and packages with binary components must stay external
externals.add("embedded-postgres");
externals.add("lightningcss");
externals.add("fsevents");
externals.add("vite");
externals.add("esbuild");
externals.add("@embedded-postgres/darwin-arm64");
externals.add("@embedded-postgres/darwin-x64");
externals.add("@embedded-postgres/linux-arm");
externals.add("@embedded-postgres/linux-arm64");
externals.add("@embedded-postgres/linux-ia32");
externals.add("@embedded-postgres/linux-x64");
externals.add("@embedded-postgres/windows-x64");

const result = await esbuild.build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: resolve(__dirname, "dist/server-bundle.js"),
  external: [...externals].sort(),
  treeShaking: true,
  sourcemap: true,
  define: {
    "import.meta.dirname": "import.meta.dirname",
  },
  // Handle __dirname/__filename for CJS modules compiled to ESM
  banner: {
    js: `
import { createRequire as __createRequire } from 'module';
import { fileURLToPath as __fileURLToPath } from 'url';
import { dirname as __dirname_fn } from 'path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
`.trim(),
  },
});

console.log(`Server bundle built: server/dist/server-bundle.js`);
console.log(`External dependencies: ${externals.size}`);
