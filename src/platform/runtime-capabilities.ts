export type CapabilityState = "ready" | "limited" | "disabled" | "blocked";
export type RuntimeCapabilityInput = {
  authMode?: "local" | "supabase";
  authSessionReady?: boolean;
  authSessionEncrypted?: boolean;
  cloudMediaReady?: boolean;
  cloudMediaJobsEnabled?: boolean;
  textGatewayEnabled?: boolean;
  textGatewayConfigured?: boolean;
  imageGatewayEnabled?: boolean;
  imageGatewayConfigured?: boolean;
  ffmpeg?: boolean;
  ffprobe?: boolean;
  billingEnabled?: boolean;
  billingProviderConfigured?: boolean;
  billingWebhookConfigured?: boolean;
  billingProviderMode?: "sandbox" | "live" | "unknown";
  cloudVideoWorker?: {
    enabled?: boolean;
    remoteExecutionGates?: boolean;
    modelRouterEnabled?: boolean;
    modelRouterRemoteEnabled?: boolean;
    modelRouterConfigPresent?: boolean;
    providerCredentialConfigured?: boolean;
    falAdapterConfigured?: boolean;
    outputHostAllowlistConfigured?: boolean;
    supabaseCredentialsConfigured?: boolean;
    directRunwayModelsRequested?: boolean;
    runtimeMode?: "separate-process" | "embedded" | "unknown";
  };
};
export type RuntimeCapability = { id: string; label: string; state: CapabilityState; detail: string };
export type LocalAssetUploadHealth = { enabled?: boolean; code?: string | null; message?: string | null } | null | undefined;
export type LocalAssetUploadReadiness = { enabled: boolean; message: string };

export function resolveLocalAssetUploadReadiness(input: LocalAssetUploadHealth): LocalAssetUploadReadiness {
  if (input?.enabled === true) return { enabled: true, message: "" };
  const message = typeof input?.message === "string" && input.message.trim()
    ? input.message.trim()
    : "The server has not confirmed durable local media storage. Local uploads remain disabled.";
  return { enabled: false, message };
}


export function describeRuntimeCapabilities(input: RuntimeCapabilityInput = {}): RuntimeCapability[] {
  const authMode = input.authMode || "local";
  const auth: RuntimeCapability = authMode === "supabase"
    ? input.authSessionReady === true && input.authSessionEncrypted === true
      ? { id: "account-session", label: "Secure account sessions", state: "ready", detail: "Opaque browser cookie and encrypted server-side tokens are reported configured." }
      : { id: "account-session", label: "Secure account sessions", state: "blocked", detail: "Hosted Supabase session configuration is incomplete; account-backed access must remain unavailable." }
    : { id: "account-session", label: "Account authentication", state: "limited", detail: "Local authentication mode is active; hosted Supabase account sessions are not enabled." };

  const cloud: RuntimeCapability = input.cloudMediaReady === true && input.cloudMediaJobsEnabled === true
    ? { id: "cloud-media", label: "Private cloud media jobs", state: "ready", detail: "Cloud media API and cloud media jobs API are both enabled." }
    : input.cloudMediaReady === true
      ? { id: "cloud-media", label: "Private cloud media jobs", state: "limited", detail: "Cloud media API is enabled, but the cloud media jobs API is not enabled." }
      : { id: "cloud-media", label: "Private cloud media jobs", state: "disabled", detail: "Cloud media API is disabled; uploads and jobs use the configured local application path." };

  const gateway = (id: string, label: string, enabled?: boolean, configured?: boolean): RuntimeCapability =>
    enabled === true && configured === true
      ? { id, label, state: "ready", detail: "Gateway is enabled and its server-side configuration is present; workflow approvals and spending controls still apply." }
      : enabled === true
        ? { id, label, state: "blocked", detail: "Gateway is enabled but required server-side configuration is incomplete." }
        : { id, label, state: "disabled", detail: "Gateway is disabled by default; no remote generation request can be submitted through it." };

  const media: RuntimeCapability = input.ffmpeg === true && input.ffprobe === true
    ? { id: "media-engine", label: "Local media engine", state: "ready", detail: "FFmpeg and FFprobe are both detected." }
    : input.ffprobe === true
      ? { id: "media-engine", label: "Local media engine", state: "limited", detail: "FFprobe is detected, but FFmpeg is unavailable; rendering and transcoding are limited." }
      : { id: "media-engine", label: "Local media engine", state: "blocked", detail: "FFprobe is unavailable; media probing and dependent workflows cannot run." };

  const billing: RuntimeCapability = input.billingEnabled !== true
    ? { id: "billing", label: "Subscriptions and billing", state: "disabled", detail: "Billing API is disabled; checkout and paid entitlement changes are unavailable." }
    : input.billingProviderConfigured === true && input.billingWebhookConfigured === true
      ? { id: "billing", label: "Subscriptions and billing", state: "ready", detail: "Billing credentials and webhook secret are configured (" + (input.billingProviderMode === "live" ? "live provider" : input.billingProviderMode === "sandbox" ? "sandbox provider" : "provider mode unverified") + "). Merchant onboarding and webhook smoke tests remain separate release gates." }
      : { id: "billing", label: "Subscriptions and billing", state: "blocked", detail: "Billing is enabled but provider credentials or webhook verification configuration is incomplete." };

  const worker = input.cloudVideoWorker || {};
  const runwayRouterReady = worker.modelRouterEnabled === true &&
    worker.modelRouterRemoteEnabled === true &&
    worker.modelRouterConfigPresent === true &&
    worker.providerCredentialConfigured === true &&
    worker.directRunwayModelsRequested !== true;
  const providerAdapterReady = worker.falAdapterConfigured === true || runwayRouterReady;
  const workerChecks = [
    worker.remoteExecutionGates === true,
    providerAdapterReady,
    worker.outputHostAllowlistConfigured === true,
    worker.supabaseCredentialsConfigured === true,
    worker.directRunwayModelsRequested !== true,
    input.authMode === "supabase" && input.authSessionReady === true && input.authSessionEncrypted === true,
    input.cloudMediaReady === true,
    input.ffmpeg === true && input.ffprobe === true
  ];
  const videoWorker: RuntimeCapability = worker.enabled !== true
    ? { id: "cloud-video-worker", label: "Governed cloud video worker", state: "disabled", detail: "The separate provider-aware worker process is not enabled in this environment. Paid cloud generation remains unavailable." }
    : workerChecks.some(ready => ready !== true)
      ? { id: "cloud-video-worker", label: "Governed cloud video worker", state: "blocked", detail: "The worker launch gates are incomplete. Verify Supabase authentication, cloud API, FFmpeg/FFprobe, either a fully configured FAL adapter or an exact Runway Model Router configuration, output-host allowlist and both remote-execution approvals. Direct Runway model execution remains disabled. No provider job should be submitted." }
      : { id: "cloud-video-worker", label: "Governed cloud video worker", state: "limited", detail: "Worker launch configuration is complete, but the web service cannot verify that the separate worker process is running. Confirm its live logs and queue recovery before enabling paid generation." };

  return [auth, cloud, videoWorker, gateway("text-gateway", "Text generation gateway", input.textGatewayEnabled, input.textGatewayConfigured), gateway("image-gateway", "Image generation gateway", input.imageGatewayEnabled, input.imageGatewayConfigured), media, billing];
}
