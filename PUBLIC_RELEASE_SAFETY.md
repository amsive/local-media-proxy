# Public release safety

Public releases must contain only material that Amsive LLC can publish. This policy applies to source commits, pull-request and release text, screenshots, generated source archives, and the installable add-on.

## Blocking automated gate

Run this before every commit or push:

```bash
npm run verify:public-release
```

`npm run validate` runs the same check first and then runs the offline `npm run verify:third-party` provenance gate. Repository-mode scans inspect both staged Git-index bytes and any different working-tree bytes, so an unstaged edit cannot conceal sensitive content already prepared for commit. The validation, release, and promotion workflows repeat these checks against the tracked tree. Release validation also builds and scans both Git-generated ZIP and TAR source archives, while the package verifier scans every file in the exact `local-media-proxy-v<version>.tgz` installer before upload or promotion. It rejects any installer that does not use npm's single top-level `package/` folder, contains files outside the exact minimal runtime manifest, or violates the declared third-party material contract.

The gate rejects:

- common credentials, tokens, private keys, credential-bearing URLs, and suspicious secret assignments;
- individually assigned email addresses; only GitHub-provided `noreply` identities, synthetic fixture domains, and exact allowlisted organization role addresses are accepted;
- personal workstation paths, unapproved URL hostnames, common domains, high-confidence bare hostname values (including Nginx/config assignments), and any infrastructure IP address that is not an exact reviewed fixture;
- symlinks, disguised binary formats, archives, office documents, databases, and unreviewed binary assets;
- binary assets whose SHA-256 does not match `public-release-assets.json`;
- PNG metadata or trailing payloads and SVG active content or external resources.

`public-release-policy.json` is intentionally exact. Add a narrow exception only when a synthetic test requires it. Every exception must identify the path, rule, exact finding hash, and review reason. Never allow a customer domain suffix, an entire hosting tenant namespace, a broad directory, or an unrestricted public IP range.

## Identity and comment privacy

Individual email addresses must not appear in files, source or code comments, fixtures, authorship or committer metadata, DCO trailers, commit or annotated-tag messages, pull requests, issues, reviews, discussion comments, or release text. Contributors must use the GitHub-provided `noreply` identity. An organization role address is acceptable only when it is not assigned to an individual and is added as an exact `allowedEmailAddresses` entry in `public-release-policy.json`; never allow an entire company domain.

`npm run verify:public-release` enforces this rule for tracked and packaged text. `npm run verify:dco` enforces it for pull-request commits, while `npm run verify:git-identities` audits every locally reachable commit and annotated tag. GitHub does not provide a pre-submit hook that can guarantee a human-authored comment is clean before it is posted, so maintainers and automated agents must inspect GitHub-bound text before submission. If an address is posted, edit or delete the text promptly, preserve an internal incident record without the address, and complete the publication-boundary review before making the repository public.

## Client and diagnostic data

Never copy a client-supplied screenshot, configuration file, log, database, export, domain, IP address, path, or reproduction bundle into the repository. Use supplied evidence only for local diagnosis, then create a minimal synthetic regression with `example.com` hostnames, RFC documentation IP ranges, generic IDs, and fictional dates.

Client names can be ordinary words and may evade pattern matching. A maintainer must therefore review every changed filename, diff, commit message, pull-request title and body, comment, release note, identity field, and asset in context before publication.

## Screenshots and other assets

Create screenshots only from an isolated demonstration setup or replace every visible value with fictional data. Show only the minimum sites needed to explain the feature. Remove cursors, notifications, automation or recording overlays, account details, real timestamps, logos, filenames, domains, and addresses.

Before committing an image:

1. Inspect the full-resolution image in both visual and OCR passes locally.
2. Confirm every visible value is synthetic and that no identifying UI remains.
3. Re-encode it without EXIF, text chunks, or trailing data.
4. Record its exact SHA-256 and review reason in `public-release-assets.json`.
5. Rerun `npm run verify:public-release`.

Changing one byte invalidates the reviewed manifest entry and blocks validation. OCR is a review aid, not proof that a logo or faint text is safe.

## Publication boundary

Continuous integration runs after a branch is pushed. In a public repository, that is too late to prevent disclosure of a newly committed client value. Maintainers must run the gate locally before pushing. Work based on client evidence should remain in a private Amsive staging repository or private local branch, with only the reviewed synthetic commit mirrored to the public repository.

GitHub secret scanning and push protection should be enabled as an additional control. Repository rules should require this validation check, the DCO check, at least one human approval, code-owner review for policy, workflow, resource, and screenshot changes, and protection for release tags.

If sensitive material is ever pushed, stop publication immediately. Removing it in a later commit is insufficient: rotate any credential, sanitize GitHub metadata, rewrite every reachable branch and tag, rebuild affected releases, and coordinate object purging with GitHub Support or publish from a new clean repository.

Before changing repository visibility, inventory published releases and every advertised ref, including `refs/pull/*`. GitHub pull refs are read-only, and an immutable release can permanently lock its tag and generated source archives. If either surface retains material that must not become public, do not rely on a force-push: keep the original repository private or internal and use a GitHub Support-confirmed purge or a new clean repository.
