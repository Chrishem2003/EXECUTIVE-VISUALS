// Who counts as an administrator. Decided only on the server, from environment settings:
//   ADMIN_EMAILS                comma-separated list of administrator email addresses
//   AUTH_SECURITY_ADMIN_EMAILS  older name, still honoured so existing deployments keep working
// Nobody is an administrator unless their address is listed.

const split = value => String(value || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);

export function adminEmails(env = process.env) {
  return new Set([...split(env.ADMIN_EMAILS), ...split(env.AUTH_SECURITY_ADMIN_EMAILS)]);
}

export function isAdminUser(user, env = process.env) {
  const email = String(user?.email || "").trim().toLowerCase();
  return !!email && adminEmails(env).has(email);
}
