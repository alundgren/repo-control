import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import console from "node:console";

function excerpt(message) {
  const lines = stripVTControlCharacters(String(message)).trim().split("\n");
  const short = lines.filter((line) => !/^\s+at /.test(line)).slice(0, 8).join("\n");
  return short.slice(0, 1000);
}

function failuresFromReport(report, browser) {
  const failures = [];
  if (!browser) {
    for (const file of report.testResults) {
      const failed = file.assertionResults.filter((test) => test.status === "failed");
      for (const test of failed) {
        failures.push([`${path.relative(process.cwd(), file.name)} > ${test.fullName}`,
          (test.failureMessages ?? []).join("\n")]);
      }
      if (file.status === "failed" && failed.length === 0) {
        failures.push([path.relative(process.cwd(), file.name), file.message]);
      }
    }
  } else {
    function visit(suite, parents = []) {
      for (const spec of suite.specs) {
        for (const test of spec.tests) {
          if (test.status !== "unexpected" && test.status !== "flaky") continue;
          const result = test.results.findLast((result) => result.errors.length > 0);
          failures.push([`[${test.projectName}] ${spec.file}:${spec.line} > ${[...parents, spec.title].join(" > ")} (${test.status})`,
            result?.errors.map((error) => error.message).join("\n") || "Unexpected test outcome"]);
        }
      }
      for (const child of suite.suites ?? []) visit(child, [...parents, child.title]);
    }
    for (const suite of report.suites) visit(suite);
    for (const error of report.errors) failures.push(["Playwright error", error.message ?? error.value]);
  }
  return failures;
}

export function runTests(mode = "all", sourceTest) {
  const directory = mkdtempSync(path.join(tmpdir(), "repo-control-tests-"));
  const runners = mode === "all" ? ["unit", "browser"] : [mode];
  const summaries = [];
  let failed = false;
  for (const runner of runners) {
    const browser = runner === "browser";
    const reportPath = path.join(directory, `${runner}.json`);
    const logPath = path.join(directory, `${runner}.log`);
    const log = openSync(logPath, "w", 0o600);
    const args = browser
      ? ["exec", "playwright", "test", "--reporter=json"]
      : ["exec", "vitest", "run", "--disableConsoleIntercept", "--reporter=json", `--outputFile=${reportPath}`, "--exclude", "**/*.browser.test.ts"];
    if (sourceTest) args.push(browser ? sourceTest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : sourceTest);
    let result;
    try {
      result = spawnSync("vp", args, {
        stdio: ["ignore", log, log],
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      });
    } finally {
      closeSync(log);
    }
    let report;
    let failures = [];
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
      failures = failuresFromReport(report, browser);
    } catch {
      // Startup failures may happen before a reporter can write its result.
    }
    const success = result.status === 0 && report && (browser
      ? report.stats.unexpected === 0 && report.errors.length === 0
      : report.success);
    const passed = browser ? report?.stats.expected : report?.numPassedTests;
    const skipped = browser ? report?.stats.skipped : (report?.numPendingTests ?? 0) + (report?.numTodoTests ?? 0);
    const flaky = browser ? report?.stats.flaky : 0;
    summaries.push(`${runner}: ${passed ?? 0} passed${skipped ? `, ${skipped} skipped` : ""}${flaky ? `, ${flaky} flaky` : ""}`);
    if (!success) {
      failed = true;
      console.log(`FAIL ${runner}`);
      for (const [name, message] of failures) {
        console.log(`  ${name}\n    ${excerpt(message).replaceAll("\n", "\n    ")}`);
      }
      if (failures.length === 0) {
        const detail = result.error?.message ?? (result.signal ? `Terminated by ${result.signal}` : `Runner exited ${result.status}${report ? "" : " without a valid report"}`);
        const tail = readFileSync(logPath, "utf8").trim().split("\n").slice(-12).join("\n");
        console.log(`  ${detail}\n${excerpt(tail)}`);
      }
    }
    if (result.signal) break;
  }
  if (failed) {
    console.log(`Full diagnostics: ${directory}`);
  } else {
    console.log(`PASS (${summaries.join("; ")})`);
    rmSync(directory, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode = "all", ...extra] = process.argv.slice(2);
  if (!["all", "browser"].includes(mode) || extra.length) {
    throw new Error("Use test, test:browser, or test:focused -- <source test file>.");
  }
  process.exitCode = runTests(mode);
}
