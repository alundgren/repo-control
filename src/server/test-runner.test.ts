import { afterEach, expect, test } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const temporaryDirectories: string[] = [];
const root = process.cwd();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(unit: string, browser: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "test-runner-fixture-"));
  temporaryDirectories.push(directory);
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  mkdirSync(path.join(directory, "src"));
  writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(directory, "src/example.test.ts"), `import { test, expect } from 'vite-plus/test';\n${unit}`);
  writeFileSync(path.join(directory, "src/example.browser.test.ts"), `import { test, expect } from '@playwright/test';\n${browser}`);
  writeFileSync(path.join(directory, "playwright.config.ts"), `export default { testDir: './src', testMatch: '**/*.browser.test.ts', outputDir: './results', workers: 1 };`);
  return directory;
}

function run(directory: string, focused?: string) {
  const result = spawnSync("vp", [
    "exec", "node",
    path.join(root, focused ? "scripts/run-focused-test.mjs" : "scripts/run-tests.mjs"),
    ...(focused ? ["--", focused] : []),
  ], { cwd: directory, encoding: "utf8", timeout: 30_000 });
  const diagnostics = result.stdout.match(/Full diagnostics: (.+)/)?.[1];
  if (diagnostics) temporaryDirectories.push(diagnostics);
  expect(result.error).toBeUndefined();
  return { ...result, diagnostics };
}

test("prints only one success summary despite test stdout, stderr, and skips", () => {
  const directory = fixture(
    `test('unit pass', () => { console.log('unit noise'); console.error('unit warning'); }); test.skip('later', () => {});`,
    `test('browser pass', () => { console.log('browser noise'); console.error('browser warning'); });`,
  );
  const result = run(directory);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("PASS (unit: 1 passed, 1 skipped; browser: 1 passed)\n");
  const focused = run(directory, "src/example.test.ts");
  expect(focused.status).toBe(0);
  expect(focused.stdout).toBe("PASS (unit: 1 passed, 1 skipped)\n");
  const browser = run(directory, "src/example.browser.test.ts");
  expect(browser.status).toBe(0);
  expect(browser.stdout).toBe("PASS (browser: 1 passed)\n");
}, 30_000);

test("reports every failed test from both runners and retains full diagnostics", () => {
  const result = run(fixture(
    `test('unit first', () => { console.log('retained noise'); expect(1).toBe(2); }); test('unit second', () => { throw new Error('second failure'); });`,
    `test('browser failure', () => { expect('actual').toBe('expected'); });`,
  ));
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("unit first");
  expect(result.stdout).toContain("unit second");
  expect(result.stdout).toContain("browser failure");
  expect(result.stdout).toContain("second failure");
  expect(result.stdout).not.toContain("retained noise");
  expect(result.stdout.length).toBeLessThan(2500);
  expect(result.diagnostics).toBeDefined();
  expect(readFileSync(path.join(result.diagnostics!, "unit.log"), "utf8")).toContain("retained noise");
  expect(JSON.parse(readFileSync(path.join(result.diagnostics!, "browser.json"), "utf8")).stats.unexpected).toBe(1);
}, 30_000);

test("reports collection and startup errors even when no tests run", () => {
  const directory = fixture("throw new Error('unit collection broke');", "test('pass', () => {});");
  writeFileSync(path.join(directory, "playwright.config.ts"), "throw new Error('browser config broke');");
  const result = run(directory);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("unit collection broke");
  expect(result.stdout).toContain("browser config broke");
  expect(result.stdout).toContain("FAIL unit");
  expect(result.stdout).toContain("FAIL browser");
}, 30_000);
