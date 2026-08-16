import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import { onlyOfficeEnv } from "@/lib/onlyoffice/env";

/**
 * Dora gateway tokens (editor panel ⇄ app across origins, cookies unusable):
 * a long-lived GRANT is embedded in the signed editor config by the config
 * route, and the panel exchanges it at /api/dora-gateway/token for a
 * short-lived BEARER used on every gateway call. Same HS256/`appJwtSecret`
 * pattern as the workspace-upload tokens (lib/onlyoffice/tokens.ts) — the
 * grant/bearer split mirrors the removed editor-plugin design (7eed0aa).
 */

const encoder = new TextEncoder();
const APP_ISSUER = "bau-ai";
const GRANT_AUDIENCE = "dora-editor-grant";
const BEARER_AUDIENCE = "dora-gateway";
export const DORA_BEARER_TTL_SECONDS = 15 * 60;

type DoraIdentity = {
  userId: string;
  companyId: string;
  documentId: string;
  /** Captured at grant time from the authenticated session (cosmetic only —
   * authorization is always re-checked against Mongo, never these fields). */
  name: string;
  email: string;
};

type DoraGrantClaims = JWTPayload & DoraIdentity & { kind: typeof GRANT_AUDIENCE };
type DoraBearerClaims = JWTPayload & DoraIdentity & { kind: typeof BEARER_AUDIENCE };

export async function signDoraEditorGrant(identity: DoraIdentity): Promise<string> {
  return new SignJWT({ ...identity, kind: GRANT_AUDIENCE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(APP_ISSUER)
    .setAudience(GRANT_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(encoder.encode(onlyOfficeEnv().appJwtSecret));
}

export async function verifyDoraEditorGrant(token: string): Promise<DoraGrantClaims> {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().appJwtSecret), {
    algorithms: ["HS256"],
    issuer: APP_ISSUER,
    audience: GRANT_AUDIENCE,
  });
  if (result.payload.kind !== GRANT_AUDIENCE) throw new Error("Invalid Dora grant");
  return result.payload as DoraGrantClaims;
}

export async function signDoraBearer(
  identity: DoraIdentity,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + DORA_BEARER_TTL_SECONDS;
  const token = await new SignJWT({ ...identity, kind: BEARER_AUDIENCE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(APP_ISSUER)
    .setAudience(BEARER_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(encoder.encode(onlyOfficeEnv().appJwtSecret));
  return { token, expiresAt };
}

export async function verifyDoraBearer(token: string): Promise<DoraBearerClaims> {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().appJwtSecret), {
    algorithms: ["HS256"],
    issuer: APP_ISSUER,
    audience: BEARER_AUDIENCE,
  });
  if (result.payload.kind !== BEARER_AUDIENCE) throw new Error("Invalid Dora bearer");
  return result.payload as DoraBearerClaims;
}

export function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}
