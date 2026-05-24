# Source Manifest Example

```bash
npx @mmi/gateway ingest --sources ./sources.object.json --out ./run-object --json
npx @mmi/gateway ingest --sources ./sources.array.json --out ./run-array --json
npx @mmi/gateway ingest --sources ./sources.jsonl --out ./run-jsonl --json
```

All three forms produce the same candidate-only packet shape.
