# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Blocked individually assigned email addresses from source, package contents, commit metadata and trailers, annotated tags, and release automation; contributors now use GitHub `noreply` identities or exact approved organization role addresses.

## [0.2.3] - 2026-07-23

### Added

- Added machine-readable third-party provenance for the bundled Cloudflare Origin CA roots, the adapted Local loading indicator, and all direct development and peer dependencies.
- Added a deterministic offline release gate that detects changed Cloudflare hashes or fingerprints, missing attribution, undeclared direct dependencies or distributed materials, host-only dependency leakage, stale provenance, and installer trust-file drift.
- Added Local Media Proxy-specific bug and feature forms, a Contributor Covenant 2.1 code of conduct, clearer security scope and DCO email guidance, and monthly npm dependency updates.

### Changed

- Required third-party provenance verification during validation, continuous integration, release creation, promotion, and exact installer-package verification.
- Shortened the README into an installation and usage landing page and moved advanced proxy, TLS, Apache/Nginx, lifecycle, and managed-file details into dedicated technical documentation.
- Preserved the exact installer boundary and both unmodified Cloudflare Origin CA roots without weakening hostname, expiry, or certificate-chain validation.

## [0.2.2] - 2026-07-22

### Fixed

- Made apply, disable, toggle, rollback, and background reconciliation transactions fail safely when Local changes a site's web server, service identity, configuration paths, or lifecycle status mid-operation. Settings and managed files are restored, and only the currently selected service is eligible for recovery refresh. ([#16](https://github.com/amsive/local-media-proxy/issues/16))
- Limited user-triggered origin discovery to 30 seconds so a stalled hosting-provider request cannot leave the Tools panel locked. Controls recover in place with retry and manual-entry guidance, and late results are ignored. ([#17](https://github.com/amsive/local-media-proxy/issues/17))

## [0.2.1] - 2026-07-22

### Added

- Added independent saved connection profiles for Nginx and Apache so each server retains the setup appropriate to it when a Local site changes web servers.
- Added an Overview-tab proxy toggle with an accessible information tooltip, matching Local's compact status controls and reflecting the saved on/off intent even while the site is stopped.

### Changed

- Enabling or disabling the proxy now saves and applies immediately. **Save & apply** is reserved for connection-setup changes.
- Proxy status checks, enable and disable actions, and **Save & apply** now show Local's native two-dot progress indicator while unresolved controls are hidden.

### Fixed

- Reapplied a valid enabled proxy configuration automatically after Local switches a site between Nginx and Apache, without requiring a manual disable and re-enable cycle.
- Prevented background reconciliation and rollback from interfering with Local-owned templates while Local is changing web-server services.
- Disabled proxy activation controls when the active server does not yet have a complete saved connection profile and explained the required setup in the status tooltip.
- Matched the Overview proxy toggle, information icon, and tooltip to Local's native typography, spacing, motion, and colors in both light and dark themes.
- Bounded status and apply operations, including their recovery checks, so a stalled Local response cannot leave a loading indicator running indefinitely or later show an unverified state.

## [0.2.0] - 2026-07-21

### Added

- Added local-first Apache support using URL-only hostname routing, verified TLS, reversible managed templates, and server-specific controls. Its refresh path uses targeted compilation and managed-marker checks, runs `httpd -t`, then performs a bounded site-scoped `httpd -k graceful -f <site-config>` reload without restarting Apache. ([#12](https://github.com/amsive/local-media-proxy/issues/12))
- Added an Overview-tab proxy status row that distinguishes active, inactive, unavailable, and configuration-drift states. ([#11](https://github.com/amsive/local-media-proxy/issues/11))

### Changed

- Reordered connection setup around the Site URL and placed public-DNS discovery beside the Nginx Remote IP field it populates. ([#10](https://github.com/amsive/local-media-proxy/issues/10))
- Apache intentionally uses the Site URL hostname for DNS, HTTP `Host`, TLS SNI, and certificate verification instead of claiming Nginx's split IP/hostname behavior. HTTPS remains fail-closed when Local's platform bundle lacks `mod_ssl`; the current Intel macOS +11 bundle supports Apache HTTP origins only. ([#12](https://github.com/amsive/local-media-proxy/issues/12))

### Fixed

- Kept success and error feedback beside the action controls so results remain visible after testing or saving settings. ([#8](https://github.com/amsive/local-media-proxy/issues/8))
- Replaced raw socket and TLS failures with concise, actionable connection messages while preserving detailed causes in Local's log. ([#9](https://github.com/amsive/local-media-proxy/issues/9))

## [0.1.1] - 2026-07-21

### Security

- Kept build-job output out of the write-capable release job's shell source, revalidated exact SemVer from the tag, and bound the packaged version to that trusted release identity.
- Restricted public-release credential placeholders to explicit whole-value forms so embedded placeholder words cannot suppress source or installer findings.

## [0.1.0] - 2026-07-21

### Added

- Per-site Local controls for serving existing upload images locally and retrieving only missing WordPress upload images from a configured remote endpoint.
- Manual origin configuration, WP Engine environment discovery, and cautious public-DNS address suggestions that remain unapplied until reviewed and tested.
- Bounded, cancellable connection testing with hostname, certificate-chain, provider-identity, and HTTP-status validation.
- Local-first Nginx routing limited to read-only image requests beneath `/wp-content/uploads/`, with credentials, cookies, request bodies, and visitor-identifying headers stripped.
- Reversible managed configuration, safe rollback, legacy Local path support, deterministic trust-bundle handling, and compatibility with pre-existing custom Nginx locations.
- Light and dark Local UI, packaged overview and release metadata, and fictional screenshots containing only example sites and documentation addresses.
- Apache License 2.0 distribution with Amsive LLC attribution, NOTICE preservation, trademark boundaries, community support expectations, security guidance, and Developer Certificate of Origin sign-off.
- Blocking public-release validation for secrets, client identifiers, workstation paths, network values, unsafe files, source archives, installer contents, and exact reviewed asset hashes.
- Draft-first GitHub release automation with tagged-source verification, SHA-256 checksums, immutable asset identity checks, and explicit human promotion approval.
- Deterministic, Local-installable npm package releases named `local-media-proxy-v<version>.tgz`, with the standard `package/` root and an exact minimal runtime manifest enforced by continuous integration and release promotion checks.

### Changed

- Release automation now uses the exact versioned TGZ and checksum filenames as their visible GitHub labels, and promotion rejects any asset-name or label drift.

### Fixed

- Recovered from Local's stale Nginx master PID only when configuration validation succeeds and the reload fails with the exact stale-PID signal, restarting only the affected running site's Nginx service and otherwise failing closed.
- Prevented slow or cancelled connection probes from hanging the UI and replaced low-level timeout errors with actionable messages.
- Preserved correct TLS verification when switching between direct WP Engine origins and compatible proxy, CDN, or load-balancer endpoints.

[Unreleased]: https://github.com/amsive/local-media-proxy/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/amsive/local-media-proxy/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/amsive/local-media-proxy/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/amsive/local-media-proxy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/amsive/local-media-proxy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/amsive/local-media-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amsive/local-media-proxy/releases/tag/v0.1.0
