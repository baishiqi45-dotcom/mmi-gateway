# Generic Text Example

```bash
mmi ingest \
  --config ./mmi.config.json \
  --out ./run-001 \
  --text "A project brief that needs review before downstream workflow planning." \
  --json

mmi validate ./run-001 --json
```

The run is intentionally candidate-only. It is safe to inspect and adapt, but
not safe to treat as project truth.
