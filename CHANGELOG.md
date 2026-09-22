# Changelog

## [0.3.31] - 2026-09-22

### Added
- **Unified `/agent-kernel` Settings**: Added interactive modal and CLI commands (`status`, `set`, `reset`) for managing extension settings across workspace (`.pi/config.toml`) and global (`~/.pi/agent/config.toml`) scopes.
- **Spillover Hardening**: Enforced restrictive `0o600` permissions on temporary command output logs in `/tmp` with automated 20-file bounded rotation.

### Changed
- Removed repository-level `AGENTS.md` from git tracking.
