import { verifyPaymentSandboxCredentials } from "../server/payment-sandbox-readiness.mjs";

const result = await verifyPaymentSandboxCredentials();
console.log(JSON.stringify(result));
