import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sourceRepo = new URL("../", import.meta.url).pathname;

async function waitFor(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("installer did not reach kickstart checkpoint");
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "settlement-installer-signal-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const stateFile = join(root, "launch-state");
    const markerFile = join(root, "kickstarted");
    const stateDir = join(home, "Library/Application Support/Riverse/settlement-worker");
    const runtimeDir = join(stateDir, "runtime");
    const envFile = join(stateDir, "worker.env");
    const plist = join(home, "Library/LaunchAgents/com.riverse.settlement-worker.plist");
    const installer = join(repo, "scripts/install-settlement-worker.sh");

    for (const path of [
      join(repo, "scripts"),
      join(repo, "ops"),
      join(repo, "src/features/settlement/data"),
      join(repo, "node_modules/.bin"),
      join(repo, "node_modules/@napi-rs/canvas"),
      join(repo, "node_modules/@napi-rs/canvas-darwin-arm64"),
      join(repo, "node_modules/@tesseract.js-data/jpn"),
      join(repo, "node_modules/@tesseract.js-data/eng"),
      join(repo, "node_modules/tesseract.js/src/worker-script/node"),
      join(repo, "node_modules/tesseract.js/src/utils"),
      join(repo, "node_modules/tesseract.js/src/constants"),
      join(repo, "node_modules/pdfjs-dist/cmaps"),
      join(runtimeDir),
      dirname(plist),
      join(root, "tmp"),
      fakeBin,
    ]) await mkdir(path, { recursive: true });

    await writeFile(join(repo, "package.json"), "{}\n");
    await writeFile(join(repo, ".env.local"), [
      "NEXT_PUBLIC_SUPABASE_URL=https://example.invalid",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon",
      "RVJP_DB_ADMIN_TOKEN=fake-service-role",
      "SUPABASE_DATABASE_URL=postgresql://fake.invalid/db",
      "",
    ].join("\n"));
    await writeFile(join(repo, "scripts/settlement-worker.ts"), "console.log('fake');\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/worker-script/node/index.js"), "// synthetic worker\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/worker-script/index.js"), "// synthetic parent\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/utils/getEnvironment.js"), "// synthetic util\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/constants/PSM.js"), "// synthetic constant\n");
    await cp(join(sourceRepo, "ops/com.riverse.settlement-worker.plist.template"), join(repo, "ops/com.riverse.settlement-worker.plist.template"));

    const originalRepoLine = 'REPO_DIR="/Volumes/SSD_MacMini_2/HermesWork/rvjp-human-system-diff-ui"';
    const originalInstaller = await readFile(join(sourceRepo, "scripts/install-settlement-worker.sh"), "utf8");
    const isolatedInstaller = originalInstaller.replace(originalRepoLine, `REPO_DIR="${repo}"`);
    assert.notEqual(isolatedInstaller, originalInstaller, "test must replace the production repository path");
    assert.equal(isolatedInstaller.includes(originalRepoLine), false, "isolated installer must not retain production REPO_DIR");
    await writeFile(installer, isolatedInstaller);
    await chmod(installer, 0o755);

    const esbuild = join(repo, "node_modules/.bin/esbuild");
    await writeFile(esbuild, `#!/bin/sh\nset -eu\nout=''\nfor arg in "$@"; do case "$arg" in --outfile=*) out=\${arg#--outfile=};; esac; done\n[ -n "$out" ]\nmkdir -p "$(dirname "$out")"\nprintf 'fake bundle\\n' > "$out"\n`);
    await chmod(esbuild, 0o755);

    const launchctl = join(fakeBin, "launchctl");
    await writeFile(launchctl, `#!/bin/sh\nset -eu\ncase "$1" in\n  print) [ "$(cat "$FAKE_LAUNCH_STATE")" = loaded ];;\n  bootout) printf 'unloaded\\n' > "$FAKE_LAUNCH_STATE";;\n  bootstrap) printf 'loaded\\n' > "$FAKE_LAUNCH_STATE";;\n  kickstart) : > "$FAKE_KICKSTART_MARKER";;\n  *) exit 2;;\nesac\n`);
    await chmod(launchctl, 0o755);

    await writeFile(join(runtimeDir, "old-runtime.txt"), "old runtime\n");
    // Failed installs must restore the previous worker.env byte for byte,
    // including manually placed optional Drive/version settings.
    const previousEnv = [
      "OLD_ENV=preserved",
      'SETTLEMENT_DRIVE_BACKUP_ENABLED="true"',
      'GOOGLE_DRIVE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nFAKEFAKEFAKE\\n-----END PRIVATE KEY-----\\n"',
      "SETTLEMENT_VERSION_WORK_ROOT=/Volumes/FakeSSD2/settlement-work",
      "",
    ].join("\n");
    await writeFile(envFile, previousEnv, { mode: 0o600 });
    await writeFile(plist, "old plist\n", { mode: 0o600 });
    await writeFile(stateFile, "loaded\n");

    const child = spawn("/bin/sh", [installer], {
      env: {
        HOME: home,
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TMPDIR: join(root, "tmp"),
        FAKE_LAUNCH_STATE: stateFile,
        FAKE_KICKSTART_MARKER: markerFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    await waitFor(markerFile);
    child.kill("SIGTERM");
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    assert.notEqual(exit, 0, "interrupted install must fail");
    assert.equal(await readFile(join(runtimeDir, "old-runtime.txt"), "utf8"), "old runtime\n");
    assert.equal(await readFile(envFile, "utf8"), previousEnv);
    assert.equal(await readFile(plist, "utf8"), "old plist\n");
    assert.equal((await readFile(stateFile, "utf8")).trim(), "loaded");
    assert.match(stderr, /installation interrupted/);
    assert.equal(stderr.includes("fake-anon"), false);
    assert.equal(stderr.includes("fake-service-role"), false);
    assert.equal(stderr.includes("FAKEFAKEFAKE"), false);
    console.log("test-settlement-worker-installer-signal: all assertions passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
