# Technical details

This document describes Local Media Proxy's operating, security, compatibility, and lifecycle model. Start with the project [README](../README.md) for installation and normal configuration.

## Operating model

Local Media Proxy inserts bounded managed configuration into the selected Local site's persistent Nginx or Apache templates. The generated rules check the local uploads directory first and proxy only an eligible upload asset when the file is missing.

The response header `X-Local-Media-Proxy: origin` identifies a remote fallback. Locally served files do not receive that header. Remote responses are streamed without a persistent media cache; Nginx proxy buffering is disabled.

Saved Nginx and Apache connection profiles are separate because the servers have different routing models. The enabled intent is shared. When a Local site changes web-server type, the add-on reapplies the saved profile for the new server only when that profile is complete and valid.

For a truly untouched destination profile, the first server change carries only the other profile's validated canonical Site URL. It does not carry IP addresses, hosting provenance, TLS identity, certificates, timestamps, or verification results. Apache can apply the carried URL when its service supports that origin; Nginx still requires a separately configured remote IP. An existing or intentionally cleared destination profile is never overwritten.

## Nginx connection identity

Nginx mode intentionally separates the public URL from the network address:

- The Site URL provides the HTTP virtual-host identity and default TLS identity.
- The remote IP determines where Nginx sends the connection.
- A guarded WP Engine connection may preserve a provider-returned direct `.wpengine.com` hostname as the TLS SNI and certificate identity while retaining the primary domain in HTTP `Host`.

The split allows a direct origin, CDN edge, reverse proxy, or load balancer to work when it serves the configured Site URL and passes connection, certificate, and missing-upload tests. Provider-returned direct origins are usually more stable than public DNS results. Public addresses may be shared or change.

When provider discovery is unavailable, **Find via public DNS** can suggest Nginx address candidates. The add-on warns about non-public or otherwise unusual addresses, but the user must still understand and test the selected route.

## Apache connection identity

Apache uses the Site URL hostname as its DNS target, HTTP `Host`, TLS SNI, and certificate identity. It does not accept a separate remote IP or a split WP Engine TLS identity.

This constraint avoids presenting a configuration that Apache 2.4.43 cannot safely represent with its reverse-proxy hostname behavior. Apache therefore performs normal DNS resolution for the validated Site URL.

`mod_proxy_http`, `mod_headers`, and `mod_setenvif` are required for every Apache origin. HTTPS additionally requires `mod_ssl`. The add-on checks the modules exposed by the selected Local platform bundle before connection testing or persistent writes and reports an unsupported bundle without applying partial configuration.

## Origin discovery

For a Local site connected to WP Engine, the add-on uses Local's supported host-connection surface to enumerate Production, Staging, and Development environments:

- Both Nginx and Apache use the selected environment's primary domain as the Site URL suggestion.
- Nginx can use provider stable IP data or a direct `.wpengine.com` CNAME for routing and provider-verified TLS identity.
- Apache uses only the primary Site URL hostname.

The tested Local API does not expose an equivalent supported Flywheel environment interface. Flywheel and other hosting connections therefore use manual entry; Nginx may additionally use public DNS suggestions.

Discovery never saves settings or enables the proxy automatically. Every suggestion remains editable and must pass explicit testing and apply actions.

## Request boundary

Fallback rules are deliberately narrow while remaining format-tolerant:

- A request must be a missing local `GET` or `HEAD` below `/wp-content/uploads/`, with no request body.
- The path must end in a visible, non-hidden filename with an extension. The extension is not checked against an allowlist, so new asset formats work without a code change.
- Executable and interpreter suffixes, browser-active documents, hidden paths, and obvious secret, configuration, database, and backup material are blocked. SVG and SVGZ remain supported exceptions to the browser-document block.
- Interpreter tokens are rejected at any non-alphanumeric boundary in every decoded path segment, including double-suffix and path-info forms such as `shell.php.jpg` and `shell.php/image.jpg`.
- Traversal, empty or dot segments, encoded or literal backslashes, colons, malformed or repeated encoding, encoded slashes, NUL and control characters, and ambiguous decoded paths are rejected.
- Query strings are validated separately from the path and retained for cache busting.
- Nginx reserves the complete uploads boundary ahead of later custom locations: eligible local files are served locally, eligible misses use the verified proxy, and blocked or malformed misses return `404` instead of reaching another proxy rule. Existing local-only assets remain local; hidden and interpreter paths fail closed before static handling so they cannot expose sensitive content or source.
- Request bodies are not forwarded.
- The remote request receives a fixed, non-visitor-identifying add-on `User-Agent`.
- The configured Site URL supplies the upstream HTTP `Host`.

Nginx suppresses incoming request headers before reconstructing only `Host`, the fixed add-on `User-Agent`, `Range`, and `If-Range`. Apache admits a bounded set of standard browser and Local-router header names, removes browser identity, content-negotiation, tracing, credential, cookie, authorization, nonce, CSRF, and proxy-identity values, then preserves the same fixed identity and range behavior. A missing-asset request carrying an unrecognized data-bearing header fails closed before reaching the origin; an empty-valued unknown name carries no visitor data, and the gate does not affect an existing local file. Runtime tests verify both the resulting upstream header set and unknown-header rejection.

Apache upload filenames containing decoded spaces or characters outside its path-character allowlist remain local-only rather than broadening the proxy matcher. The upstream status, content type, disposition, length, and range headers are preserved. Origin-controlled cookies, browser-storage controls, service-worker scope, reporting endpoints, authentication prompts, proxy controls, and conflicting security headers are removed. Remote responses receive a managed sandboxing Content Security Policy, `X-Content-Type-Options: nosniff`, and `X-Local-Media-Proxy: origin`.

## TLS trust model

Connection testing requires a valid certificate chain and verifies the expected hostname. Persistent Nginx and Apache configurations require the same verification.

The trusted authority bundle contains:

1. Node's standard public certificate authorities.
2. Cloudflare's published RSA Origin CA root.
3. Cloudflare's published ECC Origin CA root.

Roots are parsed, normalized, deduplicated by SHA-256 fingerprint, and bounded by certificate count and total byte size. The Cloudflare bundle must contain exactly the two reviewed fingerprints. Its source-file SHA-256 is recorded in `third-party-materials.json`.

The trust extension is limited to those two roots. A certificate is not trusted because a peer presented it, and arbitrary self-signed certificates remain rejected. Certificate identity, validity dates, chain signatures, and SNI behavior are still enforced.

The generated site trust file contains the complete standard-plus-Cloudflare bundle. It is atomically replaced rather than appended, identical reapplications do not rewrite it, and disabling removes it.

## Managed Local files

For Nginx, the add-on:

- inserts one marked include in `conf/nginx/site.conf.hbs`;
- writes `conf/nginx/includes/local-media-proxy.conf.hbs`; and
- writes `conf/nginx/local-media-proxy-origin-ca.pem` for HTTPS.

For Apache, the add-on:

- inserts guarded module loads in `conf/apache/modules.conf.hbs`;
- inserts one marked include inside each virtual host in `conf/apache/site.conf.hbs`;
- writes `conf/apache/includes/local-media-proxy.conf.hbs`; and
- writes `conf/apache/local-media-proxy-origin-ca.pem` for HTTPS.

Only content between `# BEGIN Local Media Proxy (managed)` and `# END Local Media Proxy (managed)` belongs to the add-on. The add-on edits only its persistent templates and managed files. It asks Local's authoritative compiler to produce the selected service's runtime configuration, then verifies the exact compiled include and marker state rather than editing generated files directly. Template, compiled-config, and run roots are required to be contained real directories without symlinked ancestors.

## Local lifecycle isolation

Local owns a site's files and services while it is being created, initially pulled from WP Engine, or deleted. Local Media Proxy treats every status in those transitions as unavailable: it performs no managed-file reads or writes and no settings writes until Local reports the site as lifecycle-ready and `running` or `halted`. Inspection, reconciliation, apply, cleanup, and recovery use that same boundary.

Lifecycle notifications do not perform awaited filesystem work. They schedule bounded readiness checks that re-read the current site record and status. A stable status alone is not enough: the site root and Local-owned server templates must already exist before any managed path is resolved. A readiness check never creates a directory or template to make the site appear ready.

A first WP Engine pull can provision a shell site before replacing its files and importing its data. The add-on stays inactive through provisioning, pulling, and finalizing, then reconciles the completed Local site only after the terminal running or halted state. Existing proxy intent may be reapplied at that point, but no pull-owned file is inspected or changed earlier.

When deletion starts, ordinary deferred reconciliation is cancelled and in-flight operations stop when their lifecycle guards no longer match. A pending global cleanup follows a separate rule: it remains scheduled but dormant while Local still exposes the deleting site, performs no managed-file or settings access, and is cancelled when Local sends the site-deleted notification or the site record disappears. It never treats deletion as readiness.

Any queued transaction revalidates the current site, status, service identity, and managed paths immediately before each write, atomic rename, or unlink. Rollback is similarly qualified at every restoration step and proceeds only while the current site remains lifecycle-ready. If the site is deleting or no longer exists, the transaction stops without restoring settings, recreating directories, refreshing a service, or reading the removed root.

The renderer does not start proxy-state or origin-discovery requests for a transitional site, ignores stale results from an earlier lifecycle identity, and hides proxy controls and progress indicators. It reports a quiet, static unavailable state while Local owns the transition instead of forwarding a missing-path error.

If a bounded readiness check expires, the add-on leaves the site untouched. A later stable lifecycle notification or explicit user action can start a fresh check.

Global disable or uninstall first attempts guarded synchronous managed-file removal for each lifecycle-ready site. It revalidates the current site, status, service identity, and managed paths before every removal; remaining verification and runtime refresh work continues on a separate bounded cleanup lane. A transitional site skips synchronous access and stays pending but dormant on that lane. Cleanup resumes only if the site becomes lifecycle-ready, is cancelled if the site is deleted or disappears, and expires with an error rather than touching transitional files. Cleanup does not change persisted per-site enabled intent. If the add-on is re-enabled first, re-enable cancels the deferred global cleanup before normal configured-site reconciliation is scheduled and valid enabled profiles are reapplied. Invalid profiles remain fail-closed without losing intent.

## Validation, apply, rollback, and cleanup

Passive state reads compare persistent and compiled state and report drift without writing. Settings changes, explicit same-value repair requests, server changes, startup reconciliation, and site-start reconciliation may repair confirmed drift.

Before activation, the add-on validates user input, builds the managed configuration, compiles the selected Local server templates, and runs server syntax checks. Apache verifies its exact compiled main, module, virtual-host, and include state before `httpd -t`. Nginx performs targeted compilation, exact include comparison, `nginx -t`, and a bounded `nginx -T` inspection of the configuration that would actually load.

After successful compilation and validation, a running Nginx site restarts only its selected Nginx service so the verified configuration becomes authoritative. Apache performs a bounded, site-scoped graceful reload using the selected site configuration. Stopped sites are compiled and validated without being started, and no other site's service is refreshed.

Writes use validated snapshots and rollback. Settings are committed only after persistent files, compiled configuration, and the targeted runtime converge. If apply fails while the site remains lifecycle-ready, the add-on restores previous settings and managed files, recompiles, and attempts to return the service to its prior runtime configuration. A malformed or unsafe snapshot is never classified as restorable. If Local enters a transition, rollback stops rather than writing into or recreating Local-owned state; later lifecycle-ready cleanup or reconciliation handles the surviving intent.

Disabling removes managed includes, generated proxy rules, and trust files while retaining saved connection fields for later reuse. If Local cannot resolve the selected service, cleanup is deferred without falsely reporting that a running proxy was removed.

The global Installed Add-ons switch also performs guarded synchronous removal plus deferred cleanup as a Local 10 compatibility safeguard. Transitional sites stay dormant on the deferred global-cleanup lane, site deletion cancels their pending cleanup, and re-enable cancels the lane before reconciliation. Per-site disable remains the preferred uninstall preparation because Local does not expose a public awaited uninstall hook.

## Installed add-on details

Local normally loads installed add-on details from its public marketplace. A manually installed add-on may not have a marketplace entry, so the renderer provides packaged metadata only when the marketplace has no `local-media-proxy` result or is unavailable.

The fallback is scoped to this add-on's detail queries. Other add-ons and GraphQL operations pass through unchanged, and a future official marketplace listing takes precedence. This compatibility behavior is tested against Local 10.1.1 and should be revalidated when Local's marketplace implementation changes.

## Troubleshooting

- **Unsupported server:** Select a Local site whose explicit HTTP service is Nginx or Apache. Ambiguous service metadata is rejected rather than guessed.
- **WP Engine discovery unavailable:** Confirm the Local site is connected to WP Engine and Local is signed in. Manual entry remains available.
- **Flywheel requires manual setup:** Enter the Site URL manually. Nginx additionally needs a trusted remote IP or tested public DNS candidate.
- **DNS results look unfamiliar:** CDN and proxy addresses can be shared or change. Select an address only when you understand its routing, then test a real missing upload.
- **Connection test fails:** Verify the Site URL scheme, hostname, and optional port. For Nginx, also verify the remote IP and retry another reviewed candidate if appropriate.
- **Certificate error:** Confirm the certificate matches the expected identity and chains to a standard public CA or Cloudflare Origin CA. Apache HTTPS also requires `mod_ssl`.
- **Remote error response:** Test the exact remote upload path. Authentication, hotlink protection, or origin/CDN access rules can still block it.
- **Add-on already exists:** Disable and remove the installed add-on before selecting a replacement TGZ.
- **Configuration refresh fails:** Disable the proxy and review Local's logs for the underlying syntax or reload error. Failed apply operations restore their previous snapshots only while the site remains lifecycle-ready; a Local transition stops rollback safely.

## Release package

The installable TGZ uses npm's single `package/` root and an exact 27-file allowlist. It contains compiled runtime JavaScript, package metadata, CSS, runtime artwork, the Cloudflare trust material, `LICENSE`, `NOTICE`, and the packaged README.

Source TypeScript, tests, source maps, `node_modules`, development configuration, provenance documents, and repository process files are excluded. CI, release creation, and promotion independently verify the package structure, source equivalence, public-release safety, and third-party material contract.
