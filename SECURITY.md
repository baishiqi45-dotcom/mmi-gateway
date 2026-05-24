# Security

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.2.x` | yes |
| `0.1.x` | yes |

## Reporting

Open a private security advisory before filing a public issue for credential,
upload, signed URL, or provider-response leaks:

<https://github.com/baishiqi45-dotcom/mmi-gateway/security/advisories/new>

If advisories are unavailable, open a minimal public issue that says "security
report available" without including secrets, signed URLs, private files, raw
provider responses, or customer data.

## Default Protections

- Local private text/document provider dispatch is blocked by default.
- Local media upload is blocked by default.
- Data URL inspection is blocked by default.
- Provider API keys are read from environment variables and are not written into output packets.
- Raw provider responses are not persisted by the core gateway.
- Secret-like packet content blocks `packet.json` writes by default and emits `run_error.json`.
- All outputs are candidate-only and review-required.

## Sensitive Inputs

Use manual pointer-only intake for local private text/document material unless
the project has explicitly reviewed `policy.allowLocalTextUpload`.

Use signed URLs or a storage adapter for private media. Prefer
`createSignedUrlStorageBoundaryPlugins()` when a provider needs a signed URL but
the persisted packet should not contain the signed URL. The lower-level
`createSignedUrlStoragePlugin()` rewrites local private image/audio/video
pointers to signed URLs before provider dispatch, but the storage adapter itself
must be implemented and reviewed by the consuming project. Do not pass
customer-private local media paths to provider adapters unless your project has
explicitly implemented and reviewed that upload boundary.
