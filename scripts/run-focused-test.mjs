import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const argumentsForTest = process.argv.slice(2);

if (argumentsForTest[0] === "--") {
  argumentsForTest.shift();
}

const [sourceTest, ...extraArguments] = argumentsForTest;

if (!sourceTest || extraArguments.length > 0) {
  throw new Error("Pass exactly one source test-file path after --.");
}

const repositoryRoot = process.cwd();
const sourcePath = path.resolve(repositoryRoot, sourceTest);
const relativeSourcePath = path.relative(repositoryRoot, sourcePath);
const supportedTestPath = /^src[\\/].+\.test\.[cm]?[jt]sx?$/;

if (
  relativeSourcePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativeSourcePath) ||
  !existsSync(sourcePath) ||
  !statSync(sourcePath).isFile()
) {
  throw new Error(`Test file must exist within this repository: ${sourceTest}`);
}

if (!supportedTestPath.test(relativeSourcePath)) {
  throw new Error(`Focused test must be a source test under src/: ${sourceTest}`);
}

const isBrowserTest = relativeSourcePath.endsWith(".browser.test.ts");
const runnerArguments = isBrowserTest
  ? [
      path.join(repositoryRoot, "node_modules", "@playwright", "test", "cli.js"),
      "test",
      relativeSourcePath,
      "--reporter=line",
    ]
  : [
      path.join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=dot",
      relativeSourcePath,
    ];

const result = spawnSync(
  process.execPath,
  runnerArguments,
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
