import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
};

describe("packaging", () => {
  // The README's headline is that `npm install -g @siftlabs/sift` pulls nothing
  // down. The dashboard's React/Tailwind/Radix stack is a build-time toolchain that
  // compiles to static assets, so it belongs in devDependencies — but the shadcn CLI
  // and a bare `npm install <pkg>` both write to "dependencies" by default, and that
  // regression is invisible until someone installs the published package. Fail here.
  test("ships with no runtime dependencies", () => {
    assert.deepEqual(pkg.dependencies ?? {}, {});
  });

  test("the UI toolchain is a devDependency, never a runtime one", () => {
    const dev = pkg.devDependencies ?? {};
    for (const name of ["react", "react-dom", "vite", "tailwindcss", "radix-ui"]) {
      assert.ok(dev[name], `${name} must be present in devDependencies`);
    }
  });

  // The UI only reaches users if the build emits it and "files" carries it. dist/ is
  // gitignored, so nothing else in the repo would notice either half going missing.
  test("the packed tarball is built with the UI in it", () => {
    assert.ok(pkg.files?.includes("dist"));
    assert.match(pkg.scripts?.build ?? "", /build:ui/);
    assert.equal(pkg.scripts?.prepack, "npm run build");
  });
});
