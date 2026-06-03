# Basic Project Example

This example shows how a normal project can initialize MMI, run a local text
intake, and receive a standard candidate packet.

```bash
mmi doctor \
  --config ./mmi.config.json
mmi ingest \
  --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./samples/brief.txt \
  --json
mmi validate \
  ./mmi-runs/run-001 \
  --json
```

Expected result:

- CLI prints `MMI_INGEST_HELD`
- `mmi-runs/run-001/packet.json` exists
- `status` is `candidate_review_required`
- no source is marked validated
