/**
 * Declarative parameter specs. The same specs validate input on the server and
 * drive the form controls in the browser, so the two cannot drift apart.
 */

export const invalid = (message, code = "INVALID_STUDIO_INPUT", status = 400) => Object.assign(new Error(message), { status, code });

export function normalizeParams(specs, raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const spec of specs) {
    let value = source[spec.key];
    if (value === undefined || value === null || value === "") {
      if (spec.default !== undefined) value = spec.default;
      else if (spec.required) throw invalid(`${spec.label} is required.`);
      else continue;
    }
    if (spec.type === "select") {
      const match = spec.options.find(option => String(option) === String(value));
      if (match === undefined) throw invalid(`${spec.label} must be one of: ${spec.options.join(", ")}.`);
      value = match;
    } else if (spec.type === "range" || spec.type === "number") {
      value = Number(value);
      if (!Number.isFinite(value) || value < spec.min || value > spec.max) throw invalid(`${spec.label} must be between ${spec.min} and ${spec.max}.`);
      if (spec.integer && !Number.isInteger(value)) throw invalid(`${spec.label} must be a whole number.`);
    } else if (spec.type === "boolean") {
      value = value === true || value === "true";
    } else if (spec.type === "text") {
      value = String(value).trim();
      if (spec.required && !value) throw invalid(`${spec.label} is required.`);
      if (value.length > (spec.max || 2000)) throw invalid(`${spec.label} must be at most ${spec.max || 2000} characters.`);
      if (spec.pattern && value && !new RegExp(spec.pattern).test(value)) throw invalid(`${spec.label} has an unsupported format.`);
    } else {
      throw invalid("Unsupported parameter type.");
    }
    out[spec.key] = value;
  }
  return out;
}
