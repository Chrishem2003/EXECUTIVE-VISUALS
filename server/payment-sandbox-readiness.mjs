const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function credential(value, name) {
  const result = String(value || "");
  if (result.length < 8 || result.length > 512 || /\s/.test(result)) {
    throw fail("PAYMENT_SANDBOX_CREDENTIAL_INVALID", name + " is missing or has an invalid shape.");
  }
  return result;
}

async function readBoundedText(response, label) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw fail("PAYMENT_SANDBOX_RESPONSE_TOO_LARGE", label + " response exceeded the 1 MiB limit.");
  }
  if (!response.body?.getReader) {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_PROVIDER_RESPONSE_BYTES) throw fail("PAYMENT_SANDBOX_RESPONSE_TOO_LARGE", label + " response exceeded the 1 MiB limit.");
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail("PAYMENT_SANDBOX_RESPONSE_TOO_LARGE", label + " response exceeded the 1 MiB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function requestJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  const raw = await readBoundedText(response, label);
  if (!response.ok) throw fail("PAYMENT_SANDBOX_REQUEST_FAILED", label + " authentication failed with HTTP " + response.status + ".");
  let data;
  try { data = JSON.parse(raw); }
  catch { throw fail("PAYMENT_SANDBOX_INVALID_JSON", label + " returned invalid JSON."); }
  return data;
}

export async function verifyPaymentSandboxCredentials({
  paddleApiKey = process.env.PADDLE_SANDBOX_API_KEY,
  pesapalConsumerKey = process.env.PESAPAL_SANDBOX_CONSUMER_KEY,
  pesapalConsumerSecret = process.env.PESAPAL_SANDBOX_CONSUMER_SECRET,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== "function") throw fail("PAYMENT_SANDBOX_FETCH_REQUIRED", "Sandbox credential verification requires fetch.");
  const paddleKey = credential(paddleApiKey, "PADDLE_SANDBOX_API_KEY");
  const pesapalKey = credential(pesapalConsumerKey, "PESAPAL_SANDBOX_CONSUMER_KEY");
  const pesapalSecret = credential(pesapalConsumerSecret, "PESAPAL_SANDBOX_CONSUMER_SECRET");
  if (!paddleKey.includes("_sdbx_") || paddleKey.includes("_live_")) {
    throw fail("PADDLE_SANDBOX_KEY_REQUIRED", "Paddle credential is not recognizably sandbox-scoped.");
  }

  const paddle = await requestJson(fetchImpl, "https://sandbox-api.paddle.com/event-types", {
    headers: { authorization: "Bearer " + paddleKey, accept: "application/json" }
  }, "Paddle sandbox");
  if (!Array.isArray(paddle?.data)) throw fail("PADDLE_SANDBOX_RESPONSE_INVALID", "Paddle sandbox event-types response is invalid.");

  const pesapal = await requestJson(fetchImpl, "https://cybqa.pesapal.com/pesapalv3/api/Auth/RequestToken", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ consumer_key: pesapalKey, consumer_secret: pesapalSecret })
  }, "Pesapal sandbox");
  if (typeof pesapal?.token !== "string" || pesapal.token.length < 20) {
    throw fail("PESAPAL_SANDBOX_RESPONSE_INVALID", "Pesapal sandbox did not return a valid access token.");
  }

  return {
    result: "sandbox_credentials_verified",
    paddle: { environment: "sandbox", eventTypes: paddle.data.length, authenticated: true },
    pesapal: { environment: "sandbox", tokenIssued: true }
  };
}
