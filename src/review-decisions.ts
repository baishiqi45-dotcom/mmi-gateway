import fs from "node:fs/promises";
import path from "node:path";
import { MMI_GATEWAY_PACKAGE_VERSION } from "./types.ts";

export type ReviewDecisionValue = "accept" | "edit" | "discard" | "defer";

export type ReviewDecision = {
  reviewItemId?: string;
  targetAtomId?: string;
  decision: ReviewDecisionValue;
  editedContent?: string | null;
  reviewerNote?: string | null;
  correctedLabel?: string | null;
  rightsStatus?: "cleared" | "not_reviewed" | "restricted" | null;
  nextAction?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
};

type ReviewQueueItem = {
  id: string;
  targetAtomId?: string;
  question?: string;
  sourceRef?: unknown;
};

type AtomRow = {
  id: string;
  type?: string;
  content?: string;
  sourceRef?: unknown;
};

function parseJsonl<T>(raw: string, label: string): T[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${label} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function assertDecision(value: unknown): asserts value is ReviewDecisionValue {
  if (value !== "accept" && value !== "edit" && value !== "discard" && value !== "defer") {
    throw new Error("decision must be one of accept, edit, discard, defer");
  }
}

async function readJsonlFile<T>(filePath: string, label: string): Promise<T[]> {
  return parseJsonl<T>(await fs.readFile(filePath, "utf8"), label);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeDecision(raw: unknown): ReviewDecision {
  if (typeof raw !== "object" || raw === null) throw new Error("review decision row must be an object");
  const value = raw as Record<string, unknown>;
  assertDecision(value.decision);
  if (typeof value.reviewItemId !== "string" && typeof value.targetAtomId !== "string") {
    throw new Error("review decision row requires reviewItemId or targetAtomId");
  }
  return {
    reviewItemId: typeof value.reviewItemId === "string" ? value.reviewItemId : undefined,
    targetAtomId: typeof value.targetAtomId === "string" ? value.targetAtomId : undefined,
    decision: value.decision,
    editedContent: typeof value.editedContent === "string" ? value.editedContent : null,
    reviewerNote: typeof value.reviewerNote === "string" ? value.reviewerNote : null,
    correctedLabel: typeof value.correctedLabel === "string" ? value.correctedLabel : null,
    rightsStatus: value.rightsStatus === "cleared" || value.rightsStatus === "restricted" || value.rightsStatus === "not_reviewed" ? value.rightsStatus : null,
    nextAction: typeof value.nextAction === "string" ? value.nextAction : null,
    decidedBy: typeof value.decidedBy === "string" ? value.decidedBy : null,
    decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : null,
  };
}

export async function summarizeReviewQueue(runDir: string): Promise<Record<string, unknown>> {
  const root = path.resolve(runDir);
  const queuePath = path.join(root, "review_queue.jsonl");
  const templatePath = path.join(root, "review_decisions.template.jsonl");
  const topTargetsPath = path.join(root, "top_review_targets.jsonl");
  const queue = await readJsonlFile<ReviewQueueItem>(queuePath, "review_queue.jsonl");
  const topTargets = await readJsonlFile<Record<string, unknown>>(topTargetsPath, "top_review_targets.jsonl").catch(() => []);
  return {
    schema: "mmi.gateway.review_queue_summary",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    status: "candidate_review_required",
    runDir: root,
    queuePath,
    templatePath,
    topTargetsPath,
    counts: {
      reviewItems: queue.length,
      topReviewTargets: topTargets.length,
    },
    nextActions: [
      {
        id: "fill_decisions",
        description: "Copy or edit review_decisions.template.jsonl with accept/edit/discard/defer decisions.",
        required: true,
      },
      {
        id: "apply_decisions",
        command: `mmi review ${shellArg(root)} --decisions ${shellArg(templatePath)} --json`,
        description: "Summarize accepted, edited, discarded, and deferred atoms without mutating packet.json.",
        required: true,
      },
    ],
  };
}

export async function applyReviewDecisions(runDir: string, decisionsPath: string): Promise<Record<string, unknown>> {
  const root = path.resolve(runDir);
  const resolvedDecisions = path.resolve(decisionsPath);
  const queue = await readJsonlFile<ReviewQueueItem>(path.join(root, "review_queue.jsonl"), "review_queue.jsonl");
  const atoms = await readJsonlFile<AtomRow>(path.join(root, "atoms.ndjson"), "atoms.ndjson");
  const decisions = (await readJsonlFile<unknown>(resolvedDecisions, "review_decisions")).map(normalizeDecision);
  const queueByReviewId = new Map(queue.map((item) => [item.id, item]));
  const queueByAtomId = new Map(queue.filter((item) => item.targetAtomId).map((item) => [String(item.targetAtomId), item]));
  const atomsById = new Map(atoms.map((atom) => [atom.id, atom]));
  const accepted: unknown[] = [];
  const edited: unknown[] = [];
  const discarded: unknown[] = [];
  const deferred: unknown[] = [];
  const unknownTargets: ReviewDecision[] = [];

  for (const decision of decisions) {
    const queueItem = (decision.reviewItemId ? queueByReviewId.get(decision.reviewItemId) : undefined) ?? (decision.targetAtomId ? queueByAtomId.get(decision.targetAtomId) : undefined);
    const atomId = decision.targetAtomId ?? queueItem?.targetAtomId;
    const atom = atomId ? atomsById.get(atomId) : undefined;
    if (!queueItem && !atom) {
      unknownTargets.push(decision);
      continue;
    }
    const row = {
      ...atom,
      reviewItemId: queueItem?.id ?? decision.reviewItemId,
      targetAtomId: atomId,
      decision: decision.decision,
      content: decision.decision === "edit" && decision.editedContent ? decision.editedContent : atom?.content,
      reviewerNote: decision.reviewerNote,
      correctedLabel: decision.correctedLabel,
      rightsStatus: decision.rightsStatus,
      nextAction: decision.nextAction,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      sourceRef: atom?.sourceRef ?? queueItem?.sourceRef,
    };
    if (decision.decision === "accept") accepted.push(row);
    else if (decision.decision === "edit") edited.push(row);
    else if (decision.decision === "discard") discarded.push(row);
    else deferred.push(row);
  }

  const summary = {
    schema: "mmi.gateway.review_decision_summary",
    schemaVersion: "1.0.0",
    gatewayVersion: MMI_GATEWAY_PACKAGE_VERSION,
    status: unknownTargets.length > 0 ? "review_decisions_need_attention" : "review_decisions_summarized",
    runDir: root,
    decisionsPath: resolvedDecisions,
    outputs: {
      acceptedAtoms: "accepted_atoms.jsonl",
      editedAtoms: "edited_atoms.jsonl",
      discardedReviewItems: "discarded_review_items.jsonl",
      deferredReviewItems: "deferred_review_items.jsonl",
      summary: "review_decision_summary.json",
    },
    counts: {
      decisions: decisions.length,
      accepted: accepted.length,
      edited: edited.length,
      discarded: discarded.length,
      deferred: deferred.length,
      unknownTargets: unknownTargets.length,
    },
    unknownTargets,
    nonClaims: [
      "review_decisions_are_not_source_truth",
      "review_decisions_do_not_bind_source_matrix",
      "accepted_atoms_remain_candidate_until_project_workflow_confirms_them",
    ],
  };

  await writeJsonl(path.join(root, "accepted_atoms.jsonl"), accepted);
  await writeJsonl(path.join(root, "edited_atoms.jsonl"), edited);
  await writeJsonl(path.join(root, "discarded_review_items.jsonl"), discarded);
  await writeJsonl(path.join(root, "deferred_review_items.jsonl"), deferred);
  await writeJson(path.join(root, "review_decision_summary.json"), summary);
  return summary;
}
