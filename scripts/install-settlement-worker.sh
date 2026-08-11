#!/bin/sh
set -eu

LABEL="com.riverse.settlement-worker"
REPO_DIR="/Volumes/SSD_MacMini_2/HermesWork/rvjp-human-system-diff-ui"
LOG_DIR="$HOME/Library/Logs/Riverse/settlement-worker"
STATE_DIR="$HOME/Library/Application Support/Riverse/settlement-worker"
WORKER_ENV_FILE="$STATE_DIR/worker.env"
RUNTIME_DIR="$STATE_DIR/runtime"
BUNDLE_REL="src/features/settlement/lib/worker/settlement-worker.bundle.mjs"
BUNDLE_PATH="$RUNTIME_DIR/$BUNDLE_REL"
TEMPLATE="$REPO_DIR/ops/$LABEL.plist.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
ENV_FILE="$REPO_DIR/.env.local"
ESBUILD="$REPO_DIR/node_modules/.bin/esbuild"

fail() {
  printf '%s\n' "settlement worker install: $1" >&2
  exit 1
}

[ -d "$REPO_DIR" ] || fail "repository directory is missing"
[ -f "$REPO_DIR/package.json" ] || fail "package.json is missing"
[ -f "$REPO_DIR/scripts/settlement-worker.ts" ] || fail "worker entrypoint is missing"
[ -f "$TEMPLATE" ] || fail "LaunchAgent template is missing"
[ -x "$ESBUILD" ] || fail "esbuild is missing; install dependencies before continuing"
[ -d "$REPO_DIR/node_modules/@napi-rs/canvas" ] || fail "Canvas runtime is missing"
[ -d "$REPO_DIR/node_modules/@napi-rs/canvas-darwin-arm64" ] || fail "Mac Canvas binding is missing"
[ -d "$REPO_DIR/node_modules/@tesseract.js-data/jpn" ] || fail "Japanese OCR data is missing"
[ -d "$REPO_DIR/node_modules/@tesseract.js-data/eng" ] || fail "English OCR data is missing"
[ -d "$REPO_DIR/node_modules/pdfjs-dist/cmaps" ] || fail "PDF CMap data is missing"
[ -d "$REPO_DIR/src/features/settlement/data" ] || fail "settlement assets are missing"
[ -f "$ENV_FILE" ] || fail ".env.local is missing"

NODE_PATH="$(command -v node || true)"
[ -n "$NODE_PATH" ] || fail "Node.js is not installed or not on PATH"
case "$NODE_PATH" in
  /*) ;;
  *) fail "Node.js executable path must be absolute" ;;
esac
case "$NODE_PATH" in
  *[!A-Za-z0-9_./-]*) fail "Node.js executable path contains unsupported characters" ;;
esac

NODE_MAJOR="$($NODE_PATH -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20 or newer is required"

umask 077
mkdir -p "$LOG_DIR" "$STATE_DIR" "$LAUNCH_AGENTS_DIR"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/settlement-worker-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
STAGED_RUNTIME="$TMP_DIR/runtime"
STAGED_ENV_FILE="$TMP_DIR/worker.env"
GENERATED_PLIST="$TMP_DIR/$LABEL.plist"
mkdir -p "$(dirname "$STAGED_RUNTIME/$BUNDLE_REL")"

"$NODE_PATH" --env-file="$ENV_FILE" -e '
  const fs = require("node:fs");
  const destination = process.argv[1];
  // Prefer RVJP_DB_ADMIN_TOKEN (Vercel Preview filters env names containing
  // SERVICE_ROLE_KEY); the older names are compatibility fallbacks.
  // Never fall back to anon/public keys.
  const serviceRoleKey =
    process.env.RVJP_DB_ADMIN_TOKEN ||
    process.env.RVJP_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  const entries = [
    ["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"],
    ["RVJP_DB_ADMIN_TOKEN", serviceRoleKey, "RVJP_DB_ADMIN_TOKEN (or RVJP_SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY)"],
    ["SUPABASE_DATABASE_URL", process.env.SUPABASE_DATABASE_URL, "SUPABASE_DATABASE_URL"],
  ];
  const lines = entries.map(([name, value, label]) => {
    if (!value || /[\r\n]/.test(value)) {
      throw new Error(`missing or invalid worker environment: ${label}`);
    }
    return `${name}=${JSON.stringify(value)}`;
  });
  fs.writeFileSync(destination, `${lines.join("\n")}\n`, { mode: 0o600 });
' "$STAGED_ENV_FILE"
chmod 600 "$STAGED_ENV_FILE"

"$ESBUILD" "$REPO_DIR/scripts/settlement-worker.ts" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --log-level=warning \
  --external:@napi-rs/canvas \
  --external:@napi-rs/canvas-* \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __f } from 'node:url'; import { dirname as __d } from 'node:path'; const require=__cr(import.meta.url); const __filename=__f(import.meta.url); const __dirname=__d(__filename);" \
  --outfile="$STAGED_RUNTIME/$BUNDLE_REL"

mkdir -p "$STAGED_RUNTIME/src/features/settlement"
cp -R "$REPO_DIR/src/features/settlement/data" "$STAGED_RUNTIME/src/features/settlement/data"
mkdir -p "$STAGED_RUNTIME/node_modules/pdfjs-dist"
cp -R "$REPO_DIR/node_modules/pdfjs-dist/cmaps" "$STAGED_RUNTIME/node_modules/pdfjs-dist/cmaps"
mkdir -p "$STAGED_RUNTIME/node_modules/@napi-rs" "$STAGED_RUNTIME/node_modules/@tesseract.js-data"
cp -R "$REPO_DIR/node_modules/@napi-rs/canvas" "$STAGED_RUNTIME/node_modules/@napi-rs/canvas"
cp -R "$REPO_DIR/node_modules/@napi-rs/canvas-darwin-arm64" "$STAGED_RUNTIME/node_modules/@napi-rs/canvas-darwin-arm64"
cp -R "$REPO_DIR/node_modules/@tesseract.js-data/jpn" "$STAGED_RUNTIME/node_modules/@tesseract.js-data/jpn"
cp -R "$REPO_DIR/node_modules/@tesseract.js-data/eng" "$STAGED_RUNTIME/node_modules/@tesseract.js-data/eng"

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__WORKER_ENV_FILE__|$WORKER_ENV_FILE|g" \
  -e "s|__BUNDLE_PATH__|$BUNDLE_PATH|g" \
  -e "s|__STATE_DIR__|$STATE_DIR|g" \
  "$TEMPLATE" > "$GENERATED_PLIST"
plutil -lint "$GENERATED_PLIST" >/dev/null || fail "generated LaunchAgent is invalid"

DOMAIN="gui/$(id -u)"
PREVIOUS_RUNTIME="$TMP_DIR/previous-runtime"
PREVIOUS_PLIST="$TMP_DIR/previous.plist"
PREVIOUS_ENV_FILE="$TMP_DIR/previous-worker.env"
HAD_PREVIOUS_RUNTIME=false
HAD_PREVIOUS_PLIST=false
HAD_PREVIOUS_ENV=false
WAS_LOADED=false

if [ -d "$RUNTIME_DIR" ]; then
  HAD_PREVIOUS_RUNTIME=true
fi
if [ -f "$PLIST" ]; then
  cp "$PLIST" "$PREVIOUS_PLIST" || fail "could not back up existing LaunchAgent"
  HAD_PREVIOUS_PLIST=true
fi
if [ -f "$WORKER_ENV_FILE" ]; then
  cp "$WORKER_ENV_FILE" "$PREVIOUS_ENV_FILE" || fail "could not back up existing worker environment"
  chmod 600 "$PREVIOUS_ENV_FILE"
  HAD_PREVIOUS_ENV=true
fi
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  WAS_LOADED=true
fi

bootstrap_with_retry() {
  attempt=0
  while [ "$attempt" -lt 3 ]; do
    if launchctl bootstrap "$DOMAIN" "$PLIST"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

rollback_install() {
  message="$1"
  set +e
  trap - HUP INT TERM
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  if [ -d "$PREVIOUS_RUNTIME" ]; then
    rm -rf "$RUNTIME_DIR"
    mv "$PREVIOUS_RUNTIME" "$RUNTIME_DIR"
  elif [ "$HAD_PREVIOUS_RUNTIME" = false ]; then
    rm -rf "$RUNTIME_DIR"
  fi
  if [ "$HAD_PREVIOUS_PLIST" = true ]; then
    install -m 600 "$PREVIOUS_PLIST" "$PLIST"
  else
    rm -f "$PLIST"
  fi
  if [ "$HAD_PREVIOUS_ENV" = true ]; then
    install -m 600 "$PREVIOUS_ENV_FILE" "$WORKER_ENV_FILE"
  else
    rm -f "$WORKER_ENV_FILE"
  fi
  if [ "$WAS_LOADED" = true ] && [ -f "$PLIST" ]; then
    bootstrap_with_retry >/dev/null 2>&1
  fi
  set -e
  fail "$message"
}

transition_interrupted() {
  rollback_install "installation interrupted"
}

# Staging failures only remove the temporary directory. From this point on the
# installed service may be partially replaced, so cooperative termination must
# restore runtime, plist, and worker.env before exiting.
trap 'transition_interrupted' HUP INT TERM

if [ "$WAS_LOADED" = true ]; then
  launchctl bootout "$DOMAIN/$LABEL" || rollback_install "LaunchAgent bootout failed"
  sleep 1
fi
if [ "$HAD_PREVIOUS_RUNTIME" = true ]; then
  mv "$RUNTIME_DIR" "$PREVIOUS_RUNTIME" || rollback_install "existing runtime backup failed"
fi
mv "$STAGED_RUNTIME" "$RUNTIME_DIR" || rollback_install "runtime install failed"
install -m 600 "$GENERATED_PLIST" "$PLIST" || rollback_install "LaunchAgent plist install failed"
install -m 600 "$STAGED_ENV_FILE" "$WORKER_ENV_FILE" || rollback_install "worker environment install failed"
: > "$LOG_DIR/stdout.log" || rollback_install "stdout log setup failed"
: > "$LOG_DIR/stderr.log" || rollback_install "stderr log setup failed"

bootstrap_with_retry || rollback_install "LaunchAgent bootstrap failed"
launchctl kickstart -k "$DOMAIN/$LABEL" || rollback_install "LaunchAgent kickstart failed"

READY=false
COUNT=0
while [ "$COUNT" -lt 20 ]; do
  if grep -q '\[settlement-worker\] started mode=loop' "$LOG_DIR/stdout.log"; then
    READY=true
    break
  fi
  sleep 1
  COUNT=$((COUNT + 1))
done
[ "$READY" = true ] || rollback_install "worker did not report ready within 20 seconds"

printf '%s\n' "Installed and started $LABEL"
printf '%s\n' "LaunchAgent: $PLIST"
printf '%s\n' "Logs: $LOG_DIR"
