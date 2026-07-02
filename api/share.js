const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_BODY_CHARS = 120000;

function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function kvConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(command) {
  const config = kvConfig();
  if (!config) {
    const error = new Error("Short share codes are not configured.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(data.error || `KV request failed with ${response.status}`);
    error.status = 502;
    throw error;
  }
  return data.result;
}

function randomCode() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizeRecord(record = {}) {
  return {
    id: String(record.id || "").slice(0, 80),
    type: String(record.type || "").slice(0, 40),
    title: String(record.title || "").slice(0, 160),
    place: String(record.place || "").slice(0, 160),
    state: String(record.state || "").slice(0, 80),
    date: String(record.date || "").slice(0, 40),
    lat: Number.isFinite(Number(record.lat)) ? Number(record.lat) : null,
    lon: Number.isFinite(Number(record.lon)) ? Number(record.lon) : null,
    summary: String(record.summary || "").slice(0, 600),
    tags: String(record.tags || "").slice(0, 240),
    visibility: "shared_snapshot",
  };
}

function sanitizePayload(payload = {}) {
  const records = Array.isArray(payload.records) ? payload.records.slice(0, 80).map(sanitizeRecord) : [];
  return {
    app: "Noted States",
    kind: "read-only-journal-snapshot",
    created_at: new Date().toISOString(),
    records: records.filter((record) => record.title || record.place || record.summary),
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_CHARS) {
      const error = new Error("Shared snapshot is too large.");
      error.status = 413;
      throw error;
    }
  }
  return body ? JSON.parse(body) : {};
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const payload = sanitizePayload(await readBody(req));
      if (!payload.records.length) return json(res, 400, { error: "No shareable records." });
      const deleteToken = randomToken();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomCode();
        const result = await redis(["SET", `share:${code}`, JSON.stringify(payload), "EX", TTL_SECONDS, "NX"]);
        if (result === "OK") {
          await redis(["SET", `share-delete:${code}`, deleteToken, "EX", TTL_SECONDS]);
          return json(res, 201, { code, delete_token: deleteToken, expires_in_days: 30 });
        }
      }
      return json(res, 503, { error: "Could not allocate a share code. Please try again." });
    }

    if (req.method === "GET") {
      const url = new URL(req.url, `https://${req.headers.host || "notedstates.vercel.app"}`);
      const code = url.searchParams.get("code") || "";
      if (!/^\d{8}$/.test(code)) return json(res, 400, { error: "Enter an 8-digit share code." });
      const raw = await redis(["GET", `share:${code}`]);
      if (!raw) return json(res, 404, { error: "Share code not found or expired." });
      return json(res, 200, JSON.parse(raw));
    }

    if (req.method === "DELETE") {
      const body = await readBody(req);
      const code = String(body.code || "");
      const token = String(body.delete_token || "");
      if (!/^\d{8}$/.test(code) || !token) return json(res, 400, { error: "Missing code or delete token." });
      const storedToken = await redis(["GET", `share-delete:${code}`]);
      if (!storedToken || storedToken !== token) return json(res, 403, { error: "Delete token did not match." });
      await redis(["DEL", `share:${code}`, `share-delete:${code}`]);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    return json(res, error.status || 500, { error: error.message || "Share service unavailable." });
  }
}
