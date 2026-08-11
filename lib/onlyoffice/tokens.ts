import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import { onlyOfficeEnv } from "./env";

const encoder = new TextEncoder();
const APP_ISSUER = "bau-ai";

type UploadClaims = JWTPayload & {
  kind: "workspace-upload";
  companyId: string;
  userId: string;
  key: string;
  fileName: string;
  contentType: string;
  size: number;
};

export async function signUploadToken(
  claims: Omit<UploadClaims, keyof JWTPayload | "kind">,
): Promise<string> {
  return new SignJWT({ ...claims, kind: "workspace-upload" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(APP_ISSUER)
    .setAudience("workspace-upload")
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(encoder.encode(onlyOfficeEnv().aiJwtSecret));
}

export async function verifyUploadToken(token: string): Promise<UploadClaims> {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().aiJwtSecret), {
    algorithms: ["HS256"],
    issuer: APP_ISSUER,
    audience: "workspace-upload",
  });
  if (result.payload.kind !== "workspace-upload") throw new Error("Invalid upload token");
  return result.payload as UploadClaims;
}

export async function signOnlyOfficeConfig(config: Record<string, unknown>): Promise<string> {
  return new SignJWT(config)
    .setProtectedHeader({ alg: "HS256" })
    .sign(encoder.encode(onlyOfficeEnv().jwtSecret));
}

export type EditorGrantClaims = JWTPayload & {
  kind: "editor-grant";
  companyId: string;
  userId: string;
  documentId: string;
};

export async function signEditorGrant(claims: {
  companyId: string;
  userId: string;
  documentId: string;
}): Promise<string> {
  return new SignJWT({ ...claims, kind: "editor-grant" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(APP_ISSUER)
    .setAudience("onlyoffice-plugin-exchange")
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(encoder.encode(onlyOfficeEnv().aiJwtSecret));
}

export async function verifyEditorGrant(token: string): Promise<EditorGrantClaims> {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().aiJwtSecret), {
    algorithms: ["HS256"],
    issuer: APP_ISSUER,
    audience: "onlyoffice-plugin-exchange",
  });
  if (result.payload.kind !== "editor-grant") throw new Error("Invalid editor grant");
  return result.payload as EditorGrantClaims;
}

export async function signAiAccessToken(claims: {
  companyId: string;
  userId: string;
  documentId: string;
}): Promise<string> {
  return new SignJWT({ ...claims, kind: "ai-access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(APP_ISSUER)
    .setAudience("onlyoffice-ai")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(encoder.encode(onlyOfficeEnv().aiJwtSecret));
}

export async function verifyAiAccessToken(token: string) {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().aiJwtSecret), {
    algorithms: ["HS256"],
    issuer: APP_ISSUER,
    audience: "onlyoffice-ai",
  });
  if (result.payload.kind !== "ai-access") throw new Error("Invalid AI token");
  return result.payload as JWTPayload & {
    kind: "ai-access";
    companyId: string;
    userId: string;
    documentId: string;
  };
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}
