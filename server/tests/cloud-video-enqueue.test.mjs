import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoEnqueue } from "../cloud-video-enqueue.mjs";
import { estimateVideoGenerationCost } from "../video-generation-cost-estimator.mjs";

const base = { url: "https://example.supabase.co", serviceRoleKey: "cloud-video-test-secret" };
const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "423e4567-e89b-42d3-a456-426614174000";
const requestHash = "a".repeat(64);
const input = { projectId, provider: "runway", model: "gen4.5", requestHash, durationSeconds: 5, prompt: "A test scene" };
const approvalId = "523e4567-e89b-42d3-a456-426614174000";
const leaseToken = "923e4567-e89b-42d3-a456-426614174000";
const resultRow = {
  job_id: "623e4567-e89b-42d3-a456-426614174000",
  job_status: "queued",
  idempotent_replay: false,
  budget_reservation_id: "723e4567-e89b-42d3-a456-426614174000"
};
function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}
function args(overrides = {}) {
  return {
    ownerId, projectId, idempotencyKey: "request-001", provider: "runway", model: "gen4.5",
    requestHash, input, budgetApprovalId: approvalId, reservedAmount: 1.25, currency: "USD", ...overrides
  };
}

test("cloud enqueue cancels oversized RPC response streams before buffering unbounded data", async () => {
  let cancelled = false;
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() { cancelled = true; }
    }), { status: 200 })
  });
  await assert.rejects(
    () => client.enqueue(args()),
    /response exceeded the 1 MB limit/
  );
  assert.equal(cancelled, true);
});

test("cloud enqueue uses service-role credentials and the private schema", async () => {
  const calls = [];
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response([resultRow]);
    }
  });
  const result = await client.enqueue(args());
  assert.deepEqual(result, {
    jobId: resultRow.job_id, status: "queued", idempotentReplay: false,
    budgetReservationId: resultRow.budget_reservation_id
  });
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/enqueue_video_generation_job");
  assert.equal(calls[0].options.headers["accept-profile"], "executive_visuals");
  assert.equal(calls[0].options.headers["content-profile"], "executive_visuals");
  assert.equal(calls[0].options.headers.apikey, base.serviceRoleKey);
  assert.equal(calls[0].options.headers.authorization, "Bearer " + base.serviceRoleKey);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_owner_id: ownerId, p_project_id: projectId, p_idempotency_key: "request-001",
    p_provider: "runway", p_model: "gen4.5", p_request_hash: requestHash,
    p_input: input, p_budget_approval_id: approvalId, p_reserved_amount: 1.25, p_currency: "USD"
  });
});

test("enqueue preserves active-job idempotent replay and atomically finalizes budget with job", async () => {
  const calls = [];
  const replay = { ...resultRow, job_status: "processing", idempotent_replay: true };
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(url.endsWith("/finish_video_generation_job_v2") ? true : [replay]);
    }
  });
  const queued = await client.enqueue(args());
  assert.equal(queued.idempotentReplay, true);
  assert.equal(queued.status, "processing");
  assert.equal(await client.finish({
    jobId: resultRow.job_id, workerId: "video-worker-1", leaseToken, status: "succeeded",
    output: { assetIds: ["asset-1"] }, actualAmount: 0.8
  }), true);
  assert.equal(await client.finish({
    jobId: resultRow.job_id, workerId: "video-worker-1", leaseToken, status: "failed",
    error: { code: "PROVIDER_FAILED" }
  }), true);
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), [
    "enqueue_video_generation_job", "finish_video_generation_job_v2", "finish_video_generation_job_v2"
  ]);
  assert.deepEqual(calls[1].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1", p_lease_token: leaseToken, p_status: "succeeded",
    p_output: { assetIds: ["asset-1"] }, p_error: null, p_actual_amount: 0.8
  });
  assert.equal(calls[2].body.p_actual_amount, null);
});

test("cloud video deferral, quarantine and evidence-reconciled resume use dedicated RPCs", async () => {
  const calls = [];
  const client = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(url.endsWith("/recover_expired_video_generation_jobs") ? 2 : true);
    }
  });
  assert.equal(await client.defer({
    jobId: resultRow.job_id, workerId: "video-worker-1", leaseToken, delaySeconds: 45
  }), true);
  assert.equal(await client.quarantine({
    jobId: resultRow.job_id, workerId: "video-worker-1"
  }), true);
  assert.equal(await client.resumeReconciled({
    jobId: resultRow.job_id, ownerId, evidenceReference: "review-ticket:OPS-17"
  }), true);
  assert.equal(await client.recoverExpiredVideo(25), 2);
  assert.deepEqual(calls.map(call => call.url.split("/").pop()), [
    "defer_video_generation_job_v2", "quarantine_video_generation_job_v2",
    "resume_reconciled_video_generation_job", "recover_expired_video_generation_jobs"
  ]);
  assert.deepEqual(calls[0].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1", p_lease_token: leaseToken,
    p_delay_seconds: 45, p_reason_code: "VIDEO_PROVIDER_POLL_DEFERRED"
  });
  assert.deepEqual(calls[1].body, {
    p_job_id: resultRow.job_id, p_worker_id: "video-worker-1", p_lease_token: leaseToken,
    p_reason_code: "VIDEO_SUBMISSION_REQUIRES_RECONCILIATION"
  });
  assert.deepEqual(calls[2].body, {
    p_job_id: resultRow.job_id, p_owner_id: ownerId,
    p_evidence_reference: "review-ticket:OPS-17"
  });
  assert.deepEqual(calls[3].body, { p_limit: 25 });
});

test("cloud video deferral and quarantine reject invalid controls before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response(true); } });
  await assert.rejects(() => client.defer({ jobId: resultRow.job_id, workerId: "worker", leaseToken, delaySeconds: 1 }), /between 5 and 900/);
  await assert.rejects(() => client.quarantine({ jobId: resultRow.job_id, workerId: "worker", leaseToken, reasonCode: "not safe" }), /reason code/);
  await assert.rejects(() => client.resumeReconciled({ jobId: resultRow.job_id, ownerId }), /Evidence reference/);
  assert.equal(calls, 0);
});

test("enqueue rejects mismatched request scope and invalid budget inputs before network access", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({ ...base, fetchImpl: async () => { calls++; return response([resultRow]); } });
  await assert.rejects(() => client.enqueue(args({ input: { ...input, requestHash: "b".repeat(64) } })), /does not match/);
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0 })), /positive bounded/);
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0.5 })), error =>
    error.code === "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE"
  );
  await assert.rejects(() => client.enqueue(args({ reservedAmount: 0.59 })), error =>
    error.code === "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE" && error.estimate.amount === 0.6
  );
  await assert.rejects(() => client.enqueue(args({ input: { ...input, outputFormat: "prores" } })), /supports MP4 outputs/);
  await assert.rejects(() => client.enqueue(args({ input: { ...input, durationSeconds: 11 } })), /pricing bounds/);
  await assert.rejects(() => client.enqueue(args({ currency: "EUR" })), /must match the verified provider price/);
  await assert.rejects(() => client.enqueue(args({
    provider: "luma", model: "ray-3.2",
    input: { ...input, provider: "luma", model: "ray-3.2" }
  })), error => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>client.enqueue(args({model:"kling_4",input:{...input,model:"kling_4",resolution:"720p"}})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(() => client.enqueue(args({ currency: "usd" })), /three-letter/);
  await assert.rejects(() => client.enqueue(args({ idempotencyKey: "bad key" })), /invalid format/);
  await assert.rejects(() => client.enqueue(args({ input: [] })), /must be an object/);
  await assert.rejects(() => client.finish({ jobId: resultRow.job_id, workerId: "worker", leaseToken, status: "succeeded" }), /require a non-negative/);
  await assert.rejects(() => client.finish({ jobId: resultRow.job_id, workerId: "worker", leaseToken, status: "failed", actualAmount: 1 }), /must release their reservation/);
  assert.equal(calls, 0);
});

test("enqueue fails closed on malformed RPC results and redacts server credentials", async () => {
  const malformed = createCloudVideoEnqueue({ ...base, fetchImpl: async () => response([{ ...resultRow, job_status: "not-a-job-state" }]) });
  await assert.rejects(() => malformed.enqueue(args()), /invalid job\/reservation result/);
  const denied = createCloudVideoEnqueue({
    ...base,
    fetchImpl: async () => response({ message: "permission denied " + base.serviceRoleKey }, 403)
  });
  await assert.rejects(() => denied.enqueue(args()), error =>
    error.code === "CLOUD_VIDEO_ENQUEUE_HTTP_403" && !error.message.includes(base.serviceRoleKey)
  );
});

test("cloud enqueue configuration rejects insecure remote endpoints", () => {
  assert.throws(() => createCloudVideoEnqueue({ url: "http://remote.example", serviceRoleKey: "secret" }), /HTTPS/);
  assert.throws(() => createCloudVideoEnqueue({ url: base.url }), /SUPABASE_SERVICE_ROLE_KEY/);
});

test("Runway budget estimate uses the shared dated pricing engine and is not settlement evidence", () => {
  const estimate=estimateVideoGenerationCost({provider:"runway",model:"gen4.5",durationSeconds:5});
  assert.equal(estimate.provider,"runway");
  assert.equal(estimate.model,"gen4.5");
  assert.equal(estimate.outputFormat,"mp4");
  assert.equal(estimate.credits,60);
  assert.equal(estimate.currency,"USD");
  assert.equal(estimate.amount,0.6);
  assert.equal(estimate.basis,"provider_list_price_estimate");
  assert.equal(estimate.pricingSource,"https://docs.dev.runwayml.com/guides/pricing/");
  assert.match(estimate.pricingDate,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(estimate.pricingFormula,"5s × 12 credits/s");
  assert.equal(estimate.settlementEligible,false);
  assert.equal(estimate.billable,false);
  assert.equal(estimateVideoGenerationCost({provider:"runway",model:"gen4.5",durationSeconds:5,outputFormat:"prores"}).credits,85);
  assert.throws(()=>estimateVideoGenerationCost({provider:"runway",model:"gen4.5",durationSeconds:1}),error=>error.code==="VIDEO_PRICE_DURATION_INVALID");
  assert.throws(()=>estimateVideoGenerationCost({provider:"runway",model:"ruby",durationSeconds:10}),error=>error.code==="VIDEO_PRICE_INPUT_REQUIRED");
  const lumaEstimate = estimateVideoGenerationCost({provider:"luma",model:"ray-3.2",resolution:"720p",durationSeconds:5});
  assert.equal(lumaEstimate.amount,0.3);
  assert.equal(lumaEstimate.billable,false);
});

test("Gen-4.5 enqueue accepts its private first-frame path but rejects unsupported execution options",async()=>{
  let calls=0;
  const client=createCloudVideoEnqueue({...base,fetchImpl:async()=>{calls++;return response([resultRow]);}});
  const queued=await client.enqueue(args({input:{...input,startFrameAssetId:"823e4567-e89b-42d3-a456-426614174000"}}));
  assert.equal(queued.status,"queued");
  await assert.rejects(()=>client.enqueue(args({input:{...input,referenceAssetIds:["923e4567-e89b-42d3-a456-426614174000"]}})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>client.enqueue(args({input:{...input,resolution:"720p"}})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>client.enqueue(args({input:{...input,resolution:"1080p"}})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>client.enqueue(args({input:{...input,audioMode:"generated"}})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  assert.equal(calls,1);
});
const googleEnv = {
  GEMINI_OMNI_ENABLED: "true",
  GEMINI_OMNI_ALLOW_REMOTE: "true",
  GEMINI_OMNI_PAID_TIER_CONFIRMED: "true",
  GEMINI_OMNI_WORKER_ENABLED: "true"
};
const googleInput = {
  projectId, provider: "google", model: "gemini-omni-1.1-flash",
  requestHash, durationSeconds: 5, resolution: "720p", aspectRatio: "16:9",
  outputFormat: "mp4", operation: "generate", prompt: "A cinematic sunrise"
};
function googleArgs(overrides = {}) {
  return {
    ownerId, projectId, idempotencyKey: "google-request-001",
    provider: "google", model: "gemini-omni-1.1-flash", requestHash,
    input: googleInput, budgetApprovalId: approvalId,
    reservedAmount: 2.586464, currency: "USD", ...overrides
  };
}

test("Google Omni enqueue is disabled unless remote, paid-tier and worker flags are all explicitly enabled", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({
    ...base, env: googleEnv,
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  for (const key of Object.keys(googleEnv)) {
    const env = {...googleEnv,[key]:"false"};
    const disabled = createCloudVideoEnqueue({...base,env,fetchImpl:async()=>{calls++;return response([resultRow]);}});
    await assert.rejects(()=>disabled.enqueue(googleArgs()),error=>error.code==="GEMINI_OMNI_REMOTE_DISABLED");
  }
  assert.equal(calls,0);
});

test("Google Omni enqueue accepts only its verified 720p model and reserves the conservative maximum cost", async () => {
  const calls=[];
  const client=createCloudVideoEnqueue({
    ...base,env:googleEnv,
    fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return response([resultRow]);}
  });
  const result=await client.enqueue(googleArgs());
  assert.equal(result.jobId,resultRow.job_id);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.p_provider,"google");
  assert.equal(calls[0].body.p_model,"gemini-omni-1.1-flash");
  assert.equal(calls[0].body.p_reserved_amount,2.586464);
  assert.equal(calls[0].body.p_currency,"USD");
  assert.deepEqual(calls[0].body.p_input,googleInput);
});

test("Gemini Omni 1.2 remains blocked until its dedicated pricing and SQL contract are deployed", async () => {
  let calls = 0;
  const client = createCloudVideoEnqueue({
    ...base,
    env: googleEnv,
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  const input = {
    ...googleInput,
    model: "gemini-omni-1.2-flash",
    durationSeconds: 15,
    resolution: "720p"
  };
  await assert.rejects(
    client.enqueue(googleArgs({ model: "gemini-omni-1.2-flash", input, reservedAmount: 2 }))
  );
  assert.equal(calls, 0);
});

test("Google Omni enqueue rejects under-reservation, unsupported resolution, invalid duration and unsupported controls", async () => {
  let calls=0;
  const client=createCloudVideoEnqueue({...base,env:googleEnv,fetchImpl:async()=>{calls++;return response([resultRow]);}});
  await assert.rejects(()=>client.enqueue(googleArgs({reservedAmount:2.586463})),error=>
    error.code==="VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE"&&error.estimate.amount===2.586464);
  await assert.rejects(()=>client.enqueue(googleArgs({input:{...googleInput,resolution:"1080p"}})),error=>
    error.code==="VIDEO_PRICE_UNSUPPORTED_RESOLUTION");
  await assert.rejects(()=>client.enqueue(googleArgs({input:{...googleInput,durationSeconds:2}})),error=>
    error.code==="VIDEO_PRICE_DURATION_INVALID");
  await assert.rejects(()=>client.enqueue(googleArgs({input:{...googleInput,negativePrompt:"no blur"}})),error=>
    error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  await assert.rejects(()=>client.enqueue(googleArgs({input:{...googleInput,operation:"extend"}})),/require a previous interaction or source video/);
  await assert.rejects(()=>client.enqueue(googleArgs({input:{...googleInput,lastFrameAssetId:"44444444-4444-4444-8444-444444444444"}})),/requires a first frame/);
  assert.equal(calls,0);
});

test("Google Omni enqueue normalizes provider-default resolution to the verified 720p budget tier", async () => {
  let captured;
  const client=createCloudVideoEnqueue({
    ...base,env:googleEnv,
    fetchImpl:async(url,options)=>{captured=JSON.parse(options.body);return response([resultRow]);}
  });
  const input={...googleInput};delete input.resolution;
  await client.enqueue(googleArgs({input}));
  assert.equal(captured.p_reserved_amount,2.586464);
  assert.equal(captured.p_input.resolution,undefined);
});


test("Aleph2 validates owner-scoped source metadata and reaches the durable SQL enqueue boundary", async () => {
  let calls = 0;
  const sourceVideoAssetId = "823e4567-e89b-42d3-a456-426614174000";
  const input = {
    projectId, provider: "runway", model: "aleph2", requestHash,
    operation: "video-to-video", sourceVideoAssetId,
    durationSeconds: 12, prompt: "Preserve the subject; replace the background.",
    outputFormat: "mp4"
  };
  const noResolver = createCloudVideoEnqueue({
    ...base, fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(() => noResolver.enqueue(args({
    model: "aleph2", input, reservedAmount: 4
  })), error => error.code === "VIDEO_SOURCE_METADATA_UNAVAILABLE");
  const client = createCloudVideoEnqueue({
    ...base,
    resolveRunwaySourceMetadata: async scope => {
      assert.deepEqual(scope, { ownerId, projectId, assetId: sourceVideoAssetId });
      return {
        ownerId, projectId, assetId: sourceVideoAssetId,
        mediaType: "video/mp4", durationSeconds: 11.2, frameCount: 336
      };
    },
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  const queued = await client.enqueue(args({
    model: "aleph2", input, reservedAmount: 4
  }));
  assert.equal(queued.status, "queued");
  assert.equal(calls, 1);
});

test("Magnific upscale budget uses verified source frames, not caller-supplied lower values", async () => {
  let calls = 0;
  const sourceVideoAssetId = "923e4567-e89b-42d3-a456-426614174000";
  const metadata = {
    ownerId, projectId, assetId: sourceVideoAssetId,
    mediaType: "video/mp4", durationSeconds: 11.2, frameCount: 336
  };
  const client = createCloudVideoEnqueue({
    ...base,
    resolveRunwaySourceMetadata: async () => metadata,
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  const input = {
    projectId, provider: "runway", model: "magnific_video_upscaler_creative",
    requestHash, operation: "video-upscale", sourceVideoAssetId,
    durationSeconds: 12, outputFrames: 336, resolution: "2k", outputFormat: "mp4"
  };
  await assert.rejects(() => client.enqueue(args({
    model: "magnific_video_upscaler_creative", input, reservedAmount: 3.0
  })), error => error.code === "VIDEO_BUDGET_BELOW_PROVIDER_ESTIMATE" && error.estimate.amount === 3.03);
  await assert.rejects(() => client.enqueue(args({
    model: "magnific_video_upscaler_creative",
    input: { ...input, outputFrames: 1 }, reservedAmount: 4
  })), error => error.code === "VIDEO_SOURCE_METADATA_MISMATCH");
  await assert.rejects(() => client.enqueue(args({
    model: "magnific_video_upscaler_creative",
    input: { ...input, durationSeconds: 11 }, reservedAmount: 4
  })), error => error.code === "VIDEO_SOURCE_METADATA_MISMATCH");
  await assert.rejects(() => client.enqueue(args({
    model: "magnific_video_upscaler_creative", input, reservedAmount: 4
  })), error => error.code === "VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED");
  assert.equal(calls, 0);
});


test("Ruby HDR validates verified SDR dimensions but is blocked by the durable SQL enqueue allowlist", async () => {
  let calls = 0;
  const sourceVideoAssetId = "a23e4567-e89b-42d3-a456-426614174000";
  const input = {
    projectId, provider: "runway", model: "ruby", requestHash,
    operation: "video-to-hdr", sourceVideoAssetId,
    durationSeconds: 15, outputFormat: "hdr10"
  };
  const sourceMetadata = {
    ownerId, projectId, assetId: sourceVideoAssetId,
    mediaType: "video/mp4", durationSeconds: 14.2, frameCount: 426,
    sourceDynamicRange: "sdr", sourceWidth: 1920, sourceHeight: 1080
  };
  const client = createCloudVideoEnqueue({
    ...base,
    resolveRunwaySourceMetadata: async scope => {
      assert.deepEqual(scope, { ownerId, projectId, assetId: sourceVideoAssetId });
      return sourceMetadata;
    },
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(() => client.enqueue(args({
    model: "ruby", input, reservedAmount: 3.5
  })), error => error.code === "VIDEO_ENQUEUE_PROVIDER_NOT_ENABLED");
  assert.equal(calls, 0);
  const nonSdr = createCloudVideoEnqueue({
    ...base,
    resolveRunwaySourceMetadata: async () => ({ ...sourceMetadata, sourceDynamicRange: "hdr" }),
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(() => nonSdr.enqueue(args({
    model: "ruby", input, reservedAmount: 3.5
  })), error => error.code === "VIDEO_SOURCE_METADATA_INVALID");
  assert.equal(calls, 0);
});

test("Runway Model Router requires explicit config gates, supports durable enqueue and rejects unsupported operations", async () => {
  const routerInput = {
    projectId, provider: "runway", model: "model-router", requestHash,
    operation: "text-to-video", prompt: "A cinematic product launch", durationSeconds: 8,
    aspectRatio: "16:9", audioMode: "generated"
  };
  let calls = 0;
  const env = {
    RUNWAY_MODEL_ROUTER_ENABLED: "true", CLOUD_VIDEO_WORKER_ENABLED: "true",
    RUNWAY_VIDEO_ALLOW_REMOTE: "true", RUNWAY_VIDEO_ROUTER_CONFIG: "production-video",
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true"
  };
  const client = createCloudVideoEnqueue({
    ...base, env,
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  const queued = await client.enqueue(args({
    provider: "runway", model: "model-router", input: routerInput, reservedAmount: 4.5
  }));
  assert.equal(queued.jobId, resultRow.job_id);
  assert.equal(calls, 1);

  await assert.rejects(() => client.enqueue(args({
    provider: "runway", model: "model-router",
    input: { ...routerInput, operation: "audio-to-video" },
    reservedAmount: 4.5, idempotencyKey: "router-invalid-operation"
  })), error => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  assert.equal(calls, 1);

  const disabled = createCloudVideoEnqueue({
    ...base, env: { ...env, RUNWAY_MODEL_ROUTER_ENABLED: "false" },
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(
    disabled.enqueue(args({ provider: "runway", model: "model-router", input: routerInput, reservedAmount: 4.5 })),
    error => error.code === "RUNWAY_ROUTER_REMOTE_DISABLED"
  );
  assert.equal(calls, 1);
});

test("Runway Model Router rejects non-USD ceilings and invalid config slugs before queue submission", async () => {
  const routerInput = {
    projectId, provider: "runway", model: "model-router", requestHash,
    operation: "text-to-video", prompt: "A cinematic product launch", durationSeconds: 8
  };
  let calls = 0;
  const env = {
    RUNWAY_MODEL_ROUTER_ENABLED: "true", CLOUD_VIDEO_WORKER_ENABLED: "true", RUNWAY_VIDEO_ALLOW_REMOTE: "true",
    RUNWAY_VIDEO_ROUTER_CONFIG: "INVALID SLUG",
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true"
  };
  const client = createCloudVideoEnqueue({
    ...base, env, fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(
    client.enqueue(args({ model: "model-router", input: routerInput, reservedAmount: 4.5 })),
    error => error.code === "RUNWAY_ROUTER_REMOTE_DISABLED"
  );
  await assert.rejects(
    createCloudVideoEnqueue({
      ...base, env: { ...env, RUNWAY_VIDEO_ROUTER_CONFIG: "production-video" },
      fetchImpl: async () => { calls++; return response([resultRow]); }
    }).enqueue(args({ model: "model-router", input: routerInput, reservedAmount: 4.5, currency: "EUR" })),
    error => error.code === "RUNWAY_ROUTER_REMOTE_DISABLED"
  );
  assert.equal(calls, 0);
});

test("Runway Model Router video-to-video enqueue probes source metadata before durable queue submission", async () => {
  const sourceVideoAssetId = "a23e4567-e89b-42d3-a456-426614174000";
  let calls = 0;
  const env = {
    RUNWAY_MODEL_ROUTER_ENABLED: "true", CLOUD_VIDEO_WORKER_ENABLED: "true",
    RUNWAY_VIDEO_ALLOW_REMOTE: "true", RUNWAY_VIDEO_ROUTER_CONFIG: "production-video",
    VIDEO_GATEWAY_ENABLED: "true", VIDEO_GATEWAY_ALLOW_REMOTE: "true"
  };
  const metadata = {
    ownerId, projectId, assetId: sourceVideoAssetId,
    mediaType: "video/mp4", durationSeconds: 11.2, frameCount: 336
  };
  const client = createCloudVideoEnqueue({
    ...base, env,
    resolveRunwaySourceMetadata: async scope => {
      assert.deepEqual(scope, { ownerId, projectId, assetId: sourceVideoAssetId });
      return metadata;
    },
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  const routerInput = {
    projectId, provider: "runway", model: "model-router", requestHash,
    operation: "video-to-video", sourceVideoAssetId,
    prompt: "Replace the background while preserving subject motion",
    durationSeconds: 12, aspectRatio: "16:9"
  };
  const queued = await client.enqueue(args({ model: "model-router", input: routerInput, reservedAmount: 5 }));
  assert.equal(queued.jobId, resultRow.job_id);
  assert.equal(calls, 1);
  const invalid = createCloudVideoEnqueue({
    ...base, env,
    resolveRunwaySourceMetadata: async () => ({ ...metadata, durationSeconds: 12.1 }),
    fetchImpl: async () => { calls++; return response([resultRow]); }
  });
  await assert.rejects(
    invalid.enqueue(args({ model: "model-router", input: routerInput, reservedAmount: 5 })),
    error => error.code === "VIDEO_SOURCE_METADATA_MISMATCH"
  );
  assert.equal(calls, 1);
});



test("Aleph 2 enqueue is enabled only for the reviewed video-to-video MP4 contract",async()=>{
 const calls=[];
 const client=createCloudVideoEnqueue({...base,resolveRunwaySourceMetadata:async({ownerId,projectId,assetId})=>({ownerId,projectId,assetId,mediaType:"video/mp4",durationSeconds:8,frameCount:192,width:1920,height:1080}),fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return response([resultRow]);}});
 const alephInput={
  projectId,provider:"runway",model:"aleph2",requestHash,
  operation:"video-to-video",sourceVideoAssetId:"823e4567-e89b-42d3-a456-426614174000",
  durationSeconds:8,prompt:"Edit the source video while preserving its camera movement.",outputFormat:"mp4",resolution:"provider_default",audioMode:"provider_default"
 };
 const estimate=estimateVideoGenerationCost({provider:"runway",model:"aleph2",operation:"video-to-video",durationSeconds:8,inputVideoSeconds:8,inputType:"video",outputFormat:"mp4",resolution:"provider_default"});
 assert.equal(estimate.amount,2.24);
 const queued=await client.enqueue(args({model:"aleph2",input:alephInput,reservedAmount:3}));
 assert.equal(queued.jobId,resultRow.job_id);
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.p_model,"aleph2");
 assert.equal(calls[0].body.p_input.operation,"video-to-video");
 await assert.rejects(()=>client.enqueue(args({model:"aleph2",input:{...alephInput,operation:"text-to-video"},reservedAmount:3})),error=>error.code==="VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
 await assert.rejects(()=>client.enqueue(args({model:"aleph2",input:{...alephInput,outputFormat:"prores"},reservedAmount:3})),/supports MP4 outputs/);
 assert.equal(calls.length,1);
});
