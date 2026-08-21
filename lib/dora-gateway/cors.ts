/**
 * CORS for /api/dora-gateway/*: the ONLY app surface an editor origin (the
 * :9000 dev Document Server, later the production editor host) may call.
 * Origins are pinned via DORA_EDITOR_ORIGINS — never `*` — and cookies are
 * never involved (bearer auth), so no Access-Control-Allow-Credentials.
 */

function allowedOrigins(): string[] {
  return (process.env.DORA_EDITOR_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function corsHeadersFor(request: Request): Record<string, string> | null {
  const origin = request.headers.get("origin")?.replace(/\/$/, "");
  if (!origin || !allowedOrigins().includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** Standard OPTIONS handler for every gateway route. */
export function handlePreflight(request: Request): Response {
  const headers = corsHeadersFor(request);
  if (!headers) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers });
}

/** Re-wraps any Response (including SSE streams) with CORS headers applied. */
export function withCors(request: Request, response: Response): Response {
  const cors = corsHeadersFor(request);
  if (!cors) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
