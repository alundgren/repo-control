import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const image = `repo-control-verify-${process.pid}`;
const volume = `repo-control-verify-${process.pid}`;
const databasePath = "/var/lib/repo-control/repo-control.sqlite";
const tokenSentinel = "github_pat_SENTINEL_SHOULD_NEVER_LEAVE_THE_SERVER";
const temporaryDirectory = await mkdtemp(join(tmpdir(), "repo-control-container-"));

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed`);
  }
}

function assertDockerfileReachesTheBuildContext() {
  // `docker build` injects the file named by `-f` into the context, so a build
  // that only uses the CLI cannot see a .dockerignore that excludes it. Piploy
  // builds through the Docker API from a .dockerignore-filtered tar, where an
  // excluded Dockerfile fails the build. Read the context the same way.
  const result = spawnSync(
    "docker",
    ["build", "--quiet", "--file", "-", "--target", "context-check", "."],
    { encoding: "utf8", input: "FROM scratch AS context-check\nCOPY Dockerfile /Dockerfile\n" },
  );
  assert.equal(
    result.status,
    0,
    ".dockerignore excludes Dockerfile from the build context, so an API build cannot locate it",
  );
}

function runDatabaseCheck(source) {
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    "--mount",
    `type=volume,src=${volume},dst=/var/lib/repo-control`,
    image,
    "--input-type=module",
    "--eval",
    source,
  );
}

async function runImageBoundaryCheck() {
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "--eval",
    'import { access } from "node:fs/promises"; for (const path of ["/app/.env", "/app/src", "/app/docs"]) { await access(path).then(() => process.exit(1)).catch(() => undefined); }',
  );
  const archive = join(temporaryDirectory, "image.tar");
  docker("image", "save", "--output", archive, image);
  assert.equal((await readFile(archive)).includes(Buffer.from(tokenSentinel)), false);
}

try {
  assertDockerfileReachesTheBuildContext();
  docker("build", "--tag", image, ".");
  docker("volume", "create", volume);
  runDatabaseCheck(
    `import Database from "better-sqlite3"; const db = new Database("${databasePath}"); db.exec("CREATE TABLE packaging_check (value TEXT NOT NULL)"); db.prepare("INSERT INTO packaging_check VALUES (?)").run("persistent"); db.close();`,
  );
  runDatabaseCheck(
    `import Database from "better-sqlite3"; const db = new Database("${databasePath}", { readonly: true }); if (db.prepare("SELECT value FROM packaging_check").get().value !== "persistent") process.exit(1); db.close();`,
  );
  await runImageBoundaryCheck();
} finally {
  spawnSync("docker", ["volume", "rm", "--force", volume], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" });
  await rm(temporaryDirectory, { force: true, recursive: true });
}
