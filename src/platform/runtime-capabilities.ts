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
};
export type RuntimeCapability = { id: string; label: string; state: CapabilityState; detail: string };

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

  return [auth, cloud, gateway("text-gateway", "Text generation gateway", input.textGatewayEnabled, input.textGatewayConfigured), gateway("image-gateway", "Image generation gateway", input.imageGatewayEnabled, input.imageGatewayConfigured), media, billing];
}
