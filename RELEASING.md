# Releasing

Releases are built by GitHub Actions from an exact `v<SemVer>` tag. A read-only build job clean-installs locked dependencies without lifecycle scripts, validates the add-on, builds and inspects the installable TGZ, and preserves the verified assets. A separate write-scoped job creates a GitHub draft, attaches `local-media-proxy-v<version>.tgz` and `local-media-proxy-v<version>.tgz.sha256`, and preselects **prerelease** while explicitly leaving **Latest** off. The installer is an npm package with exactly one top-level `package/` folder and an exact minimal manifest containing only the compiled runtime, package metadata, CSS, runtime artwork and trust material, `LICENSE`, `NOTICE`, and the packaged `README`.

## Prepare the release

1. Move relevant `Unreleased` entries into a dated SemVer heading.
2. Set the same version in `package.json`, `package-lock.json`, and `src/constants.ts`, then refresh the changelog comparison links.
3. Add the new entry first in the packaged history in `src/marketplace.ts`. Keep only the five newest versions and preserve prior entries until they age out.
4. Follow `PUBLIC_RELEASE_SAFETY.md`: run `npm run verify:public-release`, review all exact policy exceptions, visually inspect and locally OCR each screenshot, and confirm every binary hash and review reason in `public-release-assets.json`.
5. Review new code, assets, dependencies, and notices for license compatibility, contributor authorization, client information, secrets, and trademark concerns. Confirm every contribution made after DCO adoption carries the required sign-off.
6. Confirm the package still contains the exact Apache `LICENSE`, `NOTICE`, support policy, and trademark policy and that release messaging does not promise a warranty or service level. Obtain explicit clearance for third-party material, including the bundled Cloudflare Origin CA roots and use of Local APIs, before the first public release.
7. Review changed filenames, commit messages, pull-request and issue text, comments, and generated release notes for identifying context that the source scanner cannot recognize.
8. Run `npm ci`, `npm run validate`, and `npm run package:addon` from a clean checkout.
9. Run `node scripts/verify-release-package.js v<version> dist/local-media-proxy-v<version>.tgz`. The verifier enforces the exact asset name, npm's single `package/` root, and the minimal packaged-file manifest.
10. Create clean Git ZIP and TAR archives for the release commit and scan their extracted contents with `node scripts/verify-public-release.js --root <directory> --require-manifest-completeness`.
11. Select that exact TGZ directly in Local's **Install from disk** flow without extracting it, then complete the end-to-end checklist in `CONTRIBUTING.md` against the minimum supported Local version, including the Installed Add-ons card, Overview and Release notes tabs, and both renderer themes.
12. Merge the release-ready commit to `main` and confirm the Validate workflow passes.

## Create the draft

Create and push an annotated tag using the exact package version:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Local Media Proxy v0.1.0 release"
git push origin v0.1.0
```

The `Release` workflow creates `Local Media Proxy v0.1.0` as a draft with generated notes and the tested archive plus its portable checksum. The prerelease option is already selected and Latest is disabled.

## Review the draft candidate

1. Open the draft in GitHub and review its generated notes, tag, installer, checksum, and automatically generated source ZIP/TAR downloads. Confirm the repository contains only reviewed public history and that no obsolete release or tag is exposed.
2. Before making a repository public, inventory all advertised refs, published releases, forks, and pull-request commits. Read-only pull refs and immutable release tags can preserve old source after normal history rewriting; if sensitive material remains, stop and obtain a GitHub Support-confirmed purge or publish from a new clean repository.
3. Download the attached `.tgz`, select it directly in Local without extracting it, and complete the release smoke test. Confirm it contains exactly one top-level `package/` folder and only the verified minimal runtime manifest. Do not install either automatically generated source archive.
4. Edit the draft if its notes need clarification. Keep **Set as a pre-release** selected and do not mark it Latest.
5. Do not publish the draft manually. It must remain a draft prerelease until the approval workflow completes.

## Approve and publish a stable release

1. Confirm the draft candidate and its attached installer passed review and release testing.
2. In GitHub Actions, run **Promote release** from the `main` branch. Supply the exact release tag, such as `v0.1.0`, and type `PROMOTE v0.1.0` in the confirmation field. Suffixed or otherwise non-SemVer tags cannot be promoted.
3. Review the read-only verification job. It confirms the release is still a draft prerelease, checks the expected `.tgz` and `.tgz.sha256`, validates the checksum, npm `package/` root, and minimal runtime manifest, rebuilds the distributable files from the annotated tag, compares every packaged file byte for byte, and records the release, tag commit, asset identities, and SHA-256 digests.
4. Approve the `release-approval` environment when prompted. The write-scoped job downloads the assets again and requires every recorded identity and digest to match immediately before publishing the draft as stable and Latest.

The manual dispatch and exact typed confirmation are always required, so no release becomes stable without an intentional human action. Before the first promotion, also create a repository environment named `release-approval` and configure required reviewers. When the GitHub plan supports it, prevent self-review and disallow administrator bypass; this adds an independent second-person approval gate.

Protect version tags matching `v*` in repository rules so only maintainers can create or update them. Prepare releases on a feature or issue branch and merge them to `main` through an approved pull request before tagging. CI and the promotion workflow must enforce the same TGZ filename, checksum, npm `package/` root, and minimal file-manifest contract. Never move or reuse a release tag, create a release from uncommitted files, or manually substitute an archive built from different source. If the workflow fails, fix the release commit, increment the version, and create a new release tag.
