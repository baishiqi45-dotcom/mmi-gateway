# Custom Provider Module Example

This example loads a local provider through `mmi.config.json`. It does not call
an external API.

```bash
mmi doctor --config ./mmi.config.json --json
mmi ingest --config ./mmi.config.json --sources ./sources.jsonl --out ./run-001 --json
mmi validate ./run-001 --json
```

Provider modules must set `apiVersion: 1`, keep `healthCheck()` local, and
return candidate observations only.
