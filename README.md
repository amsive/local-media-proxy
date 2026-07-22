# Local Media Proxy

Local Media Proxy is an [Amsive](https://www.amsive.com/) add-on for [Local](https://localwp.com/) that keeps WordPress uploads out of local clones without breaking image-heavy pages. For each Local site, it serves files already present under `wp-content/uploads` and fetches only missing images from a configured remote site, whether that site is a production, staging, or development environment.

Local Media Proxy is open-source, community-supported software released under the [Apache License 2.0](LICENSE).

![Local Media Proxy overview](./resources/detail-hero.svg)

## What it does

- Enables or disables the fallback independently for each Local site.
- Requires a remote Site URL. Nginx sites also require a remote IP address; Apache sites deliberately use the Site URL hostname for DNS routing.
- Discovers connected WP Engine Production, Staging, and Development environments and uses each environment's primary domain for Site URL. On Nginx, it also uses direct `.wpengine.com` data for provider-recommended remote-IP discovery and split TLS verification; Apache uses only the primary Site URL hostname.
- On Nginx, can resolve public DNS address candidates from a manually entered Site URL when provider-specific discovery is unavailable. Apache performs normal DNS resolution of the Site URL hostname and does not expose IP candidates.
- On Nginx, connects to the supplied IP while preserving the Site URL hostname for HTTP `Host`; WP Engine discovery can separately preserve the direct `.wpengine.com` hostname for TLS SNI and certificate verification. On Apache, the Site URL hostname is always the DNS target, HTTP `Host`, TLS SNI, and certificate identity.
- Limits fallback requests to image extensions below `/wp-content/uploads/`.
- Allows only `GET` and `HEAD` and forwards no request bodies. Nginx suppresses all incoming request headers before adding its allowlist. Apache strips named credential, nonce, CSRF, and proxy-identity headers, but Apache 2.4 `mod_headers` cannot wildcard-remove arbitrary custom request-header names. Both modes send the configured Site URL `Host` plus a fixed, non-visitor-identifying add-on `User-Agent` upstream.
- Uses a conservative URL-safe filename matcher on Apache; upload filenames containing decoded spaces or other characters outside that allowlist remain local-only.
- Streams responses without a persistent local media cache; Nginx proxy buffering is disabled.
- Uses Local-native controls and explicit light/dark theme styles.

Nginx mode intentionally separates URL and IP. The Site URL supplies the HTTP virtual-host identity, while the remote IP selects where Local sends the request. That IP may be a direct origin, CDN or proxy edge, or load balancer as long as it serves the Site URL and, for HTTPS, passes certificate validation. Provider-supplied direct origins are usually more stable; public-DNS addresses may be shared or change and must be tested. WP Engine discovery verifies TLS against the selected environment's validated direct `.wpengine.com` CNAME because its direct server can present that certificate while HTTP requests still require the primary/custom domain in `Host`.

Apache 2.4.43 cannot safely split a saved IP, public `Host`, and separate TLS identity because its reverse-proxy hostname controls DNS, `Host`, SNI, and certificate verification together. Apache mode therefore accepts only the Site URL, performs no remote-IP lookup, and uses that one validated hostname for all four purposes.

Apache capability checks follow the modules in Local's official platform bundle. `mod_proxy_http` and `mod_headers` are required for every Apache origin, and `mod_ssl` is additionally required for HTTPS origins. The current official Local Apache +11 Intel macOS (`darwin-x64`) bundle omits `mod_ssl`, so Apache on that bundle supports HTTP origins only; Apple silicon macOS, Linux, and Win32 bundles that include `mod_ssl` retain HTTPS support. The add-on detects this before connection testing or persistent writes and reports the bundle limitation in the site UI.

## Requirements and current scope

- Local 10.1.1 or newer
- A Local site using Nginx or Apache
- For Apache HTTPS origins, a Local Apache platform bundle that includes `mod_ssl`; the current Intel macOS +11 bundle is Apache HTTP-only
- A standard WordPress uploads path: `/wp-content/uploads/`
- Network access from the workstation to the configured endpoint and Site URL port

The add-on proxies image files only; it does not proxy PDFs, video, audio, themes, plugins, API calls, or arbitrary missing URLs.

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
3. Choose the connection-setup path that fits the selected Local site and web server:
   - **WP Engine:** Select the connected Production, Staging, or Development environment, then choose **Auto-populate from WP Engine**. Both modes suggest the environment's primary domain as Site URL. Nginx also obtains remote-IP candidates from WP Engine's stable IPs or direct `.wpengine.com` CNAME and retains the direct identity for TLS verification; Apache uses only the primary Site URL hostname for DNS, `Host`, SNI, and certificate verification.
   - **Flywheel:** Enter the Site URL manually. The tested Local API does not expose a supported Flywheel environment interface to add-ons, so provider-specific auto-population is not available. On Nginx, you may use **Find via public DNS** when public DNS is appropriate; Apache does not require an IP lookup.
   - **Other hosts:** Enter the Site URL, such as `https://example.com`. On Nginx, optionally choose **Find via public DNS** to resolve address candidates; Apache does not require an IP lookup.
4. On Nginx, review the suggested Site URL and remote IP. If multiple addresses are returned, select one you understand. On Apache, review only the Site URL; its hostname is resolved directly and no IP candidate or separate TLS identity is used.
5. Select **Test connection**. This checks endpoint reachability and, for HTTPS, certificate identity and trust—not a media file. While the test is running, the button shows progress and becomes **Stop test** so the probe can be cancelled.
6. Turn on **Enable for this site**, then select **Save & apply**.
7. Load an actual upload that is missing locally through the Local site. Confirm HTTP 200 and the response header `X-Local-Media-Proxy: origin`.

Enter only the Site URL scheme and hostname, plus an optional port: do not include a path, query string, credentials, or fragment. A trailing slash is optional; the add-on normalizes the saved value consistently. Auto-populated values are suggestions only; they are never saved or enabled automatically, and should be tested before you explicitly apply them.

Local Media Proxy compiles and validates the selected web server’s templates before activating changes. Running Nginx sites are gracefully reloaded in place, with a targeted Nginx-service restart only for a stale master PID. Apache performs targeted compilation and managed-marker checks, runs `httpd -t`, then uses a bounded, site-scoped graceful reload (`httpd -k graceful -f <site-config>`) without restarting the Apache service. Stopped sites are compiled and validated without a reload.

To disable it, turn the switch off and select **Save & apply**. Saved connection fields remain available for convenient re-enabling, while all managed Nginx and Apache files are removed and the selected service is refreshed. If Local cannot resolve or load that service, cleanup is deferred without changing settings or files; the UI reports **Needs attention** so you can stop the site, restore the service, and retry without falsely claiming the compiled proxy is inactive.

Before uninstalling, disable the proxy on each configured site. As a Local 10 compatibility safeguard, the add-on also removes managed files when its global Installed Add-ons switch is turned off. Uninstall clears each site's enabled intent independently of runtime cleanup success, so reinstall cannot unexpectedly reactivate it. When the selected service cannot be resolved, global cleanup removes and verifies persistent managed files, recompiles all site configs, and fails closed for a running site with guidance to stop it and retry; stopped sites remain stopped. Runtime or persistence failures are aggregated and logged instead of being treated as successful. Per-site disable remains the most reliable workflow because Local does not currently expose a public awaited add-on-uninstall hook.

## Request flow

```text
Browser requests /wp-content/uploads/.../image.png
             |
             v
       File exists locally? ---- yes ---> serve local file
             |
             no
             v
Configured endpoint + HTTP Host + verified TLS identity ---> stream image response
```

The response header `X-Local-Media-Proxy: origin` identifies a remote fallback. Locally served files do not receive that header.

## TLS trust model

For HTTPS remote endpoints, the connection test requires a valid chain and verifies the expected certificate identity. In Nginx mode, generic endpoints normally use the Site URL hostname, while the existing guarded WP Engine behaviors may verify a provider-returned direct `.wpengine.com` identity separately from the public HTTP `Host`. In Apache mode there is no split identity or WP Engine TLS fallback: the validated Site URL hostname is used for DNS, HTTP `Host`, TLS SNI, and certificate verification. The trusted authorities are Node’s standard CA roots plus Cloudflare’s published RSA and ECC Origin CA roots. The latter support private origin certificates commonly used behind Cloudflare without accepting arbitrary self-signed certificates or arbitrary TLS-host overrides.

On apply, the same CA bundle is written to the selected server’s persistent site templates and certificate verification is required against the configured identity. The file intentionally contains the complete standard root set plus the two Cloudflare Origin CA roots, so many certificate blocks are expected. Roots are normalized and deduplicated by fingerprint, the file is atomically replaced rather than appended, identical reapplications do not rewrite it, and disabling removes it. HTTP endpoints are supported but unencrypted and are not recommended.

## Files managed in a Local site

The add-on makes bounded, reversible changes:

- Adds one marked include to `conf/nginx/site.conf.hbs`.
- Writes `conf/nginx/includes/local-media-proxy.conf.hbs`.
- Writes `conf/nginx/local-media-proxy-origin-ca.pem` for HTTPS.
- Adds marked, guarded module loads to `conf/apache/modules.conf.hbs`.
- Adds one marked include inside each Local virtual host in `conf/apache/site.conf.hbs`.
- Writes `conf/apache/includes/local-media-proxy.conf.hbs`.
- Writes `conf/apache/local-media-proxy-origin-ca.pem` for HTTPS.

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

Pushing an exact SemVer release tag such as `v0.1.0` starts the release workflow. It verifies that the tag, package metadata, lockfile, changelog, and archive agree before GitHub creates a draft, attaches the installable `local-media-proxy-v<version>.tgz` and its SHA-256 checksum with visible labels identical to their downloadable filenames, and preselects the prerelease state without marking it Latest. CI and promotion verification require npm's standard `package/` root and the exact minimal runtime-file manifest. A maintainer reviews the draft but does not publish it manually. The manual **Promote release** workflow requires exact tag-specific confirmation, re-verifies the release, tag, asset identities, visible labels, structure, and digests, then publishes it as stable and Latest. The documented `release-approval` environment adds a second reviewer gate when configured.

## Troubleshooting

- **Unsupported server warning:** Use a Local site whose explicit HTTP service is Nginx or Apache. Ambiguous or conflicting service metadata is rejected rather than guessed.
- **WP Engine discovery is unavailable:** Confirm that the Local site is connected to WP Engine and that Local is signed in. You can still enter the Site URL manually; on Nginx, also enter a remote IP or use **Find via public DNS**. Apache uses the Site URL hostname directly.
- **Flywheel requires manual setup:** The tested Local API does not expose a supported Flywheel environment interface to add-ons. Enter the Site URL manually. On Nginx, enter a trusted remote IP or use **Find via public DNS**; those results may identify a changing proxy or CDN and must be tested. Apache uses the Site URL hostname directly.
- **DNS results look unfamiliar:** Public DNS can return multiple addresses or addresses owned by a CDN, reverse proxy, or load balancer. These can work when they serve the Site URL, but may be shared or change. Select an address only when you understand where it routes, then test the connection and an actual missing upload after applying.
- **WP Engine edge hostname detected on Nginx:** WP Engine auto-population is preferred because it keeps the primary domain as Site URL while using authoritative direct `.wpengine.com` environment data. Edge-hostname or primary-domain DNS addresses can also work as manual remote IPs when they serve the Site URL and pass both connection and missing-upload checks, but they may change. Apache does not use a separate edge hostname or remote IP.
- **Connection test fails:** Confirm the Site URL scheme and any nonstandard port. On Nginx, also confirm the remote IP; if using public DNS, resolve again and try another candidate. Apache resolves the Site URL hostname directly.
- **Certificate error:** Confirm that the expected identity matches the remote certificate. Nginx can use the guarded, provider-verified WP Engine wildcard identity separately from the Site URL; refresh auto-population if that direct `.wpengine.com` identity changed. Apache always verifies the Site URL hostname and never uses a split WP Engine identity. Apache HTTPS also requires `mod_ssl`; the current official Intel macOS +11 bundle is HTTP-only. In every supported HTTPS case, the certificate must chain to a public CA or Cloudflare Origin CA; arbitrary self-signed certificates are rejected.
- **Remote endpoint returns an error:** Test the exact remote upload URL directly. Authentication, hotlink protection, or origin, proxy, or CDN access rules can still block it.
- **Images fail after a CA change:** Update the add-on’s trusted CA bundle, then test and reapply the settings. Normal leaf-certificate rotation under the same CA does not require reconfiguration.
- **Local says the add-on already exists:** Disable and remove the installed Local Media Proxy entry before selecting the replacement `.tgz` with **Install from disk**.
- **Configuration refresh fails:** Disable the proxy. The add-on restores its settings and managed files on a failed apply; review Local’s log for the underlying Nginx reload or Apache syntax/graceful-reload error.

## License, support, and trademarks

Copyright © 2026 Amsive LLC.

Amsive-authored source code and packaged files are distributed under the [Apache License 2.0](LICENSE). Third-party material and its applicable terms are identified in [NOTICE](NOTICE). The software is provided on an **as-is** basis without warranties or conditions of any kind.

Community support is provided on a best-effort basis without a service-level agreement; see [SUPPORT.md](SUPPORT.md). The Apache license does not grant rights to use Amsive trademarks except for customary attribution; see [TRADEMARKS.md](TRADEMARKS.md). References to Local, WP Engine, Flywheel, WordPress, Cloudflare, and other third-party products describe compatibility and do not imply sponsorship or endorsement.

Maintained by Amsive LLC. Developed by Mark Davoli and Boris Hegedis.
