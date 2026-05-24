# Basic Project Example

This example shows how a normal project can initialize MMI, run a local text
intake, and receive a standard candidate packet.

```bash
npx @mmi/gateway doctor \
  --config ./mmi.config.json
npx @mmi/gateway ingest \
  --config ./mmi.config.json \
  --out ./mmi-runs/run-001 \
  --file ./samples/brief.txt \
  --json
npx @mmi/gateway validate \
  ./mmi-runs/run-001 \
  --json
```

Expected result:

- CLI prints `MMI_INGEST_HELD`
- `mmi-runs/run-001/packet.json` exists
- `status` is `candidate_review_required`
- no source is marked validated
