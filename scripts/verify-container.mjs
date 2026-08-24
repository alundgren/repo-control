import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
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

function piployContextArchive() {
  const trackedFiles = spawnSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "buffer",
  });
  assert.equal(trackedFiles.status, 0, "cannot list the files Piploy clones");

  // Piploy passes the cloned repository to Dockerode as `context` and
  // `src: readdirSync(contextDirectory)`. Dockerode archives those files and
  // sends the tar directly to the Docker Engine. This avoids the Docker CLI's
  // context preparation, which has differed from the Pi deployment path. A
  // clone contains tracked files only, so build that equivalent tar from the
  // working tree.
  const result = spawnSync(
    "tar",
    ["--create", "--file=-", "--null", "--files-from=-"],
    { cwd: process.cwd(), encoding: "buffer", input: trackedFiles.stdout },
  );
  assert.equal(result.status, 0, "cannot archive the Piploy-style build context");
  return result.stdout;
}

async function buildWithPiployContext() {
  const response = await new Promise((resolve, reject) => {
    const build = request({
      socketPath: "/var/run/docker.sock",
      method: "POST",
      path: `/build?dockerfile=Dockerfile&t=${encodeURIComponent(image)}&rm=1&forcerm=1`,
      headers: { "content-type": "application/x-tar" },
    }, (result) => {
      const chunks = [];
      result.on("data", (chunk) => chunks.push(chunk));
      result.on("end", () => resolve({ statusCode: result.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    build.on("error", reject);
    build.end(piployContextArchive());
  });
  const errors = response.body
    .split("\n")
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.error ?? event.errorDetail?.message ?? [];
      } catch {
        return [];
      }
    });
  assert.equal(response.statusCode, 200, `Docker API build failed: ${errors.join("\n") || response.body}`);
  assert.deepEqual(errors, [], `Piploy-style Docker build failed: ${errors.join("\n")}`);
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
  await buildWithPiployContext();
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
