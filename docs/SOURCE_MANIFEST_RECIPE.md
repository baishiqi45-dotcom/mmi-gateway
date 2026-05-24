# Source Manifest Recipe

A source manifest lets an upstream system keep IDs, privacy, rights, provider
routing, and metadata stable.

## Object Form

```json
{
  "schema": "mmi.gateway.source_manifest",
  "schemaVersion": "1.0.0",
  "sources": [
    {
      "id": "customer_brief",
      "type": "text",
      "text": "Project brief text.",
      "privacy": "project_private",
      "rights": "restricted",
      "metadata": { "sourceSystem": "crm" }
    }
  ]
}
```

## Array Form

```json
[
  {
    "id": "public_page",
    "type": "web",
    "uri": "https://example.com/project",
    "privacy": "public",
    "rights": "not_reviewed"
  }
]
```

## JSONL Form

```jsonl
{"id":"brief","type":"text","text":"Brief text.","privacy":"synthetic","rights":"not_reviewed"}
{"id":"remote_clip","type":"video","uri":"https://cdn.example/clip.mp4","privacy":"public","rights":"not_reviewed","provider":"mock"}
```

Run:

```bash
npx @mmi/gateway schema --kind source-manifest > source-manifest.schema.json
npx @mmi/gateway ingest --sources ./sources.jsonl --out ./mmi-runs/source-manifest-run --json
```

Avoid duplicate `id` values. Keep local private file paths pointer-only unless a
reviewed storage boundary creates a signed URL.
