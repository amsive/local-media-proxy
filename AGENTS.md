# Repository Guidelines

## Project Structure & Module Organization

Runtime TypeScript lives in `src/`. `main.ts` owns Local IPC and lifecycle work; `renderer.ts` provides the per-site UI; `marketplace.ts` supplies manual-install detail metadata. Keep validation in `validation.ts`, origin probing in `origin.ts`, Nginx generation in `nginx.ts`, and managed writes in `site-config.ts`. Tests use `tests/*.test.js`. Compiled `lib/` and packaged `dist/` output are generated and ignored. Root assets and `resources/` ship with the add-on.

## Build, Test, and Development Commands

- `npm install`: install development dependencies.
- `npm run build`: compile TypeScript into `lib/`.
- `npm test`: build and run Node unit/integration tests.
- `npm run typecheck`: check TypeScript without output.
- `npm run validate`: run public-release checks, type checks, tests, and an exact release-package build and verification.
- `npm run package:addon`: create the installable `local-media-proxy-v<version>.tgz` in `dist/`; release workflows attach its checksum.
- `npm run watch`: recompile during development.

Symlink the repository into Local’s add-ons directory for live development, then restart Local.

## Release Audit Workflow

When a new `vX.Y.Z` release tag or draft release is produced, or when asked to review changes since the last audit, read and follow `skills/audit-local-media-proxy-release/SKILL.md`. Keep the audit diff-focused and read-only, present complete issue drafts before creating anything, and require explicit approval before publishing GitHub issues. Follow `SECURITY.md` for confidential vulnerability reporting.

## AI-Assisted Release Preparation

When the user asks to prepare or draft a release, use AI judgment to analyze the complete change set from the previous exact SemVer tag to the proposed release commit. Do not accept GitHub's automatically generated pull-request list as final release copy, and do not add AI calls or prose-generation logic to GitHub Actions.

- Draft the dated `CHANGELOG.md` entry from the actual user-facing behavior, not from commit titles alone.
- Add a `Proposed release notes` section to the release-preparation pull request so the final copy is reviewable and persists outside the chat.
- Begin with one concise, version-neutral summary paragraph. Follow it with only populated, end-user-facing sections. Omit `Validation`, empty categories, and raw commit or pull-request lists. Use `New Features` only for actual Local application capabilities.
- Keep the pull-request summary, risk, and validation evidence separate from the end-user release notes.
- After the tag workflow creates its draft, compare the final tag with the previous release, update the proposed copy if the merged change set differs, replace the automatically generated draft body, and reread the saved GitHub release. Confirm the notes render correctly and that the release remains a draft prerelease with Latest disabled.

Human approval is still required before stable publication.

## Coding Style & Naming Conventions

Use tabs in TypeScript, JavaScript, and CSS; use two spaces in JSON. Follow strict TypeScript, small modules, `camelCase` functions, `PascalCase` interfaces, and uppercase constants. Never interpolate unvalidated renderer input into Nginx. Scope UI rules below `.LocalMediaProxy` and support `.Theme__Light` and `.Theme__Dark`.

All future loading animations must use Local’s native two-dot `LoadingIndicator` pattern. Prefer an officially exposed Local component if the add-on API provides one; otherwise reuse the scoped vendored adaptation documented in `style.css` and `NOTICE`. Hide initially unresolved controls and replace activated in-progress controls with the indicator, include accessible status text, respect reduced motion, and use bounded waits so a loader cannot stall indefinitely. When a focused control is temporarily replaced, return focus to the restored control or visible feedback only if the user has not deliberately moved focus elsewhere.

## Testing Guidelines

Use `node:test` and `node:assert/strict`; name files `*.test.js`. Add regressions for validation, generated Nginx, marker idempotency, rollback, and security headers. Release installers use the exact name `local-media-proxy-v<version>.tgz`, with a matching `.tgz.sha256`, and use npm's standard single top-level `package/` folder. The TGZ must contain only the compiled runtime, package metadata, CSS, runtime artwork and trust material, `LICENSE`, `NOTICE`, and the packaged `README`; source, tests, source maps, development configuration, and repository-only process documents are excluded. CI and promotion verification must enforce this contract. Before release, select the TGZ directly in Local without extracting it: existing uploads remain local, a missing image returns `200` with `X-Local-Media-Proxy: origin`, and disabling restores the prior `404`.

Every pull request and release must pass `npm run verify:public-release`. Do not commit client names, domains, infrastructure addresses, workstation paths, credentials, diagnostic configuration, individual email addresses, or unreviewed binary assets. This prohibition covers source and code comments, commit and tag metadata or messages, pull requests, issues, reviews, discussion comments, and release text. Individual contributors must use their GitHub-provided `noreply` identity; exact organization role addresses are allowed only through `public-release-policy.json`. Use only `example.com` hostnames and RFC documentation IPs in fixtures. Screenshots must use fictional data, show only the minimum useful sites, contain no automation overlays, pass local OCR review, and have an exact reviewed hash in `public-release-assets.json`. See `PUBLIC_RELEASE_SAFETY.md` for the complete process and its human-review limits.

## Commit & Pull Request Guidelines

Never commit directly to `main`. Use `feature/<slug>` for planned work or `issue/<id>-<slug>` for issue work. Every change to `main` requires a pull request and human review. Use short Conventional Commit subjects, explain behavior and risk, link issues, include validation output, and add light/dark screenshots for UI changes. Inspect every GitHub-bound title, body, and comment before posting and never include an individually assigned email address.

For screenshots committed to this repository, embed them in PR descriptions and comments with an absolute, commit-pinned same-host URL: `![alt text](https://github.com/amsive/local-media-proxy/raw/<head-commit-sha>/docs/screenshots/<file>.png)`. Use a commit SHA that contains the image. Do not use repository-relative paths, which GitHub can preserve unresolved in PR HTML, or direct `raw.githubusercontent.com` URLs. After saving the PR, inspect the rendered conversation and confirm the images themselves display; visible alt-text links are not sufficient verification.

Release tags use exact `vX.Y.Z` SemVer names and create draft prereleases. Uploaded assets must use `local-media-proxy-vX.Y.Z.tgz` and `local-media-proxy-vX.Y.Z.tgz.sha256` as both their visible GitHub labels and downloadable filenames. Human approval is required before stable publication.

## Security & Configuration Tips

Preserve managed markers and never edit Local’s generated runtime config. Proxy only read-only image requests below `/wp-content/uploads/`; strip credentials and cookies. Treat URLs, IPs, certificates, and filesystem boundaries as security-sensitive.
