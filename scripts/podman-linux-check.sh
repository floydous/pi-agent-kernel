#!/usr/bin/env bash
# Run Agent Kernel checks in a disposable Linux container from a tracked-file snapshot.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/podman-linux-check.sh [--full] [suite-key ...]

Defaults to the focused Linux portability suites:
  atomic-metadata end-to-end spillover-isolation

Pass suite keys from tests/run-all.ts to select different focused suites.
Use --full to run npm test after the focused suites. The container runs npm ci
and typecheck first. Untracked/ignored files (including benchmark assets and .env)
are deliberately excluded from the snapshot.
EOF
}

full=0
suites=()
while (($#)); do
  case "$1" in
    --full) full=1 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; suites+=("$@"); break ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) suites+=("$1") ;;
  esac
  shift
done

if ! command -v podman >/dev/null 2>&1; then
  echo "podman CLI not found on PATH" >&2
  exit 127
fi
if ! podman info >/dev/null 2>&1; then
  echo "Podman is installed but unavailable. Check 'podman machine list' and start a machine." >&2
  exit 125
fi

repo_root="$(git rev-parse --show-toplevel)"
image="${PODMAN_NODE_IMAGE:-docker.io/library/node:24-bookworm}"
if ((${#suites[@]} == 0)); then
  suites=(atomic-metadata end-to-end spillover-isolation)
fi

printf 'Linux check snapshot: tracked/index files from %s\n' "$repo_root"
printf 'Host revision: %s\n' "$(git -C "$repo_root" rev-parse --short HEAD)"
printf 'Container image: %s\n' "$image"
printf 'Suites: %s\n' "${suites[*]}"
if ((full)); then echo 'Also running: full npm test'; fi

# Avoid Git Bash rewriting the image/container arguments. No host paths are passed to
# Podman: tar streams the tracked working-tree files into the disposable container.
git -C "$repo_root" ls-files -z --cached |
  tar -C "$repo_root" --null --files-from=- --ignore-failed-read -cf - |
  MSYS_NO_PATHCONV=1 podman run --rm -i --cgroups=disabled -e "PODMAN_RUN_FULL=$full" "$image" bash -lc '
    set -euo pipefail
    mkdir -p /workspace
    tar -xf - -C /workspace
    cd /workspace

    echo "=== Linux container ==="
    uname -a
    node --version
    npm --version
    printf "visible CPUs: "; nproc
    free -h
    if [[ -r /sys/fs/cgroup/memory.max ]]; then
      printf "cgroup memory.max: "; cat /sys/fs/cgroup/memory.max
    else
      echo "cgroup memory limit: unavailable"
    fi
    if [[ -r /sys/fs/cgroup/cpu.max ]]; then
      printf "cgroup cpu.max: "; cat /sys/fs/cgroup/cpu.max
    else
      echo "cgroup CPU limit: unavailable"
    fi

    echo "=== Install locked dependencies ==="
    npm ci --no-audit --no-fund
    echo "=== Typecheck ==="
    npm run typecheck

    failed=0
    run_check() {
      label="$1"
      shift
      tmp="$(mktemp -d /tmp/ak-podman-check.XXXXXX)"
      echo "=== ${label} (TMPDIR=${tmp}) ==="
      set +e
      TMPDIR="$tmp" "$@"
      result=$?
      set -e
      leftovers="$(find "$tmp" -type f -name "pi_bash_spillover_*" | wc -l | tr -d " ")"
      echo "${label} exit=${result}; prefixed temp artifacts before isolated cleanup=${leftovers}"
      case "$tmp" in /tmp/ak-podman-check.*) rm -rf -- "$tmp" ;; *) echo "Refusing unexpected temp path: $tmp" >&2; return 2 ;; esac
      if ((result != 0)); then failed=1; fi
    }

    for suite in "$@"; do
      run_check "suite:${suite}" npx tsx tests/run-all.ts "$suite"
    done
    if [[ "${PODMAN_RUN_FULL:-0}" == 1 ]]; then
      run_check "full-suite" npm test
    fi
    exit "$failed"
  ' bash "${suites[@]}"
