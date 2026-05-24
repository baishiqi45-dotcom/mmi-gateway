# Error Codes

| Code | Meaning | Usual fix |
| --- | --- | --- |
| `missing_source` | No source was provided. | Pass `--text`, `--file`, `--url`, or SDK `sources`. |
| `missing_sources` | No source list was provided. | Pass at least one source. |
| `duplicate_source_id` | Two sources share an id. | Use unique ids or let the gateway generate ids. |
| `invalid_source` | Source lacks required shape. | Provide `type` plus `uri` or `text`. |
| `source_too_large` | Source exceeds the configured byte limit. | Use pointer-only intake, a smaller source, or a reviewed storage/extractor adapter. |
| `unsupported_source_type` | Provider does not support the source modality. | Pick another provider or route as manual. |
| `local_text_upload_blocked` | Local private text/document content would be sent to a provider. | Keep manual pointer-only intake or explicitly set `policy.allowLocalTextUpload` after review. |
| `local_media_upload_blocked` | Local private media would be sent to a provider. | Use a signed URL or storage adapter. |
| `data_url_blocked` | Data URLs are disabled by policy. | Add `--allow-data-url` or config policy after review. |
| `provider_missing` | Requested provider is not registered. | Add it in config or use `manual`. |
| `unknown_provider` | Requested provider is not registered. | Add it in config or use `manual`. |
| `provider_error` | Provider call failed. | Check credentials, region, model, and endpoint. |
| `provider_contract_invalid` | Provider output is empty or malformed. | Fix the adapter contract. |
| `provider_empty_content` | Provider returned no content. | Retry with a clearer prompt or route to review. |
| `invalid_provider_observation` | Provider returned a malformed observation. | Fix the adapter contract. |
| `secret_leak_risk` | Packet appears to contain a credential. | Remove secret-like values before writing. |
| `packet_schema_invalid` | Packet fails JSON Schema/Zod validation. | Validate against `schemas/v1/candidate-packet.schema.json`. |
| `candidate_boundary_violation` | Packet crossed a safety boundary. | Keep outputs review-required and candidate-only. |
| `plugin_error` | A plugin threw during an intake stage. | Fix or disable the plugin, then rerun intake. |
| `write_failed` | Output files could not be written. | Check permissions and disk space. |
| `invalid_config` | Config is malformed. | Compare against `CONFIGURATION.md`. |
| `invalid_cli` | CLI arguments are malformed. | Run `mmi --help`. |
