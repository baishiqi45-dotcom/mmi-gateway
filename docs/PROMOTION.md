# Promotion Plan

MMI Gateway should be promoted as infrastructure for agent builders, not as a
general chatbot, RAG app, or creative tool.

## Positioning

Short description:

> MMI Gateway is a provider-neutral multimodal intake CLI for AI agents. It
> turns messy project folders, text, documents, images, audio, and video into
> reviewable candidate evidence packets with provenance.

One-line pitch:

> Before your agent reasons, let MMI collect sources, preserve provenance, and
> produce a candidate-only handoff packet.

Best audience:

- AI agent builders
- local-first AI workflow maintainers
- LLMOps engineers who need provenance and review queues
- teams that pass project material between agents
- developers building pre-RAG source intake pipelines

Core claim:

- MMI reduces the first messy intake step in agent workflows.

Non-claims:

- It is not a truth engine.
- It is not a chatbot.
- It is not a replacement for project review.
- It does not upload private local media by default.

## Launch Checklist

Before broad posting:

- README shows the immediate GitHub install path.
- `npm run typecheck`, `npm test`, `npm run build`, `npm run selftest`, and
  `npm pack --dry-run` pass.
- A GitHub release exists with a packed tarball artifact.
- Repository topics include `ai-agents`, `multimodal-ai`, `llmops`,
  `provenance`, `source-review`, `typescript`, and `cli`.
- Issues and Discussions are enabled.
- The first npm release is published as `mmi-gateway`, or the README clearly
  says npm publishing is pending and points users to GitHub install.

## Outreach Order

1. GitHub release
2. Personal X/Twitter and LinkedIn posts
3. Hacker News `Show HN`
4. Dev.to or Hashnode technical walkthrough
5. Reddit communities where self-promotion is allowed by rules
6. LLM/agent Discord or Slack communities where project sharing is allowed
7. Follow-up post with a real dogfood example

Avoid mass posting the same text. Rewrite each post around the community's
actual interests and rules.

## GitHub Release Notes

Title:

```text
MMI Gateway v0.7.1 - multimodal intake packets for AI agents
```

Body:

````markdown
MMI Gateway is a provider-neutral multimodal intake CLI and TypeScript SDK for
AI agent workflows.

It turns messy source material into reviewable candidate evidence packets:

- local project folder intake
- provenance-preserving text, document, image, audio, and video source records
- agent-first perception bundles
- ASR task submission and transcript sidecar fetch
- human review queues and handoff files
- no private local media upload by default

Install from GitHub:

```bash
npm install -g github:baishiqi45-dotcom/mmi-gateway
mmi selftest --json
```

NPM package path is `mmi-gateway` once the first public npm publish is enabled.
````

## Social Posts

Short post:

```text
I open-sourced MMI Gateway: a provider-neutral multimodal intake CLI for AI
agents.

It scans messy project folders and turns text/docs/images/audio/video into
reviewable candidate evidence packets with provenance, review queues, and agent
handoff files.

GitHub: https://github.com/baishiqi45-dotcom/mmi-gateway
```

Technical post:

```text
Most agent workflows have the same weak first step: messy source intake.

MMI Gateway is my open-source attempt to make that step explicit:

- collect mixed project sources
- preserve provenance
- produce candidate-only evidence atoms
- create review queues and handoff files
- keep provider outputs out of the truth store
- avoid uploading private local media by default

It is pre-RAG infrastructure, not a chatbot and not a truth engine.

Repo: https://github.com/baishiqi45-dotcom/mmi-gateway
```

Hacker News:

```text
Show HN: MMI Gateway - multimodal intake packets for AI agents

I built a small TypeScript CLI/SDK for the first step in agent workflows:
turning messy source material into reviewable candidate evidence packets.

It can scan local project folders, classify text/docs/images/audio/video, keep
provenance, generate review queues, and write handoff files for the next agent.
It is intentionally candidate-only: not a truth engine, not a RAG app, and it
does not upload private local media by default.

GitHub: https://github.com/baishiqi45-dotcom/mmi-gateway
```

README star call-to-action:

```text
If MMI saves you an intake or source-review step, please star the repository so
other agent builders can find it.
```

## Tracking

Track these weekly after launch:

- GitHub stars
- clones and traffic from GitHub Insights
- issues and discussions opened
- release downloads
- npm downloads after first npm publish
- which outreach channel produced real install or issue activity

The goal is not vanity stars alone. A good star is attached to one of:

- an install attempt
- a real source-intake use case
- a bug report
- a provider adapter request
- an agent workflow integration
