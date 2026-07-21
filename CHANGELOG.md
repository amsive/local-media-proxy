# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Nothing yet.

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

### Fixed

- Recovered from Local's stale Nginx master PID only when configuration validation succeeds and the reload fails with the exact stale-PID signal, restarting only the affected running site's Nginx service and otherwise failing closed.
- Prevented slow or cancelled connection probes from hanging the UI and replaced low-level timeout errors with actionable messages.
- Preserved correct TLS verification when switching between direct WP Engine origins and compatible proxy, CDN, or load-balancer endpoints.

[Unreleased]: https://github.com/amsive/local-media-proxy/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amsive/local-media-proxy/releases/tag/v0.1.0
