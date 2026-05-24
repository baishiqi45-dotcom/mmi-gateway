import { readCandidatePacket, writeCandidatePacket, type CandidatePacketWriteOptions } from "./packet-io.ts";
import type { CandidatePacket } from "./types.ts";

export async function writePacket(
  packet: CandidatePacket,
  outputDir: string,
  options: CandidatePacketWriteOptions = {},
): Promise<void> {
  await writeCandidatePacket(packet, outputDir, options);
}

export async function readPacket(fileOrDir: string): Promise<CandidatePacket> {
  return readCandidatePacket(fileOrDir);
}
