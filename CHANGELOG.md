# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/amsive/local-media-proxy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/amsive/local-media-proxy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/amsive/local-media-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amsive/local-media-proxy/releases/tag/v0.1.0
