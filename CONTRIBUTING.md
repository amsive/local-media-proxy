# Contributing

Thank you for improving Local Media Proxy. Keep changes focused, reversible, and compatible with Local’s add-on APIs.

## Contribution licensing

Local Media Proxy is distributed under the [Apache License 2.0](LICENSE). Unless explicitly stated otherwise, intentionally submitted contributions are provided under that license as described in its Section 5.

Every new commit submitted after the project adopted the DCO must include a `Signed-off-by` line certifying the [Developer Certificate of Origin 1.1](DCO). Create it with `git commit --signoff` or add it during an interactive rebase. The sign-off uses your real name and your GitHub-provided `noreply` address. An exact organization role address may be used only when a maintainer has added it to `public-release-policy.json`; personal, employee, and other individually assigned addresses are not accepted. If an employer or another organization owns the work, confirm that you are authorized to contribute it before signing off. New pull-request commits with missing sign-offs are not eligible to merge.

The automated DCO check deliberately requires the `Signed-off-by` address to match the commit author address exactly, ignoring letter case. It also rejects individually assigned addresses in author, committer, commit-message, and annotated-tag metadata. Before committing, enable GitHub's email-privacy setting and copy the GitHub-provided `noreply` address shown in your email settings. Use that same address in both the commit metadata and sign-off. Correct both fields together when amending a commit:

```bash
git config user.name "Your Name"
git config user.email "123456+your-handle@users.noreply.github.com"
git commit --amend --reset-author --signoff
```

GitHub-authored Dependabot commits are the sole automated exception to human author/sign-off matching. The gate recognizes only the exact Dependabot author, GitHub committer, and GitHub support role-identity pattern emitted by the platform. For a GitHub-generated squash commit, every additional sign-off must match a recorded coauthor exactly, and every non-bot coauthor must have a matching sign-off. The exception does not allow general bot identities or the full `github.com` email domain.

Do not submit client information, credentials, private certificates, access tokens, individual email addresses, proprietary code, or material you do not have the right to license. This includes source and code comments, fixtures, commit metadata and trailers, annotated tags, pull requests, issues, review comments, discussion comments, and release text. Synthetic `example.com` addresses are allowed in tests, and exact organization role addresses may be allowlisted. License, copyright, `NOTICE`, and trademark-policy changes require explicit maintainer and legal review.

## Branch and review policy

Never commit directly to `main`. Create `feature/<slug>` for planned work or `issue/<id>-<slug>` for issue-backed work, then open a pull request to `main`. Every pull request requires human review before merge. Use a draft pull request while validation or release preparation is still in progress.

## Default feature validation

For an ordinary feature or bug fix, keep the local loop scoped to the changed behavior:

1. Install dependencies with `npm install` when the lockfile or local dependencies are not already available.
2. Add or update the directly relevant regression, then run `npm run test:focused -- tests/<relevant>.test.js` with the smallest useful set of test files.
3. Run `npm run verify:public-release` or `npm run verify:third-party` only when the change touches public content/assets, dependencies, trust material, package metadata, or related policy.
4. Record the focused result and skipped full-suite or release checks in the pull request. The Validate workflow remains the authoritative full PR gate.

Do not run the full local checklist for every feature. Use it when preparing a release, changing dependencies or the lockfile, package/release files, workflows, public-release safety, third-party provenance, DCO/identity behavior, or when a maintainer explicitly requests full validation. Codex Security scans are not part of this checklist; they require a separate explicit user request.

## Full local validation checklist (conditional)

1. Install dependencies with `npm install`.
2. Run `npm run verify:public-release`, `npm run verify:third-party`, `npm run verify:dco`, and `npm run verify:git-identities`; review exact safety, provenance, identity, and asset-manifest changes; then run `npm run validate`.
3. Build the packed artifact with `npm run package:addon`, verify `dist/local-media-proxy-v<version>.tgz`, and confirm the TGZ uses npm's single `package/` root and contains only the verified minimal runtime manifest. Select the TGZ directly in Local’s **Install from disk** flow without extracting it. The release workflow generates and verifies the matching `.tgz.sha256` attachment.
4. Confirm the Installed Add-ons card shows the Amsive icon and purple background, `Local Media Proxy`, `by Amsive`, the expected version, and the one-line summary.
5. Open the card icon and confirm the native **Overview** and **Release notes** tabs render without an alert, including the packaged artwork and contributor credits. The release tab must show the current version first and no more than five versions total.
6. For renderer changes, commit readable screenshots from both Local light and dark themes. Use only fictional sites and documentation addresses, show the minimum useful site list, remove automation overlays, run local OCR, and record the reviewed SHA-256 in `public-release-assets.json`.
7. Embed each committed screenshot in the PR description with `![alt text](https://github.com/amsive/local-media-proxy/raw/<head-commit-sha>/docs/screenshots/<file>.png)`, using a commit SHA that contains the image. Use the absolute, commit-pinned `github.com` URL rather than a repository-relative path or direct `raw.githubusercontent.com` URL.
8. After saving the PR description, inspect its rendered view and confirm the images themselves display. Also confirm the rendered HTML contains an absolute `https://github.com/amsive/local-media-proxy/raw/…` image source. A broken-image icon with linked alt text does not pass this check.
9. For proxy changes, verify a local file remains local, a safe missing production asset receives `X-Local-Media-Proxy: origin`, a blocked asset never reaches the origin, and disabling returns the site to its prior behavior.
10. For lifecycle changes and every release candidate, complete the mandatory lifecycle isolation test in `RELEASING.md`: use sequentially numbered `Local Media Proxy Test Site N` fixtures, cover creation and deletion while both running and halted, run the automated initial-pull transition regressions, and review only log bytes and lines after recorded starting offsets. Never start a Local pull or push for this checklist. Any separately approved live transfer must use the predesignated non-production transfer-test site, be reconfirmed immediately before execution, and be database-only with every file and media path excluded.
11. Keep raw Local and WP Engine logs, workstation paths, environment or install names, domains, IP addresses, and process details local and untracked. Include only sanitized PR evidence: fixture numbers, flows exercised, pass/fail outcomes, reviewed log ranges, and redacted error classifications.
12. Review every changed filename, diff, commit message, PR field, comment, and release note for client or proprietary context that an automated pattern cannot recognize. Confirm that no individually assigned email address appears in any repository or GitHub text.
13. Add an entry under `CHANGELOG.md` → `Unreleased` for user-visible changes. During release preparation, curate those entries into one concise, version-neutral summary paragraph followed by populated, end-user-facing sections. Omit empty categories and `Validation`, keep `New Features` limited to actual Local application capabilities, and never substitute a generated commit or pull-request list for reviewed prose.

Local cannot overwrite an installed add-on with the same slug. For manual upgrade testing, disable and remove the current Local Media Proxy installation before selecting the replacement TGZ directly.

Use short Conventional Commit-style subjects. Prefer one logical change per commit and do not commit `lib/`, `dist/`, `node_modules/`, diagnostic site configuration, client-supplied evidence, certificates, or Local application data. Follow [PUBLIC_RELEASE_SAFETY.md](PUBLIC_RELEASE_SAFETY.md) for the blocking content and asset review process.

## Design constraints

- Renderer input is untrusted until the main process validates it.
- Filesystem writes must stay within the selected Local site.
- Transitional sites permit no managed-file reads or writes and no settings writes.
- Revalidate lifecycle readiness immediately before every managed write, atomic rename, unlink, and rollback restoration.
- Only managed marker content may be inserted into `site.conf.hbs`.
- The proxy must remain local-first, read-only, limited to safe missing files below `/wp-content/uploads/`, and free of credentials, cookies, unapproved incoming headers, or request bodies.
- Disabling and rollback must restore the pre-add-on configuration only while the site remains lifecycle-ready; a transition stops restoration without recreating Local-owned state.
- Global disable and uninstall may synchronously remove managed files only for a lifecycle-ready site, with the site and server transaction revalidated before each operation; all remaining cleanup and runtime refresh work stays deferred.
- Deferred global cleanup for a transitional site must remain pending but dormant while global disable or uninstall is active. Re-enable, a site-deleted notification, or disappearance of the site record must cancel it; cancelled cleanup must never become reconciliation or access managed files afterward.
- The marketplace metadata fallback must match only Local Media Proxy detail queries, pass through all other requests, and defer to a future official listing.

Discuss changes beyond the guarded uploads path, persistent caching, or the executable/secret-file blocklist before implementation because each changes the security and compatibility model.
