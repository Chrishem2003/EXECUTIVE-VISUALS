import { randomBytes, timingSafeEqual } from "node:crypto";

export const CSRF_COOKIE_NAME = "ev_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

function cookieToken(header = "") {
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CSRF_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
  }
  return "";
}

export function requiresCsrf(method) {
  return !SAFE_METHODS.has(String(method || "").toUpperCase());
}

export function isValidCsrfRequest({ method, cookieHeader = "", headerToken = "" } = {}) {
  if (!requiresCsrf(method)) return true;
  const cookie = cookieToken(cookieHeader);
  if (!cookie || typeof headerToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(headerToken)) return false;
  const expected = Buffer.from(cookie, "utf8");
  const supplied = Buffer.from(headerToken, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
