function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for ONLYOFFICE.`);
  return value.replace(/\/$/, "");
}

export function onlyOfficeEnabled(): boolean {
  return process.env.ONLYOFFICE_ENABLED === "true";
}

export function onlyOfficeAiEnabled(): boolean {
  return onlyOfficeEnabled() && process.env.ONLYOFFICE_AI_ENABLED === "true";
}

export function onlyOfficeEnv() {
  return {
    publicUrl: required("NEXT_PUBLIC_DS_URL"),
    internalUrl: required("DS_INTERNAL_URL"),
    callbackBaseUrl: required("INTERNAL_APP_URL"),
    publicAppUrl: required("PUBLIC_APP_URL"),
    jwtSecret: required("OO_JWT_SECRET"),
    aiJwtSecret: required("OO_AI_JWT_SECRET"),
    storagePrefix: process.env.S3_WORKSPACE_DOCUMENT_PREFIX || "workspace-documents",
    pluginGuid: process.env.ONLYOFFICE_PLUGIN_GUID || "asc.{A6F63B3B-0B0D-4A44-8F54-BA0A10000001}",
  };
}
