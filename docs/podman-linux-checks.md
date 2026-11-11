# Podman-Backed Linux Checks from Windows

Guidelines for running disposable Linux container tests from Windows:

1. **Pre-flight Machine Verification:**
   - Run `podman --version`, `podman machine list`, `podman system connection list`, and `podman info` before running containers.
   - An installed CLI does not mean a Linux machine exists or is running. Do not initialize or start a machine without authorization (`machine init` downloads an image and allocates disk/RAM/CPU).
   - Inspect available host resources before initialization.

2. **WSL Resource Limits & Fallbacks:**
   - On WSL, compare configured resources (`podman machine inspect`) with container reports (`nproc`, `free -h`, cgroup limits).
   - If Podman fails due to unavailable controllers (e.g. `pids`), `podman run --cgroups=disabled` may work, though resource limits will not be enforced. State this limitation explicitly.

3. **Path Conversion in MSYS2 / Git Bash:**
   - Git Bash / MSYS may rewrite Windows path arguments. Prefer streaming a tracked source snapshot into the container (`scripts/podman-linux-check.sh`) over host bind mounts.
   - If a Windows path must be passed, set `MSYS_NO_PATHCONV=1` for that command and verify the resolved container path.

4. **Disposable Containers & Temp Isolation:**
   - Use a disposable container and a fresh Linux `TMPDIR`. Do not inspect or modify shared host temp directories.
   - Include tracked working-tree files only; untracked/ignored files (including local benchmarks and `.env` files) must remain excluded. Never copy secrets into a container.

5. **Recovery & Cleanup:**
   - Inspect `podman ps -a` and container logs after timeouts.
   - Stop and remove only the specific disposable container created for the task. Never use broad prune or reset commands.
