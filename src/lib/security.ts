const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
];

export function assertSafePublicUrl(value: string) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(`Blocked host: ${host}`);
  }

  if (PRIVATE_IPV4_RANGES.some((pattern) => pattern.test(host))) {
    throw new Error(`Private IP ranges are blocked: ${host}`);
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Internal domains are blocked: ${host}`);
  }
}
