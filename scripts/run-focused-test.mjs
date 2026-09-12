import { existsSync, statSync } from "node:fs";
import { runTests } from "./run-tests.mjs";
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
process.exitCode = runTests(isBrowserTest ? "browser" : "unit", relativeSourcePath);
