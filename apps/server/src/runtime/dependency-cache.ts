import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PYTHON_SHIM = `#!/bin/sh
set -eu

real_python="\${LAUNCHPAD_SYSTEM_PYTHON:-/usr/bin/python3}"
bootstrap="\${LAUNCHPAD_PIP_BOOTSTRAP:-\${LAUNCHPAD_DEPENDENCY_CACHE:-.}/python/get-pip.py}"

ensure_pip() {
  if "$real_python" -m pip --version >/dev/null 2>&1; then
    return 0
  fi
  mkdir -p "$(dirname "$bootstrap")"
  if [ ! -s "$bootstrap" ]; then
    "$real_python" - "$bootstrap" <<'PY'
import sys
import urllib.request

urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", sys.argv[1])
PY
  fi
  "$real_python" "$bootstrap" --user --no-warn-script-location
}

if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  ensure_pip
  shift 2
  if [ "\${1:-}" = "install" ]; then
    shift
    managed_python_args="--user"
    if "$real_python" -m pip install --help 2>/dev/null | grep -q -- "--break-system-packages"; then
      managed_python_args="$managed_python_args --break-system-packages"
    fi
    exec "$real_python" -m pip install $managed_python_args "$@"
  fi
  exec "$real_python" -m pip "$@"
fi

exec "$real_python" "$@"
`;

const PIP_SHIM = `#!/bin/sh
set -eu

python3 -m pip "$@"
`;

const SHELL_ENV = `python3() { "$LAUNCHPAD_DEPENDENCY_CACHE/python/bin/python3" "$@"; }
python() { "$LAUNCHPAD_DEPENDENCY_CACHE/python/bin/python" "$@"; }
pip3() { "$LAUNCHPAD_DEPENDENCY_CACHE/python/bin/pip3" "$@"; }
pip() { "$LAUNCHPAD_DEPENDENCY_CACHE/python/bin/pip" "$@"; }
`;

export interface WorkerDependencyEnvironment {
  LAUNCHPAD_DEPENDENCY_CACHE: string;
  PIP_CACHE_DIR: string;
  UV_CACHE_DIR: string;
  NPM_CONFIG_CACHE: string;
  PYTHONUSERBASE: string;
  LAUNCHPAD_PIP_BOOTSTRAP: string;
  LAUNCHPAD_SYSTEM_PYTHON: string;
  BASH_ENV: string;
  PATH: string;
}

export async function prepareWorkerDependencyCache(
  config: { workerDependencyCacheDir: string },
): Promise<void> {
  const pythonBin = config.workerDependencyCacheDir + "/python/bin";
  await Promise.all([
    mkdir(config.workerDependencyCacheDir + "/pip", { recursive: true }),
    mkdir(config.workerDependencyCacheDir + "/uv", { recursive: true }),
    mkdir(config.workerDependencyCacheDir + "/npm", { recursive: true }),
    mkdir(pythonBin, { recursive: true }),
    mkdir(config.workerDependencyCacheDir + "/python/user", { recursive: true }),
  ]);
  await Promise.all([
    writeExecutable(pythonBin + "/python3", PYTHON_SHIM),
    writeExecutable(pythonBin + "/python", PYTHON_SHIM),
    writeExecutable(pythonBin + "/pip3", PIP_SHIM),
    writeExecutable(pythonBin + "/pip", PIP_SHIM),
    writeFile(config.workerDependencyCacheDir + "/python/shell-env.sh", SHELL_ENV, {
      encoding: "utf8",
      mode: 0o644,
    }),
  ]);
}

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { encoding: "utf8", mode: 0o755 });
  await chmod(file, 0o755);
}

export function workerDependencyEnvironment(
  config: { workerDependencyCacheDir: string },
  options: {
    runtimeCacheDir?: string;
    pathValue?: string | undefined;
    pathDelimiter?: string;
    systemPython?: string;
  } = {},
): WorkerDependencyEnvironment {
  const runtimeCacheDir = options.runtimeCacheDir ?? config.workerDependencyCacheDir;
  const delimiter = options.pathDelimiter ?? path.delimiter;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const prefix = [
    runtimeCacheDir + "/python/bin",
    runtimeCacheDir + "/python/user/bin",
  ].join(delimiter);
  return {
    LAUNCHPAD_DEPENDENCY_CACHE: runtimeCacheDir,
    PIP_CACHE_DIR: runtimeCacheDir + "/pip",
    UV_CACHE_DIR: runtimeCacheDir + "/uv",
    NPM_CONFIG_CACHE: runtimeCacheDir + "/npm",
    PYTHONUSERBASE: runtimeCacheDir + "/python/user",
    LAUNCHPAD_PIP_BOOTSTRAP: runtimeCacheDir + "/python/get-pip.py",
    LAUNCHPAD_SYSTEM_PYTHON: options.systemPython ?? "/usr/bin/python3",
    BASH_ENV: runtimeCacheDir + "/python/shell-env.sh",
    PATH: pathValue.length > 0 ? prefix + delimiter + pathValue : prefix,
  };
}
