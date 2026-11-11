# Release, Changelog, and Packaging Discipline

## 1. Changelog and Release Notes
* **Audit the Authoritative Commit Baseline:** When updating `CHANGELOG.md` or preparing release notes, audit all commits from the previous release tag: `git log --oneline <previous-release-tag>..HEAD`. Never rely on session memory, recent turns, or unanchored branch comparisons.
* **Substantiate Claims from Diffs:** Cross-check every listed feature, security fix, bug resolution, and configuration default against actual commit diffs before asserting completion.

## 2. CI/CD, Tagging, and Publication
* **Verify Workflow Triggers Before Asserting Publication:** Inspect `.github/workflows/` to confirm exact trigger conditions. Distinguish branch-push CI verification from tag-triggered release pipelines. Never report that a package is released merely because branch commits were pushed.
* **Explicit Filesystem Paths for Package Artifacts:** When passing tarball or local artifact paths to package managers (e.g. `npm publish`), always use explicit relative paths (e.g. `./release-package/${filename}`). Unprefixed `<folder>/<file>` paths can be parsed as remote repository specs (such as GitHub shorthand) and cause unexpected network operations or permission failures.
* **Fail-Closed Registry Guards:** Automated publication guards querying registry state (`npm view`) must fail closed. Treat successful lookups as "already published." Treat unsuccessful lookups as blocking errors unless a structured registry response specifically proves that the exact requested version is absent. Never treat bare `E404`, generic `could not be found`, or network/auth errors as absence evidence, as registries frequently mask permission and authentication failures behind 404 responses.
