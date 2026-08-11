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
    .sign(encoder.encode(onlyOfficeEnv().appJwtSecret));
}

export async function verifyUploadToken(token: string): Promise<UploadClaims> {
  const result = await jwtVerify(token, encoder.encode(onlyOfficeEnv().appJwtSecret), {
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
