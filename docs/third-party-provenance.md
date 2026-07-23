# Third-party provenance

This document explains the third-party material and direct dependency declarations enforced by `third-party-materials.json`. It is an engineering record for attribution, package review, and change detection. It is not a legal opinion or a claim that any publisher endorses Local Media Proxy.

## Cloudflare Origin CA roots

Local Media Proxy distributes Cloudflare's published RSA and ECC Origin CA root certificates in `resources/cloudflare-origin-ca.pem`. The add-on combines those two roots with Node's standard certificate authorities so Cloudflare Origin Certificates can be verified without accepting arbitrary self-signed certificates.

Sources:

- <https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem>
- <https://developers.cloudflare.com/ssl/static/origin_ca_ecc_root.pem>

Cloudflare's public documentation repository identifies its documentation and other content, except where otherwise noted, as available under the [Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/). The [publisher licensing statement](https://github.com/cloudflare/cloudflare-docs#license-and-legal-notices), certificate source URLs, bundle hash, and certificate fingerprints are recorded in the machine-readable manifest.

The distributed bundle only concatenates the two PEM certificates; their certificate bytes are otherwise unchanged. Cloudflare is not affiliated with this project, and this attribution does not claim endorsement or a separate license to Cloudflare trademarks.

## Local LoadingIndicator adaptation

The scoped two-dot loading animation in `style.css` and its renderer markup adapt the `LoadingIndicator` pattern from `@getflywheel/local-components` 17.8.1. The upstream project is published under the MIT License. The complete required attribution and license text are retained in `NOTICE`.

Source: <https://github.com/getflywheel/local-components>

The adaptation uses project-specific class names, status text, bounded waits, focus behavior, and reduced-motion support. The upstream package is not included as a runtime dependency.

## Direct dependencies

The machine-readable manifest covers every direct development and peer dependency declared in `package.json`. The release installer contains compiled project code and static resources only; it contains no `node_modules` tree and declares no runtime `dependencies`.

`@getflywheel/local` supplies the host API and type surface used during development. Version 10.1.1 does not expose explicit license metadata in the installed package or lockfile. It is therefore recorded as `metadata-unavailable`, host-provided, and non-distributed. This exception does not authorize copying that package's source or type declarations into the release.

React and React DOM are optional peers supplied by Local. TypeScript, `@types/node`, and `selfsigned` are development-only tools. Their resolved versions and declared licenses are pinned in the lockfile and checked against the provenance manifest.

## Review and update rules

Run `npm run verify:third-party` whenever a dependency, notice, packaged file, trust root, or adapted third-party component changes. The verifier is offline and checks:

- direct dependency declarations and resolved lockfile metadata;
- distributed versus host-only status;
- required `NOTICE` attribution;
- Cloudflare bundle hash, exact certificate fingerprints, and expiration;
- package inclusion of declared distributed materials;
- exclusion of provenance documents, development dependencies, and host-only packages; and
- the annual provenance review date.

A material change requires updating the manifest and documentation in the same pull request. A changed certificate must be reviewed as a new trust decision rather than accepted by updating a hash alone.
