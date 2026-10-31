export type CapabilityId =
  | "brief.plan" | "avatar.video" | "image.generate" | "video.generate"
  | "video.edit" | "voice.speech" | "voice.translate" | "media.enhance"
  | "media.remove-object" | "media.upscale" | "campaign.variants";

export type ProviderReadiness = "available" | "needs-credentials" | "unsupported" | "disabled";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface CapabilityDescriptor {
  id: CapabilityId;
  label: string;
  inputs: string[];
  outputs: string[];
  requiresConsent?: boolean;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  capabilities: CapabilityId[];
  readiness: ProviderReadiness;
  docsUrl?: string;
}

export interface CreativeJob<TInput = Record<string, unknown>> {
  id: string;
  capability: CapabilityId;
  input: TInput;
  state: JobState;
  providerId?: string;
  createdAt: string;
  updatedAt: string;
  outputAssetIds: string[];
  error?: { code: string; message: string; retryable: boolean };
}

export interface CapabilityAdapter {
  readonly provider: ProviderDescriptor;
  supports(capability: CapabilityId): boolean;
  execute<TInput>(capability: CapabilityId, input: TInput, signal?: AbortSignal): Promise<{
    providerJobId?: string;
    output: unknown;
    usage?: { inputUnits?: number; outputUnits?: number; estimatedCost?: number; currency?: string };
  }>;
}

/**
 * Providers must implement this contract on the trusted server.
 * Browser code must never receive provider credentials.
 * Consent-gated capabilities must validate rights/consent before dispatch.
 */
export const capabilityCatalog: CapabilityDescriptor[] = [
  { id: "brief.plan", label: "Creative planning", inputs: ["brief", "references"], outputs: ["production-plan"] },
  { id: "avatar.video", label: "Presenter video", inputs: ["script", "consented-avatar", "voice"], outputs: ["video"], requiresConsent: true },
  { id: "image.generate", label: "Image generation", inputs: ["prompt", "references"], outputs: ["image"] },
  { id: "video.generate", label: "Video generation", inputs: ["prompt", "references", "shot-plan"], outputs: ["video"] },
  { id: "video.edit", label: "Video editing", inputs: ["video", "edit-instructions"], outputs: ["video"] },
  { id: "voice.speech", label: "Speech generation", inputs: ["script", "voice-profile"], outputs: ["audio"], requiresConsent: true },
  { id: "voice.translate", label: "Dubbing and localization", inputs: ["source-video", "target-language"], outputs: ["localized-video"], requiresConsent: true },
  { id: "media.enhance", label: "Media restoration", inputs: ["image-or-video", "enhancement-profile"], outputs: ["image-or-video"] },
  { id: "media.remove-object", label: "Object removal", inputs: ["image-or-video", "mask"], outputs: ["image-or-video"] },
  { id: "media.upscale", label: "Super-resolution", inputs: ["image-or-video", "target-resolution"], outputs: ["image-or-video"] },
  { id: "campaign.variants", label: "Campaign variants", inputs: ["campaign-brief", "channels"], outputs: ["creative-variants"] }
];
