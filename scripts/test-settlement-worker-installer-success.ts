import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const sourceRepo = new URL("../", import.meta.url).pathname;

async function main() {
  const root = await mkdtemp(join(tmpdir(), "settlement-installer-success-"));
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const stateFile = join(root, "launch-state");
    const stateDir = join(home, "Library/Application Support/Riverse/settlement-worker");
    const envFile = join(stateDir, "worker.env");
    const plist = join(home, "Library/LaunchAgents/com.riverse.settlement-worker.plist");
    const stdoutLog = join(home, "Library/Logs/Riverse/settlement-worker/stdout.log");
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
      join(repo, "node_modules/tesseract.js/src/worker-script/utils"),
      join(repo, "node_modules/tesseract.js/src/worker-script/constants"),
      join(repo, "node_modules/tesseract.js/src/utils"),
      join(repo, "node_modules/tesseract.js/src/constants"),
      join(repo, "node_modules/pdfjs-dist/cmaps"),
      dirname(plist),
      join(root, "tmp"),
      fakeBin,
    ]) await mkdir(path, { recursive: true });

    await writeFile(join(repo, "package.json"), "{}\n");
    // The anon key and the legacy service name are present to prove the
    // installer excludes the anon key and prefers the project-scoped alias.
    await writeFile(join(repo, ".env.local"), [
      "NEXT_PUBLIC_SUPABASE_URL=https://example.invalid",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon",
      "RVJP_DB_ADMIN_TOKEN=fake-service-role",
      "SUPABASE_SERVICE_ROLE_KEY=legacy-service-role",
      "SUPABASE_DATABASE_URL=postgresql://fake.invalid/db",
      "",
    ].join("\n"));
    await writeFile(join(repo, "scripts/settlement-worker.ts"), "console.log('fake');\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/worker-script/node/index.js"), "// synthetic worker\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/worker-script/index.js"), "// synthetic parent\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/worker-script/utils/dump.js"), "// synthetic worker util\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/utils/getEnvironment.js"), "// synthetic package util\n");
    await writeFile(join(repo, "node_modules/tesseract.js/src/constants/PSM.js"), "// synthetic constant\n");
    await cp(join(sourceRepo, "ops/com.riverse.settlement-worker.plist.template"), join(repo, "ops/com.riverse.settlement-worker.plist.template"));

    const originalRepoLine = 'REPO_DIR="/Volumes/SSD_MacMini_2/HermesWork/rvjp-human-system-diff-ui"';
    const originalInstaller = await readFile(join(sourceRepo, "scripts/install-settlement-worker.sh"), "utf8");
    const isolatedInstaller = originalInstaller.replace(originalRepoLine, `REPO_DIR="${repo}"`);
    assert.notEqual(isolatedInstaller, originalInstaller, "test must replace the production repository path");
    await writeFile(installer, isolatedInstaller);
    await chmod(installer, 0o755);

    const esbuild = join(repo, "node_modules/.bin/esbuild");
    await writeFile(esbuild, `#!/bin/sh\nset -eu\nout=''\nfor arg in "$@"; do case "$arg" in --outfile=*) out=\${arg#--outfile=};; esac; done\n[ -n "$out" ]\nmkdir -p "$(dirname "$out")"\nprintf 'fake bundle\\n' > "$out"\n`);
    await chmod(esbuild, 0o755);

    const launchctl = join(fakeBin, "launchctl");
    await writeFile(launchctl, `#!/bin/sh\nset -eu\ncase "$1" in\n  print) [ "$(cat "$FAKE_LAUNCH_STATE")" = loaded ];;\n  bootout) printf 'unloaded\\n' > "$FAKE_LAUNCH_STATE";;\n  bootstrap) printf 'loaded\\n' > "$FAKE_LAUNCH_STATE";;\n  kickstart) printf '[settlement-worker] started mode=loop\\n' >> "$FAKE_STDOUT_LOG";;\n  *) exit 2;;\nesac\n`);
    await chmod(launchctl, 0o755);

    await writeFile(stateFile, "unloaded\n");

    async function runInstaller(): Promise<{ exit: number | null; output: string }> {
      const child = spawn("/bin/sh", [installer], {
        env: {
          HOME: home,
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          TMPDIR: join(root, "tmp"),
          FAKE_LAUNCH_STATE: stateFile,
          FAKE_KICKSTART_MARKER: join(root, "unused-marker"),
          FAKE_STDOUT_LOG: stdoutLog,
          SETTLEMENT_DRIVE_BACKUP_ENABLED: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { output += chunk; });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { exit, output };
    }

    const { exit, output } = await runInstaller();
    assert.equal(exit, 0, `install must succeed, output: ${output}`);
    const installedWorkerScript = join(
      stateDir,
      "runtime/src/features/settlement/worker-script/node/index.js",
    );
    assert.equal(
      await readFile(installedWorkerScript, "utf8"),
      "// synthetic worker\n",
      "installer must package the tesseract node worker beside the bundled OCR parser",
    );
    for (const relative of [
      "runtime/src/features/settlement/worker-script/index.js",
      "runtime/src/features/settlement/worker-script/utils/dump.js",
      "runtime/src/features/settlement/utils/getEnvironment.js",
      "runtime/src/features/settlement/constants/PSM.js",
    ]) {
      assert.equal((await stat(join(stateDir, relative))).isFile(), true, `${relative} must be packaged`);
    }

    // worker.env holds exactly the three required vars, service-role key under
    // the canonical alias, at mode 0600.
    const envMode = (await stat(envFile)).mode & 0o777;
    assert.equal(envMode, 0o600, "worker.env must stay mode 0600");
    const envContent = await readFile(envFile, "utf8");
    assert.equal(envContent, [
      'NEXT_PUBLIC_SUPABASE_URL="https://example.invalid"',
      'RVJP_DB_ADMIN_TOKEN="fake-service-role"',
      'SUPABASE_DATABASE_URL="postgresql://fake.invalid/db"',
      "",
    ].join("\n"));
    assert.equal(envContent.includes("fake-anon"), false);
    assert.equal(envContent.includes("legacy-service-role"), false);

    // Neither the plist, the logs, nor the installer output carry any secret.
    const plistContent = await readFile(plist, "utf8");
    const logContent = await readFile(stdoutLog, "utf8");
    for (const secret of ["fake-anon", "fake-service-role", "legacy-service-role", "fake.invalid"]) {
      assert.equal(plistContent.includes(secret), false, `plist must not contain ${secret}`);
      assert.equal(logContent.includes(secret), false, `log must not contain ${secret}`);
      assert.equal(output.includes(secret), false, `installer output must not contain ${secret}`);
    }

    // Reinstall: optional Drive/version settings manually placed in the
    // installed worker.env must survive verbatim, a nonempty .env.local value
    // must replace its worker.env counterpart, and keys outside the preserve
    // list must be dropped.
    await writeFile(envFile, envContent + [
      'SETTLEMENT_VERSION_PROCESSING_ENABLED="true"',
      'SETTLEMENT_DRIVE_BACKUP_ENABLED="false"',
      'export GOOGLE_DRIVE_CLIENT_EMAIL = "fake-drive-worker@fake.iam.gserviceaccount.com"',
      'GOOGLE_DRIVE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      'FAKEFAKEFAKE',
      '-----END PRIVATE KEY-----',
      '"',
      'GOOGLE_DRIVE_SHARED_DRIVE_ID="fake-shared-drive"',
      'GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID="fake-backup-root"',
      "SETTLEMENT_VERSION_WORK_ROOT=/Volumes/FakeSSD2/settlement-work",
      'UNRELATED_MANUAL_KEY="dropped-on-reinstall"',
      "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(join(repo, ".env.local"), [
      "NEXT_PUBLIC_SUPABASE_URL=https://example.invalid",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=fake-anon",
      "RVJP_DB_ADMIN_TOKEN=fake-service-role",
      "SUPABASE_SERVICE_ROLE_KEY=legacy-service-role",
      "SUPABASE_DATABASE_URL=postgresql://fake.invalid/db",
      "SETTLEMENT_DRIVE_BACKUP_ENABLED=true",
      "",
    ].join("\n"));

    const rerun = await runInstaller();
    assert.equal(rerun.exit, 0, `reinstall must succeed, output: ${rerun.output}`);

    assert.equal((await stat(envFile)).mode & 0o777, 0o600, "worker.env must stay mode 0600 after reinstall");
    const reinstalledEnv = await readFile(envFile, "utf8");
    assert.equal(reinstalledEnv, [
      'NEXT_PUBLIC_SUPABASE_URL="https://example.invalid"',
      'RVJP_DB_ADMIN_TOKEN="fake-service-role"',
      'SUPABASE_DATABASE_URL="postgresql://fake.invalid/db"',
      'SETTLEMENT_BACKUP_TRANSPORT="google-drive-api"',
      'SETTLEMENT_VERSION_PROCESSING_ENABLED="true"',
      'SETTLEMENT_DRIVE_BACKUP_ENABLED="true"',
      'GOOGLE_DRIVE_CLIENT_EMAIL="fake-drive-worker@fake.iam.gserviceaccount.com"',
      'GOOGLE_DRIVE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nFAKEFAKEFAKE\\n-----END PRIVATE KEY-----\\n"',
      'GOOGLE_DRIVE_SHARED_DRIVE_ID="fake-shared-drive"',
      'GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID="fake-backup-root"',
      'SETTLEMENT_VERSION_WORK_ROOT="/Volumes/FakeSSD2/settlement-work"',
      "",
    ].join("\n"));

    // Preserved values must never leak into the plist, logs, or output.
    const reinstalledPlist = await readFile(plist, "utf8");
    const reinstalledLog = await readFile(stdoutLog, "utf8");
    for (const secret of ["FAKEFAKEFAKE", "fake-drive-worker", "fake-shared-drive", "fake-backup-root", "FakeSSD2"]) {
      assert.equal(reinstalledPlist.includes(secret), false, `plist must not contain ${secret}`);
      assert.equal(reinstalledLog.includes(secret), false, `log must not contain ${secret}`);
      assert.equal(rerun.output.includes(secret), false, `installer output must not contain ${secret}`);
    }

    console.log("test-settlement-worker-installer-success: all assertions passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
