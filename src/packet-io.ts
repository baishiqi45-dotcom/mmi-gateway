import fs from "node:fs/promises";
import path from "node:path";
import { issueWithRecovery } from "./errors.ts";
import type { CandidatePacket, CandidatePacketOutputManifest, GatewayIssue, PacketProfile } from "./types.ts";

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export async function writeCandidatePacket(
  packet: CandidatePacket,
  outputDir: string,
  options: CandidatePacketWriteOptions = {},
): Promise<string[]> {
  const root = path.resolve(outputDir);
  await fs.mkdir(root, { recursive: true });
  await fs.rm(path.join(root, "run_error.json"), { force: true });
  const issues = options.issues ?? [];
  const profile = options.profile ?? "generic";
  const manifest: CandidatePacketOutputManifest = {
    schema: "mmi.gateway.output_manifest",
    schemaVersion: packet.schemaVersion,
    packetSchema: packet.schema,
    profile,
    run: packet.run,
    status: packet.status,
    entrypoints: {
      packet: "packet.json",
      sources: "sources.json",
      evidenceAtoms: "evidence_atoms.jsonl",
      claims: "claims.jsonl",
      reviewItems: "review_items.jsonl",
      sourceMatrix: "source_matrix.json",
      issues: "issues.json",
      agentHandoff: "agent_handoff.md",
      humanReadme: "README.md",
    },
    commands: {
      validate: "mmi validate .",
      handoff: "mmi handoff .",
    },
    nextActions: nextActions(issues),
    counts: {
      sources: packet.sources.length,
      evidenceAtoms: packet.evidenceAtoms.length,
      claims: packet.claims.length,
      reviewItems: packet.reviewItems.length,
      issues: issues.length,
    },
    boundary: {
      reviewRequired: true,
      sourceMatrixBound: false,
      nonClaims: packet.nonClaims,
    },
  };
  const files: Array<[string, string | unknown, "json" | "jsonl" | "text"]> = [
    ["gateway_manifest.json", manifest, "json"],
    ["packet.json", packet, "json"],
    ["sources.json", packet.sources, "json"],
    ["evidence_atoms.jsonl", packet.evidenceAtoms, "jsonl"],
    ["claims.jsonl", packet.claims, "jsonl"],
    ["review_items.jsonl", packet.reviewItems, "jsonl"],
    ["source_matrix.json", packet.sourceMatrix, "json"],
    ["issues.json", issues.map(issueWithRecovery), "json"],
    ["agent_handoff.md", agentHandoff(packet, issues, profile), "text"],
    [
      "README.md",
      `# MMI Gateway Candidate Packet\n\nRun: \`${packet.run.id}\`\n\nStatus: \`${packet.status}\`\n\nStart with \`gateway_manifest.json\`, \`packet.json\`, and \`agent_handoff.md\`.\n\nThis packet is candidate-only. It is not source truth, project truth, validation, or execution permission.\n`,
      "text",
    ],
  ];

  const written: string[] = [];
  for (const [filename, value, kind] of files) {
    const filePath = path.join(root, filename);
    if (kind === "json") await writeJson(filePath, value);
    else if (kind === "jsonl") await fs.writeFile(filePath, jsonl(value as unknown[]), "utf8");
    else await fs.writeFile(filePath, String(value), "utf8");
    written.push(filePath);
  }
  return written;
}

export type CandidatePacketWriteOptions = {
  issues?: GatewayIssue[];
  profile?: PacketProfile;
};

function agentHandoff(packet: CandidatePacket, issues: GatewayIssue[], profile: PacketProfile): string {
  const issueCounts = issues.reduce<Record<string, number>>((counts, item) => {
    const severity = issueWithRecovery(item).severity;
    counts[severity] = (counts[severity] ?? 0) + 1;
    return counts;
  }, {});
  const issueLines =
    issues.length === 0
      ? "- No gateway issues were reported.\n"
      : issues
          .map((item) => {
            const issue = issueWithRecovery(item);
            return `- ${issue.code}: ${issue.message} Recovery: ${issue.recovery}`;
          })
          .join("\n") + "\n";
  const nextActionLines = nextActions(issues)
    .map((action) => `- ${action.required ? "Required" : "Optional"}: ${action.description}${action.command ? ` Command: \`${action.command}\`.` : ""}`)
    .join("\n");
  return `# MMI Agent Handoff\n\nRun: \`${packet.run.id}\`\n\nProfile: \`${profile}\`\n\nStatus: \`${packet.status}\`\n\n## Snapshot\n\n- Sources: ${packet.sources.length}\n- Evidence atoms: ${packet.evidenceAtoms.length}\n- Claims: ${packet.claims.length}\n- Review items: ${packet.reviewItems.length}\n- Issues: ${issues.length} (${Object.entries(issueCounts)
    .map(([severity, count]) => `${severity}: ${count}`)
    .join(", ") || "none"})\n- Review required: true\n- Source matrix bound: false\n\n## File Index\n\n- \`gateway_manifest.json\`: machine-readable map of this output directory and next actions.\n- \`packet.json\`: complete candidate packet.\n- \`sources.json\`: normalized sources.\n- \`evidence_atoms.jsonl\`: candidate observations.\n- \`claims.jsonl\`: review-required claim candidates.\n- \`review_items.jsonl\`: human/agent review queue.\n- \`source_matrix.json\`: candidate-only source matrix draft. It is not bound.\n- \`issues.json\`: gateway issues with severity and recovery.\n\n## Suggested Agent Actions\n\n${nextActionLines}\n\n## Allowed Next Steps\n\n- Summarize candidate observations with uncertainty.\n- Prepare human review questions from \`review_items.jsonl\`.\n- Map sources into your project workflow only as pending source inventory.\n- Run \`mmi validate .\` before handing this packet to another agent.\n\n## Denied Next Steps\n\n- Do not treat any claim as source truth or project truth.\n- Do not mark the source matrix as bound.\n- Do not use this packet as training-data permission, production execution permission, or a review verdict.\n- Do not upload local private media to a provider unless a reviewed storage adapter created a signed URL first.\n\n## Non-Claims\n\n${packet.nonClaims.map((item) => `- \`${item}\``).join("\n")}\n\n## Issues\n\n${issueLines}`;
}

function nextActions(issues: GatewayIssue[]): CandidatePacketOutputManifest["nextActions"] {
  const actions: CandidatePacketOutputManifest["nextActions"] = [
    {
      id: "validate",
      command: "mmi validate .",
      description: "Validate candidate packet structure and safety invariants before downstream use.",
      required: true,
    },
    {
      id: "review",
      description: "Answer review_items.jsonl before treating any candidate observation as workflow input.",
      required: true,
    },
    {
      id: "handoff",
      command: "mmi handoff . --json",
      description: "Load machine-readable handoff summary before another agent continues the workflow.",
      required: false,
    },
  ];
  if (issues.length > 0) {
    actions.unshift({
      id: "resolve_issues",
      command: "mmi explain <issue-code>",
      description: "Resolve gateway issues listed in issues.json before downstream use.",
      required: true,
    });
  }
  return actions;
}

export async function readCandidatePacket(inputPath: string): Promise<CandidatePacket> {
  const stats = await fs.stat(inputPath);
  const packetPath = stats.isDirectory() ? path.join(inputPath, "packet.json") : inputPath;
  return JSON.parse(await fs.readFile(packetPath, "utf8")) as CandidatePacket;
}
