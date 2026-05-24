# Exit Codes

MMI keeps exit codes simple so shell scripts and agents can branch without
scraping prose.

| Code | Meaning | Typical action |
| --- | --- | --- |
| `0` | Command completed and `ok` is true. | Continue to the next command. |
| `1` | Command ran but found issues, validation failures, provider failures, or blocked output. | Read `issues`, run `mmi explain <issue-code> --json`, fix input/config, then rerun. |
| `2` | CLI usage error such as missing target or unsupported option value. | Fix the command shape. |

For `--json`, always inspect `schema`, `ok`, `issues`, and `nextCommands`.
