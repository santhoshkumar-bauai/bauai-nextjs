function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ONLYOFFICE.`);
  return value.replace(/\/$/, "");
}

export function onlyOfficeEnabled(): boolean {
  return process.env.ONLYOFFICE_ENABLED === "true";
}

/**
 * App-internal JWT secret (upload grants). Renamed from OO_AI_JWT_SECRET when
 * the editor AI plugin was removed; the legacy name is still honored so
 * existing deployments keep working without a config change.
 */
function appJwtSecret(): string {
  const value = (process.env.OO_APP_JWT_SECRET ?? process.env.OO_AI_JWT_SECRET)?.trim();
  if (!value) throw new Error("OO_APP_JWT_SECRET is required for ONLYOFFICE.");
  return value.replace(/\/$/, "");
}

/**
 * Opt-in switch pointing the document-filler at the :9000 UI-dev Document
 * Server (bauai-ONLYOFFICE/compose.ui-dev.yml) instead of the normal one.
 * The prod-ish server on :8080 is untouched when this is off (the default).
 */
export function onlyOfficeUiDev(): { url: string; jwtSecret: string } | null {
  if (process.env.ONLYOFFICE_UI_DEV !== "true") return null;
  const url = process.env.ONLYOFFICE_DEV_URL?.trim().replace(/\/$/, "");
  const jwtSecret = process.env.ONLYOFFICE_DEV_JWT_SECRET?.trim();
  if (!url || !jwtSecret) {
    throw new Error(
      "ONLYOFFICE_DEV_URL and ONLYOFFICE_DEV_JWT_SECRET are required when ONLYOFFICE_UI_DEV=true.",
    );
  }
  return { url, jwtSecret };
}

export function onlyOfficeEnv() {
  return {
    publicUrl: required("NEXT_PUBLIC_DS_URL"),
    internalUrl: required("DS_INTERNAL_URL"),
    callbackBaseUrl: required("INTERNAL_APP_URL"),
    publicAppUrl: required("PUBLIC_APP_URL"),
    jwtSecret: required("OO_JWT_SECRET"),
    appJwtSecret: appJwtSecret(),
    storagePrefix: process.env.S3_WORKSPACE_DOCUMENT_PREFIX || "workspace-documents",
  };
}
