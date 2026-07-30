#!/usr/bin/env node
/**
 * Entry point.
 *
 * This file exists to be tiny and to run *before* anything else is loaded.
 * node:sqlite emits an ExperimentalWarning the moment it is imported, and in a
 * tool whose entire output is a report meant to be read, that warning is noise
 * on every single invocation. Filtering it has to happen before the import that
 * triggers it, which is why the real CLI is loaded dynamically below.
 */

process.removeAllListeners("warning");
process.on("warning", (warning: Error) => {
  if (warning.message.includes("SQLite is an experimental feature")) return;
  process.stderr.write(`${warning.stack ?? `${warning.name}: ${warning.message}`}\n`);
});

const { main } = await import("./cli/run.ts");

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
}
