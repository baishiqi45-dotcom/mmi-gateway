import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAsrTaskFetch } from "./perception.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mmi-perception-"));
}

describe("ASR task fetch", () => {
  it("downloads DashScope transcription results into review-required sidecars", async () => {
    const root = await tmpDir();
    const perceptionDir = path.join(root, "perception");
    await fs.mkdir(perceptionDir, { recursive: true });
    await fs.writeFile(
      path.join(perceptionDir, "asr_tasks.jsonl"),
      JSON.stringify({
        schema: "mmi.gateway.asr_task",
        providerId: "dashscope",
        taskId: "task_123",
        fileRefs: [
          {
            fileUrl: "https://storage.example/audio.wav",
            sourceIds: ["src_video_001"],
            targetIds: ["video_window_001"],
            relativePaths: ["video/walkthrough.mp4"],
            timecodes: ["00:00:00-00:00:10"],
          },
        ],
        response: { output: { task_id: "task_123" } },
        status: "submitted",
      }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(perceptionDir, "agent_review_targets.jsonl"),
      JSON.stringify({
        id: "agent_review_target_00001",
        targetId: "video_window_001",
        targetType: "video_window",
        sourceId: "src_video_001",
        relativePath: "video/walkthrough.mp4",
        keyframePaths: [],
        transcriptSidecarRefs: [],
        suggestedReview: "fixture",
        status: "agent_review_required",
      }) + "\n",
      "utf8",
    );
    const previousKey = process.env.DASHSCOPE_API_KEY;
    process.env.DASHSCOPE_API_KEY = "test_key";
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/v1/tasks/task_123")) {
        return new Response(
          JSON.stringify({
            output: {
              task_id: "task_123",
              task_status: "SUCCEEDED",
              results: [
                {
                  file_url: "https://storage.example/audio.wav",
                  transcription_url: "https://result.example/task_123.json",
                  subtask_status: "SUCCEEDED",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url === "https://result.example/task_123.json") {
        return new Response(JSON.stringify({ transcripts: [{ text: "hello", begin_time: 0, end_time: 1000 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: `unexpected ${url}` }), { status: 404 });
    };

    try {
      const result = (await runAsrTaskFetch(root, { fetch: fakeFetch })) as {
        status: string;
        counts: { tasks: number; results: number; transcripts: number; blockers: number };
      };

      expect(result.status).toBe("asr_results_review_required");
      expect(result.counts).toMatchObject({ tasks: 1, results: 1, transcripts: 1, blockers: 0 });
      expect(calls).toEqual(["POST https://dashscope.aliyuncs.com/api/v1/tasks/task_123", "GET https://result.example/task_123.json"]);
      const resultLine = (await fs.readFile(path.join(perceptionDir, "asr_results.jsonl"), "utf8")).trim();
      expect(resultLine).toContain("transcripts/task_123_01.json");
      const transcript = JSON.parse(await fs.readFile(path.join(perceptionDir, "transcripts", "task_123_01.json"), "utf8")) as {
        schema: string;
        status: string;
        sourceIds?: string[];
        targetIds?: string[];
        transcript: { transcripts: Array<{ text: string }> };
      };
      expect(transcript).toMatchObject({
        schema: "mmi.gateway.asr_transcript",
        status: "review_required",
        sourceIds: ["src_video_001"],
        targetIds: ["video_window_001"],
        transcript: { transcripts: [{ text: "hello" }] },
      });
      const sidecarLine = (await fs.readFile(path.join(perceptionDir, "transcript_sidecars.jsonl"), "utf8")).trim();
      expect(sidecarLine).toContain("transcripts/task_123_01.json");
      expect(sidecarLine).toContain("src_video_001");
      const agentTarget = await fs.readFile(path.join(perceptionDir, "agent_review_targets.jsonl"), "utf8");
      expect(agentTarget).toContain("transcripts/task_123_01.json");
    } finally {
      if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = previousKey;
    }
  });

  it("writes a blocker manifest when no ASR task id is available", async () => {
    const root = await tmpDir();
    const result = (await runAsrTaskFetch(root)) as {
      status: string;
      counts: { tasks: number; results: number; transcripts: number; blockers: number };
    };

    expect(result.status).toBe("asr_fetch_checked");
    expect(result.counts).toMatchObject({ tasks: 0, results: 0, transcripts: 0, blockers: 1 });
    const blockers = await fs.readFile(path.join(root, "perception", "asr_fetch_blockers.json"), "utf8");
    expect(blockers).toContain("No Paraformer task IDs were found.");
  });
});
