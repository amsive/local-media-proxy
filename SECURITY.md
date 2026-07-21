# Security Policy

Security reports are reviewed on a best-effort basis under the project’s [community support policy](SUPPORT.md). This policy does not create a service-level agreement, warranty, or guaranteed response or remediation time.

## Supported versions

Security fixes are applied to the latest released version. Upgrade before reporting an issue that is already fixed in a newer release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub’s private [Report a vulnerability](https://github.com/amsive/local-media-proxy/security/advisories/new) form. If that form is unavailable, use the [Amsive contact form](https://www.amsive.com/contact-us/) to request a confidential security contact before sending technical details. Include:

- the affected add-on and Local versions;
- the relevant site web-server type;
- reproduction steps and expected impact;
- sanitized generated Nginx, logs, or proof of concept; and
- whether the issue can expose local credentials, write outside the site, or proxy paths beyond uploads.

Do not include private certificates, access tokens, cookies, production credentials, or client data. Maintainers will attempt to acknowledge the report, validate severity, coordinate a fix when appropriate, and publish release notes after affected users can update.

The remote-connection workflow verifies HTTPS against standard CA roots plus Cloudflare’s published Origin CA roots; it does not trust a certificate merely because the peer presented it. Use a remote IP from a trusted hosting source or a public-DNS candidate whose routing you understand. A compatible proxy or CDN endpoint can work, but may be shared or change and must still pass connection and missing-upload checks and, for HTTPS, hostname and chain checks. Reports that demonstrate a bypass of hostname, chain, or Nginx verification are security-sensitive.
