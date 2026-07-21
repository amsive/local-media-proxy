# Contributing

Thank you for improving Local Media Proxy. Keep changes focused, reversible, and compatible with Local’s add-on APIs.

## Contribution licensing

Local Media Proxy is distributed under the [Apache License 2.0](LICENSE). Unless explicitly stated otherwise, intentionally submitted contributions are provided under that license as described in its Section 5.

Every new commit submitted after the project adopted the DCO must include a `Signed-off-by` line certifying the [Developer Certificate of Origin 1.1](DCO). Create it with `git commit --signoff` or add it during an interactive rebase. The sign-off uses your real name and an email address you are authorized to associate with the public contribution. If an employer or another organization owns the work, confirm that you are authorized to contribute it before signing off. New pull-request commits with missing sign-offs are not eligible to merge.

Do not submit client information, credentials, private certificates, access tokens, proprietary code, or material you do not have the right to license. License, copyright, `NOTICE`, and trademark-policy changes require explicit maintainer and legal review.

## Branch and review policy

Never commit directly to `main`. Create `feature/<slug>` for planned work or `issue/<id>-<slug>` for issue-backed work, then open a pull request to `main`. Every pull request requires human review before merge. Use a draft pull request while validation or release preparation is still in progress.

## Before opening a pull request

1. Install dependencies with `npm install`.
2. Run `npm run verify:public-release` and `npm run verify:dco`, review exact safety exceptions and asset-manifest changes, then run `npm run validate`.
3. Build the packed artifact with `npm run package:addon`, verify `dist/local-media-proxy-v<version>.tgz`, and confirm the TGZ uses npm's single `package/` root and contains only the verified minimal runtime manifest. Select the TGZ directly in Local’s **Install from disk** flow without extracting it. The release workflow generates and verifies the matching `.tgz.sha256` attachment.
4. Confirm the Installed Add-ons card shows the Amsive icon and purple background, `Local Media Proxy`, `by Amsive`, the expected version, and the one-line summary.
5. Open the card icon and confirm the native **Overview** and **Release notes** tabs render without an alert, including the packaged artwork and contributor credits. The release tab must show the current version first and no more than five versions total.
6. For renderer changes, commit readable screenshots from both Local light and dark themes. Use only fictional sites and documentation addresses, show the minimum useful site list, remove automation overlays, run local OCR, and record the reviewed SHA-256 in `public-release-assets.json`.
7. Embed each committed screenshot in the PR description with `![alt text](https://github.com/amsive/local-media-proxy/raw/<head-commit-sha>/docs/screenshots/<file>.png)`, using a commit SHA that contains the image. Use the absolute, commit-pinned `github.com` URL rather than a repository-relative path or direct `raw.githubusercontent.com` URL.
8. After saving the PR description, inspect its rendered view and confirm the images themselves display. Also confirm the rendered HTML contains an absolute `https://github.com/amsive/local-media-proxy/raw/…` image source. A broken-image icon with linked alt text does not pass this check.
9. For proxy changes, verify a local file remains local, a missing production image receives `X-Local-Media-Proxy: origin`, and disabling returns the site to its prior behavior.
10. Review every changed filename, diff, commit message, PR field, comment, and release note for client or proprietary context that an automated pattern cannot recognize.
11. Add an entry under `CHANGELOG.md` → `Unreleased` for user-visible changes.

Local cannot overwrite an installed add-on with the same slug. For manual upgrade testing, disable and remove the current Local Media Proxy installation before selecting the replacement TGZ directly.

Use short Conventional Commit-style subjects. Prefer one logical change per commit and do not commit `lib/`, `dist/`, `node_modules/`, diagnostic site configuration, client-supplied evidence, certificates, or Local application data. Follow [PUBLIC_RELEASE_SAFETY.md](PUBLIC_RELEASE_SAFETY.md) for the blocking content and asset review process.

## Design constraints

- Renderer input is untrusted until the main process validates it.
- Filesystem writes must stay within the selected Local site.
- Only managed marker content may be inserted into `site.conf.hbs`.
- The proxy must remain local-first, read-only, upload-image-only, and free of incoming client headers or request bodies.
- Disabling and rollback must restore the pre-add-on configuration.
- The marketplace metadata fallback must match only Local Media Proxy detail queries, pass through all other requests, and defer to a future official listing.

Discuss Apache support, additional media types, caching, or a broader proxy scope before implementation because each changes the security and compatibility model.
