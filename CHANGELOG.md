# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-04

This release expands the local-first fallback to safe missing upload assets and makes saved site state converge reliably across add-on and web-server changes.

### Added

- Missing video, audio, caption, document, font, archive, generated stylesheet, data, manifest, and future upload formats can now stream from the configured origin without maintaining an extension allowlist. Existing eligible local files always win, while unsafe executable, browser-active, hidden, configuration, secret, database, backup, and malformed upload paths fail closed instead of falling through to another proxy rule. Browser execution destinations are rejected before proxying, and upstream redirect targets are not exposed to the local browser. ([#32](https://github.com/amsive/local-media-proxy/issues/32))
- Read-only range requests now support seeking and partial downloads for video, audio, and documents on both Nginx and Apache. Query strings are preserved for cache busting while credentials, cookies, request bodies, standard browser identity, and tracing headers remain stripped. Origin-controlled cookies, browser-state controls, reporting endpoints, and conflicting security headers are also removed. ([#32](https://github.com/amsive/local-media-proxy/issues/32))

### Changed

- First-time web-server profile changes carry only a validated canonical Site URL into a truly untouched destination profile. Apache-to-Nginx changes still require their own remote IP, and existing or intentionally cleared profiles are never overwritten. ([#33](https://github.com/amsive/local-media-proxy/issues/33))
- Updated the development-only `@types/node` declaration package and its recorded provenance from 26.1.1 to 26.1.2 through Dependabot [#35](https://github.com/amsive/local-media-proxy/pull/35). This maintenance change does not alter the packaged runtime.
- Updated the optional `undici` package in the development-only Local SDK dependency tree from 7.28.0 to 7.29.0 through Dependabot [#37](https://github.com/amsive/local-media-proxy/pull/37), incorporating upstream security fixes without changing the packaged add-on runtime.

### Fixed

- Per-site enabled intent now survives global add-on disable and uninstall. Re-enabling or reinstalling v0.4.0 reapplies valid profiles while invalid profiles remain fail-closed without losing the user's saved intent. Replacing an earlier release may require enabling a site once because the earlier uninstaller runs before v0.4.0 is installed. ([#31](https://github.com/amsive/local-media-proxy/issues/31))
- Server switches, same-value repair requests, settings changes, and confirmed startup drift now verify that managed source and compiled configuration converge before settings are committed. An unchanged previously verified profile reuses its saved connection verification instead of waiting on the remote provider; changed profiles and explicit connection tests still probe the origin. Running services receive one validated, site-scoped refresh; stopped sites remain stopped, and failures restore the prior files and settings. ([#34](https://github.com/amsive/local-media-proxy/issues/34))
- Clean disabled profiles and already-converged enabled profiles no longer trigger routine background Nginx reloads. If Local interrupts an in-flight compile, one newer lifecycle event may perform one recovery refresh; otherwise a failed background refresh is reported once and stops instead of entering a one-second retry storm. ([#38](https://github.com/amsive/local-media-proxy/issues/38))
- Web-server activation no longer depends on Local's service identifier matching the runtime process name. Before a running-site action requires a runtime refresh, Media Proxy confirms the selected Nginx or Apache process actually started; an already-failed service now leaves settings and files untouched instead of spawning another process against an occupied internal port. The error identifies the Local and site logs needed for diagnosis and distinguishes Local's separate domain-router conflict, which the add-on never stops or reconfigures. If Nginx becomes stale after that check, its exact stale-master-PID error permits one targeted restart during the explicit action, and the replacement must accept one site-scoped reload before settings are saved. Apache retains its validated graceful reload, and background reconciliation never restarts either site service. ([#39](https://github.com/amsive/local-media-proxy/issues/39))
- Apache no longer rejects an otherwise safe missing upload merely because a browser or extension adds a new request-header name. Known credentials, cookies, nonces, forwarding headers, and browser identity headers remain stripped before the fixed origin request. ([#32](https://github.com/amsive/local-media-proxy/issues/32))
- Nginx apply now performs one targeted compilation, one syntax check, and one graceful reload. It no longer runs a full configuration dump, preflights the PID file, or repeatedly polls the process table, keeping apply time independent of site size and within the UI's bounded wait. ([#39](https://github.com/amsive/local-media-proxy/issues/39))
- Background reconciliation now checks saved WP Engine provenance locally and compares only primitive service identity and path fields. It no longer waits on provider APIs or recursively serializes Local's complete service metadata while holding a site's operation queue, keeping startup work independent of site complexity. ([#38](https://github.com/amsive/local-media-proxy/issues/38))
- Untouched disabled Nginx profiles remain unchanged during passive startup and lifecycle checks; only sites with meaningful saved Media Proxy state enter background reconciliation. ([#34](https://github.com/amsive/local-media-proxy/issues/34))
- Legacy settings from v0.1.0 through v0.3.1 now migrate into the current managed routes without inventing unsupported historical marker formats. ([#34](https://github.com/amsive/local-media-proxy/issues/34))

## [0.3.1] - 2026-07-30

This patch restores Media Proxy setup for running Apache sites while preserving Local site-lifecycle protections.

### Fixed

- Running Apache sites no longer remain on the web-server preparation screen when Local's core Apache templates are ready but the add-on's own `includes` directory has not been created yet. ([#29](https://github.com/amsive/local-media-proxy/issues/29))
- Apache setup now creates only its add-on-owned managed-file directory, while continuing to block access during site creation, replacement, and deletion. Nginx readiness and managed-file behavior are unchanged.

## [0.3.0] - 2026-07-27

This release keeps Local Media Proxy out of Local's way during site creation, first WP Engine pulls, and deletion, while refreshing the add-on artwork shown throughout Local.

### Changed

- Local Media Proxy now waits until Local reports a site as running or halted before inspecting or reconciling it. Lifecycle checks stay bounded and do not delay Local's provisioning or pull workflow.
- Refreshed the Installed Add-ons card and add-on detail artwork with purpose-sized vector canvases while preserving the approved `#6E187A` background.
- Future releases now require creation, deletion, and log-review smoke tests, with first-pull transition behavior covered by automated regressions.

### Fixed

- Prevented the add-on from resolving site paths or touching managed files while Local is creating, replacing, or deleting a site. Stale cleanup, reconciliation, and rollback work is cancelled or deferred whenever readiness changes.
- Settings are saved only after managed-file changes and runtime refreshes succeed, and transitional sites remain quiet in the UI instead of displaying missing-path errors or an indefinite loading indicator.
- Corrected the packaged README so its installer inventory matches the exact 26-entry release package.

## [0.2.4] - 2026-07-24

### Changed

- Added consistent campaign attribution to Amsive links in the public README and installed add-on metadata, distinguishing GitHub README, Local add-on detail, and package-author referrals.

### Fixed

- Restored the reviewed origin-discovery screenshot in the public and packaged README without linking to the removed commit history.

## [0.2.3] - 2026-07-23

### Added

- Added machine-readable third-party provenance for the bundled Cloudflare Origin CA roots, the adapted Local loading indicator, and all direct development and peer dependencies.
- Added a deterministic offline release gate that detects changed Cloudflare hashes or fingerprints, missing attribution, undeclared direct dependencies or distributed materials, host-only dependency leakage, stale provenance, and installer trust-file drift.
- Added Local Media Proxy-specific bug and feature forms, a Contributor Covenant 2.1 code of conduct, clearer security scope and DCO email guidance, and monthly npm dependency updates.

### Changed

- Required third-party provenance verification during validation, continuous integration, release creation, promotion, and exact installer-package verification.
- Shortened the README into an installation and usage landing page and moved advanced proxy, TLS, Apache/Nginx, lifecycle, and managed-file details into dedicated technical documentation.
- Preserved the exact installer boundary and both unmodified Cloudflare Origin CA roots without weakening hostname, expiry, or certificate-chain validation.
- Updated the development-only TypeScript, Node declaration, and TLS fixture toolchain and migrated compiler resolution to NodeNext without adding runtime dependencies.

### Security

- Blocked individually assigned email addresses from source, package contents, commit metadata and trailers, annotated tags, and release automation; contributors now use GitHub `noreply` identities or exact approved organization role addresses.
- Preserved strict human author/sign-off matching while recognizing GitHub-generated Dependabot squash metadata only when every additional sign-off matches a recorded coauthor.

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

[Unreleased]: https://github.com/amsive/local-media-proxy/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/amsive/local-media-proxy/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/amsive/local-media-proxy/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/amsive/local-media-proxy/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/amsive/local-media-proxy/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/amsive/local-media-proxy/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/amsive/local-media-proxy/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/amsive/local-media-proxy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/amsive/local-media-proxy/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/amsive/local-media-proxy/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/amsive/local-media-proxy/releases/tag/v0.1.0
