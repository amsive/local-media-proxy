# Bundled runtime resources

## Origin certificate authorities

`cloudflare-origin-ca.pem` contains Cloudflare’s published RSA and ECC Origin CA roots. They allow HTTPS verification when a configured remote IP presents a Cloudflare Origin Certificate, including the WP Engine test fixture, without trusting the certificate chain presented by an unverified peer.

Cloudflare documentation content is licensed under the Creative Commons Attribution 4.0 International license: https://creativecommons.org/licenses/by/4.0/. The packaged PEM concatenates the two published roots without otherwise changing their certificate bytes. See `NOTICE` at the package root for attribution.

Sources retrieved 2026-07-16:

- https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem
- https://developers.cloudflare.com/ssl/static/origin_ca_ecc_root.pem

The add-on combines these roots with Node’s standard CA roots. Review and refresh this file before either Cloudflare root expires.

## Installed add-on details

`detail-hero.svg` is the Amsive-branded overview illustration displayed on Local’s native installed add-on detail page. The three avatar SVGs identify Amsive, Mark Davoli, and Boris Hegedis in the developer and collaborator sections. Keep these files self-contained, accessible, and readable against both Local themes.

Amsive-authored artwork in this directory is distributed under the repository’s Apache License 2.0. That copyright license does not grant permission to use Amsive trademarks beyond customary attribution; see `TRADEMARKS.md` at the package root.

`cloudflare-origin-ca.pem` is third-party certificate material and is not represented as Amsive-authored Apache-licensed artwork. Its exact upstream provenance is recorded above and in `NOTICE`; explicit redistribution clearance remains a prerequisite for public release.
