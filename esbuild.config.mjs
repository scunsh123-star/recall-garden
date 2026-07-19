import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "node:fs";

const production = process.argv[2] === "production";
const fsrsLicense = fs.readFileSync(new URL("./node_modules/ts-fsrs/LICENSE", import.meta.url), "utf8");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minifyWhitespace: production,
  banner: {
    js: `/*! Bundled third-party license: ts-fsrs\n${fsrsLicense.replaceAll("*/", "* /")}*/`
  },
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
