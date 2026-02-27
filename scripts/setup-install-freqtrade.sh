#!/usr/bin/env bash
set -euo pipefail

# Best-practice installer: separate provisioning from app runtime startup.
# Installs TA-Lib C runtime (if missing) + freqtrade in a dedicated project-local venv.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${THUNDERCLAW_FREQTRADE_VENV:-$ROOT_DIR/.thunderclaw/freqtrade-venv}"
PYTHON_BIN="${THUNDERCLAW_PYTHON_BIN:-python3}"
if [ -z "${THUNDERCLAW_PYTHON_BIN:-}" ]; then
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
REQ_FILE="${THUNDERCLAW_FREQTRADE_REQUIREMENTS:-$ROOT_DIR/scripts/freqtrade-requirements.txt}"
TA_LIB_PREFIX="${THUNDERCLAW_TA_LIB_PREFIX:-$ROOT_DIR/.thunderclaw/ta-lib}"
TA_LIB_VERSION="${THUNDERCLAW_TA_LIB_VERSION:-0.4.0}"
TA_LIB_URL="${THUNDERCLAW_TA_LIB_URL:-https://prdownloads.sourceforge.net/ta-lib/ta-lib-${TA_LIB_VERSION}-src.tar.gz}"

log() {
  echo "[thunderclaw] $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    log "missing command: $1"
    exit 1
  }
}


python_version_of() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true
}

ensure_python_supported() {
  local py="$1"
  local ver
  ver="$($py -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
  if [ -z "$ver" ]; then
    log "failed to detect python version for: $py"
    exit 1
  fi
  local major="${ver%%.*}"
  local minor="${ver##*.}"
  if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 10 ]; }; then
    log "python $ver is not supported for reliable freqtrade install (requires >=3.10)."
    log "set THUNDERCLAW_PYTHON_BIN to python3.10+ (for example: THUNDERCLAW_PYTHON_BIN=python3.10)."
    exit 1
  fi
}

install_build_deps_if_needed() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found, skip OS deps bootstrap"
    return
  fi
  if [ "$(id -u)" != "0" ]; then
    log "non-root user detected, skip apt-get bootstrap (assuming build deps already exist)"
    return
  fi
  log "ensuring OS build dependencies"
  DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    autoconf \
    automake \
    libtool \
    pkg-config \
    wget \
    curl \
    ca-certificates \
    file >/dev/null || true
}

ensure_talib_c_library() {
  local include_dir="$TA_LIB_PREFIX/include/ta-lib"
  local lib_so="$TA_LIB_PREFIX/lib/libta_lib.so"
  local lib_a="$TA_LIB_PREFIX/lib/libta_lib.a"

  if [ -f "$include_dir/ta_defs.h" ] && ([ -f "$lib_so" ] || [ -f "$lib_a" ]); then
    log "TA-Lib C library already present at $TA_LIB_PREFIX"
    return
  fi

  install_build_deps_if_needed
  require_cmd curl
  require_cmd tar
  require_cmd make
  require_cmd gcc

  mkdir -p "$TA_LIB_PREFIX"

  local build_root
  build_root="$(mktemp -d /tmp/thunderclaw-talib-XXXXXX)"

  log "installing TA-Lib C library (${TA_LIB_VERSION})"
  log "  source: $TA_LIB_URL"
  log "  prefix: $TA_LIB_PREFIX"

  curl -fsSL "$TA_LIB_URL" -o "$build_root/ta-lib.tar.gz"
  tar -xzf "$build_root/ta-lib.tar.gz" -C "$build_root"

  local src_dir
  src_dir="$(find "$build_root" -maxdepth 2 -type d -name 'ta-lib*' | head -n 1)"
  if [ -z "$src_dir" ]; then
    log "failed to locate extracted TA-Lib source dir"
    exit 1
  fi

  (
    cd "$src_dir"
    ./configure --prefix="$TA_LIB_PREFIX"
    make -j1
    make install
  )

  if [ ! -f "$include_dir/ta_defs.h" ]; then
    log "TA-Lib headers not found after install"
    rm -rf "$build_root"
    exit 1
  fi
  rm -rf "$build_root"
  log "TA-Lib C library installed"
}

log "provisioning freqtrade runtime"
log "  root: $ROOT_DIR"
log "  venv: $VENV_DIR"
log "  python: $PYTHON_BIN"
log "  requirements: $REQ_FILE"
log "  ta-lib prefix: $TA_LIB_PREFIX"

require_cmd "$PYTHON_BIN"
ensure_python_supported "$PYTHON_BIN"

if [ ! -f "$REQ_FILE" ]; then
  log "requirements file not found: $REQ_FILE"
  exit 1
fi

ensure_talib_c_library

if [ ! -x "$VENV_DIR/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
else
  venv_ver="$(python_version_of "$VENV_DIR/bin/python")"
  target_ver="$(python_version_of "$PYTHON_BIN")"
  if [ -n "$venv_ver" ] && [ -n "$target_ver" ] && [ "$venv_ver" != "$target_ver" ]; then
    log "existing venv python=$venv_ver differs from target python=$target_ver; recreating venv"
    rm -rf "$VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
fi

"$VENV_DIR/bin/python" -m pip install --upgrade pip wheel setuptools

# Ensure TA-Lib python build can find custom prefix in non-root environments.
export TA_INCLUDE_PATH="$TA_LIB_PREFIX/include"
export TA_LIBRARY_PATH="$TA_LIB_PREFIX/lib"
export CFLAGS="-I$TA_LIB_PREFIX/include ${CFLAGS:-}"
export LDFLAGS="-L$TA_LIB_PREFIX/lib ${LDFLAGS:-}"
export LD_LIBRARY_PATH="$TA_LIB_PREFIX/lib:${LD_LIBRARY_PATH:-}"

# Use project requirements to keep dependency versions explicit.
"$VENV_DIR/bin/python" -m pip install -r "$REQ_FILE"

if [ ! -x "$VENV_DIR/bin/freqtrade" ]; then
  log "freqtrade binary missing after install"
  exit 1
fi

"$VENV_DIR/bin/python" -m pip check >/dev/null

log "freqtrade installed: $VENV_DIR/bin/freqtrade"
log "set: THUNDERCLAW_FREQTRADE_CMD=$VENV_DIR/bin/freqtrade"
