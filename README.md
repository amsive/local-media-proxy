# Local Media Proxy

Local Media Proxy is an [Amsive](https://www.amsive.com/) add-on for [Local](https://localwp.com/) that keeps WordPress uploads out of local clones without breaking image-heavy pages. For each Local site, it serves files already present under `wp-content/uploads` and fetches only missing images from a configured remote site, whether that site is a production, staging, or development environment.

Local Media Proxy is open-source, community-supported software released under the [Apache License 2.0](LICENSE).

![Local Media Proxy overview](./resources/detail-hero.svg)

## What it does

- Enables or disables the fallback independently for each Local site.
- Requires the remote Site URL and a remote IP address.
- Discovers connected WP Engine Production, Staging, and Development environments, using each environment's primary domain for Site URL and its direct `.wpengine.com` data for provider-recommended remote-IP discovery.
- Can resolve public DNS address candidates from a manually entered Site URL when provider-specific discovery is unavailable.
- Connects to the supplied IP while preserving the Site URL hostname for HTTP `Host`; WP Engine discovery separately preserves the direct `.wpengine.com` hostname for TLS SNI and certificate verification, and manual WP Engine origins can securely recognize the provider certificate during testing.
- Limits fallback requests to image extensions below `/wp-content/uploads/`.
- Allows only `GET` and `HEAD`; forwards no incoming client headers or request bodies and sends only the configured Site URL `Host` plus a fixed, non-visitor-identifying add-on `User-Agent` upstream.
- Streams responses without Nginx proxy buffering or a persistent local media cache.
- Uses Local-native controls and explicit light/dark theme styles.

The URL and IP are intentionally separate. The Site URL supplies the HTTP virtual-host identity, while the remote IP selects where Local sends the request. That IP may be a direct origin, CDN or proxy edge, or load balancer as long as it serves the Site URL and, for HTTPS, passes certificate validation. Provider-supplied direct origins are usually more stable; public-DNS addresses may be shared or change and must be tested. WP Engine discovery verifies TLS against the selected environment's validated direct `.wpengine.com` CNAME because its direct server can present that certificate while HTTP requests still require the primary/custom domain in `Host`. It prefers provider-supplied stable IPs and otherwise resolves that direct CNAME for candidates. The separate generic DNS lookup may return an origin, proxy, CDN, or load balancer.

## Requirements and current scope

- Local 10.1.1 or newer
- A Local site using Nginx
- A standard WordPress uploads path: `/wp-content/uploads/`
- Network access from the workstation to the supplied remote IP and Site URL port

Apache sites are detected and left unchanged. The add-on proxies image files only; it does not proxy PDFs, video, audio, themes, plugins, API calls, or arbitrary missing URLs.

## Install from a release

1. Download `local-media-proxy-v<version>.tgz` from the matching [GitHub release](https://github.com/amsive/local-media-proxy/releases). Optionally verify it against the attached `local-media-proxy-v<version>.tgz.sha256` file.
2. Open Local and go to **Add-ons → Installed**.
3. Choose **Install from disk** and select the `.tgz` directly.
4. Enable the add-on and restart Local if prompted.

The TGZ is the installable artifact; do not extract it first or select GitHub's automatically generated source archives. It uses npm's standard single top-level `package/` folder and contains only the files required to run and identify the add-on in Local.
When manually updating an existing installation, first disable and remove the installed Local Media Proxy entry. Local does not overwrite an add-on that already uses the same slug.

## Installed add-on details

Select the Local Media Proxy icon under **Add-ons → Installed** to open its native Local detail page. The **Overview** tab explains installation, configuration, request flow, scope, and troubleshooting. The **Release notes** tab shows the current release first and retains at most the five most recent packaged versions.

Local normally loads this screen from its public add-on marketplace. Because Local Media Proxy can also be installed manually from disk, its renderer supplies narrowly scoped packaged metadata only when the marketplace returns no listing for `local-media-proxy` or is unavailable. Other add-ons and GraphQL operations are passed through unchanged, and a future official marketplace listing takes precedence over the packaged fallback. This compatibility layer is tested against Local 10.1.1 and should be revalidated when Local’s marketplace implementation changes.

## Configure a site

1. Select the site in Local.
2. Open **Tools → Media Proxy**.
3. Choose the connection-setup path that fits the selected Local site:
   - **WP Engine:** Select the connected Production, Staging, or Development environment, then choose **Auto-populate from WP Engine**. The add-on suggests the environment's primary domain as Site URL, obtains remote-IP candidates from WP Engine's stable IPs or DNS for its direct `.wpengine.com` CNAME, and retains that CNAME internally for TLS verification.
   - **Flywheel:** Enter the Site URL manually. The tested Local API does not expose a supported Flywheel environment interface to add-ons, so provider-specific auto-population is not available. You may use **Find IP addresses** when public DNS is appropriate.
   - **Other hosts:** Enter the Site URL, such as `https://example.com`, then optionally choose **Find IP addresses** to resolve address candidates.
4. Review the suggested Site URL and remote IP. If multiple addresses are returned, select one you understand. A provider-supplied direct origin is preferred, but compatible proxy, CDN, or load-balancer addresses can work and may change.
5. Select **Test connection**. This checks endpoint reachability and, for HTTPS, certificate identity and trust—not a media file. While the test is running, the button shows progress and becomes **Stop test** so the probe can be cancelled.
6. Turn on **Enable for this site**, then select **Save & apply**.
7. Load an actual upload that is missing locally through the Local site. Confirm HTTP 200 and the response header `X-Local-Media-Proxy: origin`.

Enter only the Site URL scheme and hostname, plus an optional port: do not include a path, query string, credentials, or fragment. A trailing slash is optional; the add-on normalizes the saved value consistently. Auto-populated values are suggestions only; they are never saved or enabled automatically, and should be tested before you explicitly apply them.

Local Media Proxy compiles and validates the site’s Nginx templates, then gracefully reloads Nginx in place when the site is running. If Local has left a stale Nginx master PID, the add-on restarts only that site’s Nginx service after validation succeeds. Stopped sites receive the compiled configuration on their next start.

To disable it, turn the switch off and select **Save & apply**. The Site URL and IP remain in the per-site settings for convenient re-enabling, while all managed Nginx files are removed.

Before uninstalling, disable the proxy on each configured site. As a Local 10 compatibility safeguard, the add-on also removes its managed files when its global Installed Add-ons switch is turned off, and it clears per-site enabled flags when uninstalled. Per-site disable remains the most reliable workflow because Local does not currently expose a public awaited add-on-uninstall hook.

## Request flow

```text
Browser requests /wp-content/uploads/.../image.png
             |
             v
       File exists locally? ---- yes ---> serve local file
             |
             no
             v
Remote IP (origin or compatible proxy/CDN) + HTTP Host + verified TLS identity ---> stream image response
```

The response header `X-Local-Media-Proxy: origin` identifies a remote fallback. Locally served files do not receive that header.

## TLS trust model

For HTTPS remote endpoints, the connection test requires a valid chain and verifies the expected certificate identity. Generic and manually configured endpoints normally use the Site URL hostname. When an unconnected manual site reaches a chain-valid WP Engine certificate whose only failure is that hostname mismatch, the add-on verifies the certificate against the exact internal identity `origin.wpengine.com`, retries with that SNI, and retains the public Site URL as HTTP `Host`. It does not use this fallback for expired, untrusted, self-signed, or unrelated certificates. WP Engine auto-population instead uses the provider-returned direct `.wpengine.com` CNAME for TLS SNI and certificate verification while retaining the primary Site URL as the HTTP `Host`. Before testing or applying a separate connected WP Engine TLS identity, the main process reloads the selected environment and rejects any Site URL/CNAME pair that does not match its authoritative provider data. Enabled settings also retain main-owned WP Engine site/install identifiers; startup reconciliation disables and removes the proxy if the Local site is disconnected, relinked, or no longer matches that environment. If provider verification is temporarily unavailable, reconciliation removes the active proxy configuration but retains the enabled setting so a later site start can retry instead of silently discarding user intent. The trusted authorities are Node’s standard CA roots plus Cloudflare’s published RSA and ECC Origin CA roots. The latter support private origin certificates commonly used behind Cloudflare without accepting arbitrary self-signed certificates or arbitrary TLS-host overrides.

On apply, the same CA bundle is written to the site and Nginx requires verification against it and the configured hostname. The file intentionally contains the complete standard root set plus the two Cloudflare Origin CA roots, so many certificate blocks are expected. Roots are normalized and deduplicated by fingerprint, the file is atomically replaced rather than appended, identical reapplications do not rewrite it, and disabling removes it. Its exact count or byte size can change when Local updates its embedded Node root store, but repeated enable/disable cycles within one Local version recreate the same bytes. The peer’s unverified leaf or presented chain is never made a trust anchor. Use a remote IP from a trusted provider source or public DNS whose routing you understand. Proxy and CDN addresses can work, but they may be shared or change and must be retested. HTTP endpoints are supported but unencrypted and are not recommended.

## Files managed in a Local site

The add-on makes bounded, reversible changes:

- Adds one marked include to `conf/nginx/site.conf.hbs`.
- Writes `conf/nginx/includes/local-media-proxy.conf.hbs`.
- Writes `conf/nginx/local-media-proxy-origin-ca.pem` for HTTPS.

Only content between `# BEGIN Local Media Proxy (managed)` and `# END Local Media Proxy (managed)` belongs to the add-on. A failed apply restores the prior files and settings before attempting a service reload.

Do not edit Local’s generated runtime file under its application-support `run/` directory; Local rebuilds it from the persistent templates above.

## Development

```bash
npm install
npm run validate
npm run package:addon
```

For live development on macOS, symlink the repository into Local’s add-ons directory and restart Local:

```bash
ln -s "/absolute/path/local-media-proxy" "$HOME/Library/Application Support/Local/addons/local-media-proxy"
```

Platform add-on directories and current API guidance are documented in Local’s [build guide](https://localwp.com/get-involved/build/) and [add-on structure reference](https://localwp.com/help-docs/building-your-add-on/add-on-structure/).

See [AGENTS.md](AGENTS.md) for repository conventions, [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks, [PUBLIC_RELEASE_SAFETY.md](PUBLIC_RELEASE_SAFETY.md) for the blocking content-safety process, and [RELEASING.md](RELEASING.md) for the release process.

Pushing an exact SemVer release tag such as `v0.1.0` starts the release workflow. It verifies that the tag, package metadata, lockfile, changelog, and archive agree before GitHub creates a draft, attaches the installable `local-media-proxy-v<version>.tgz` and its SHA-256 checksum, and preselects the prerelease state without marking it Latest. CI and promotion verification require npm's standard `package/` root and the exact minimal runtime-file manifest. A maintainer reviews the draft but does not publish it manually. The manual **Promote release** workflow requires exact tag-specific confirmation, re-verifies the release, tag, asset identities, structure, and digests, then publishes it as stable and Latest. The documented `release-approval` environment adds a second reviewer gate when configured.

## Troubleshooting

- **Nginx-only warning:** Change the Local site web server to Nginx before enabling the add-on.
- **WP Engine discovery is unavailable:** Confirm that the Local site is connected to WP Engine and that Local is signed in. You can still enter the Site URL and remote IP manually.
- **Flywheel requires manual setup:** The tested Local API does not expose a supported Flywheel environment interface to add-ons. Enter the Site URL manually and use a trusted remote IP. Public DNS may return a compatible proxy or CDN address, but it may change and must be tested.
- **DNS results look unfamiliar:** Public DNS can return multiple addresses or addresses owned by a CDN, reverse proxy, or load balancer. These can work when they serve the Site URL, but may be shared or change. Select an address only when you understand where it routes, then test the connection and an actual missing upload after applying.
- **WP Engine edge hostname detected:** WP Engine auto-population is preferred because it keeps the primary domain as Site URL while using authoritative direct `.wpengine.com` environment data. Edge-hostname or primary-domain DNS addresses can also work as manual remote IPs when they serve the Site URL and pass both connection and missing-upload checks, but they may change.
- **Connection test fails:** Confirm the remote IP, Site URL scheme, and any nonstandard port. If using public DNS, resolve again and try another candidate.
- **Certificate error:** For manual endpoints, confirm that the Site URL hostname matches the remote certificate. Manually configured WP Engine origins can use the provider’s verified wildcard identity automatically; other hostname mismatches remain errors. For WP Engine auto-population, refresh discovery so the direct `.wpengine.com` TLS identity matches the selected environment. In every case, the certificate must chain to a public CA or Cloudflare Origin CA; arbitrary self-signed certificates are rejected.
- **Remote endpoint returns an error:** Test the exact remote upload URL directly. Authentication, hotlink protection, or origin, proxy, or CDN access rules can still block it.
- **Images fail after a CA change:** Update the add-on’s trusted CA bundle, then test and reapply the settings. Normal leaf-certificate rotation under the same CA does not require reconfiguration.
- **Local says the add-on already exists:** Disable and remove the installed Local Media Proxy entry before selecting the replacement `.tgz` with **Install from disk**.
- **Configuration reload fails:** Disable the proxy. The add-on restores its managed files on a failed apply; review Local’s log for the underlying Nginx error.

## License, support, and trademarks

Copyright © 2026 Amsive LLC.

Amsive-authored source code and packaged files are distributed under the [Apache License 2.0](LICENSE). Third-party material and its applicable terms are identified in [NOTICE](NOTICE). The software is provided on an **as-is** basis without warranties or conditions of any kind.

Community support is provided on a best-effort basis without a service-level agreement; see [SUPPORT.md](SUPPORT.md). The Apache license does not grant rights to use Amsive trademarks except for customary attribution; see [TRADEMARKS.md](TRADEMARKS.md). References to Local, WP Engine, Flywheel, WordPress, Cloudflare, and other third-party products describe compatibility and do not imply sponsorship or endorsement.

Maintained by Amsive LLC. Developed by Mark Davoli and Boris Hegedis.
