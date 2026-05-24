import path from "node:path";
import { MMI_PLUGIN_API_VERSION, type IntakePlugin, type NormalizedSource, type SourceType } from "./types.ts";

const MEDIA_SOURCE_TYPES = new Set<SourceType>(["image", "audio", "video"]);

function isRemoteUri(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

function isDataUri(uri: string): boolean {
  return /^data:/i.test(uri);
}

export type StorageAdapterResult = {
  signedUrl: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
};

export type StorageAdapter = {
  id: string;
  createSignedUrl(source: NormalizedSource): Promise<StorageAdapterResult> | StorageAdapterResult;
};

export type SignedUrlPacketUriMode = "redacted" | "original";

export type SignedUrlStorageBoundaryOptions = {
  packetUriMode?: SignedUrlPacketUriMode;
  includeSignedUrlMetadataInPacket?: boolean;
};

export function createSignedUrlStoragePlugin(storage: StorageAdapter): IntakePlugin {
  return {
    apiVersion: MMI_PLUGIN_API_VERSION,
    id: `storage:${storage.id}`,
    stage: "pre_ingest",
    async run(context) {
      for (const source of context.sources ?? []) {
        if (!shouldConvertToSignedUrl(source)) continue;
        const result = await storage.createSignedUrl(source);
        source.uri = result.signedUrl;
        source.privacy = "signed_url";
        source.metadata = {
          ...source.metadata,
          storageAdapterId: storage.id,
          signedUrlExpiresAt: result.expiresAt,
          signedUrlMetadata: result.metadata,
        };
      }
    },
  };
}

export function createSignedUrlStorageBoundaryPlugins(
  storage: StorageAdapter,
  options: SignedUrlStorageBoundaryOptions = {},
): IntakePlugin[] {
  const boundaryBySourceId = new Map<
    string,
    {
      signedUrl: string;
      originalUri: string;
      originalPrivacy: NormalizedSource["privacy"];
      packetUri: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    }
  >();
  const packetUriMode = options.packetUriMode ?? "redacted";
  const includeSignedUrlMetadataInPacket = options.includeSignedUrlMetadataInPacket === true;
  return [
    {
      apiVersion: MMI_PLUGIN_API_VERSION,
      id: `storage-boundary:${storage.id}:pre`,
      stage: "pre_ingest",
      async run(context) {
        for (const source of context.sources ?? []) {
          if (!shouldConvertToSignedUrl(source)) continue;
          const originalUri = source.uri;
          const originalPrivacy = source.privacy;
          const result = await storage.createSignedUrl(source);
          const packetUri = packetUriMode === "original" ? originalUri : `signed-url://${storage.id}/${source.id}`;
          boundaryBySourceId.set(source.id, {
            signedUrl: result.signedUrl,
            originalUri,
            originalPrivacy,
            packetUri,
            expiresAt: result.expiresAt,
            metadata: result.metadata,
          });
          source.uri = result.signedUrl;
          source.privacy = "signed_url";
          source.metadata = {
            ...source.metadata,
            storageAdapterId: storage.id,
            signedUrlExpiresAt: result.expiresAt,
            signedUrlPacketUriMode: packetUriMode,
          };
        }
      },
    },
    {
      apiVersion: MMI_PLUGIN_API_VERSION,
      id: `storage-boundary:${storage.id}:post`,
      stage: "post_ingest",
      run(context) {
        if (!context.packet) return;
        for (const source of context.packet.sources) {
          const boundary = boundaryBySourceId.get(source.id);
          if (!boundary) continue;
          source.uri = boundary.packetUri;
          source.privacy = packetUriMode === "original" ? boundary.originalPrivacy : "signed_url";
          source.metadata = {
            ...source.metadata,
            storageAdapterId: storage.id,
            signedUrlExpiresAt: boundary.expiresAt,
            ...(includeSignedUrlMetadataInPacket ? { signedUrlMetadata: boundary.metadata } : {}),
            signedUrlRedactedFromPacket: packetUriMode === "redacted",
          };
        }
        for (const atom of context.packet.evidenceAtoms) {
          const boundary = boundaryBySourceId.get(atom.sourceId);
          if (!boundary) continue;
          atom.locator.uri = boundary.packetUri;
          atom.content = atom.content.split(boundary.signedUrl).join(boundary.packetUri);
          atom.confidenceBasis = atom.confidenceBasis.split(boundary.signedUrl).join(boundary.packetUri);
        }
      },
    },
  ];
}

function shouldConvertToSignedUrl(source: NormalizedSource): boolean {
  if (!MEDIA_SOURCE_TYPES.has(source.type)) return false;
  if (isRemoteUri(source.uri) || isDataUri(source.uri)) return false;
  return path.isAbsolute(source.uri) || source.privacy === "project_private";
}
