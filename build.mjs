import { build } from "esbuild";
import { chmod, mkdir, readdir, readFile, rm } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, "src");
const buildDir = path.join(root, "build");
const migrationsSrcDir = path.join(srcDir, "migrations");
const migrationsOutDir = path.join(buildDir, "migrations");
const external = ["pg-native", "cpu-features"];

const stripIndexShebangPlugin = {
  name: "strip-index-shebang",
  setup(pluginBuild) {
    const indexPath = path.join(srcDir, "index.ts");
    pluginBuild.onLoad({ filter: /src\/index\.ts$/ }, async (args) => {
      if (path.resolve(args.path) !== indexPath) return;
      const contents = await readFile(args.path, "utf8");
      return {
        contents: contents.replace(/^#!.*\r?\n/, ""),
        loader: "ts",
      };
    });
  },
};

// ssh2 conditionally requires a native .node binding wrapped in try/catch
// and falls back to pure JS when it throws. esbuild can't bundle .node files,
// so we resolve them to a stub that throws at runtime — letting ssh2's
// fallback path activate.
const stubNativeBindingsPlugin = {
  name: "stub-native-bindings",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      namespace: "native-binding-stub",
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "native-binding-stub" },
      () => ({
        contents:
          "throw new Error('native binding stripped from bundle; using JS fallback');",
        loader: "js",
      })
    );
  },
};

async function listMigrationEntries() {
  const names = await readdir(migrationsSrcDir);
  return names
    .filter((name) => /^[0-9][0-9][0-9]_.+\.ts$/.test(name))
    .sort()
    .map((name) => path.join(migrationsSrcDir, name));
}

// Bundled CommonJS deps reference require/__dirname/__filename which don't
// exist in ESM scope. We synthesize them at the bundle's top level so the
// nested CJS modules find them via JS scope chain.
const cjsCompatShim = [
  "import { createRequire as ___createRequire } from 'node:module';",
  "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
  "import { dirname as ___dirname } from 'node:path';",
  "var require = ___createRequire(import.meta.url);",
  "var __filename = ___fileURLToPath(import.meta.url);",
  "var __dirname = ___dirname(__filename);",
].join("\n");

async function bundle(entryPoint, outfile, options = {}) {
  const { plugins: extraPlugins = [], banner, ...rest } = options;
  const bannerJs = banner?.js
    ? `${banner.js}\n${cjsCompatShim}`
    : cjsCompatShim;
  return build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external,
    logLevel: "warning",
    plugins: [stubNativeBindingsPlugin, ...extraPlugins],
    banner: { js: bannerJs },
    ...rest,
  });
}

await rm(buildDir, { recursive: true, force: true });
await mkdir(migrationsOutDir, { recursive: true });

const results = [];
results.push(
  await bundle(path.join(srcDir, "index.ts"), path.join(buildDir, "index.js"), {
    banner: { js: "#!/usr/bin/env node" },
    plugins: [stripIndexShebangPlugin],
  })
);

for (const entryPoint of await listMigrationEntries()) {
  const outName = `${path.basename(entryPoint, ".ts")}.js`;
  results.push(await bundle(entryPoint, path.join(migrationsOutDir, outName)));
}

await chmod(path.join(buildDir, "index.js"), 0o755);

const warningCount = results.reduce((count, result) => count + result.warnings.length, 0);
if (warningCount > 0) {
  console.warn(`esbuild completed with ${warningCount} warning(s).`);
}
