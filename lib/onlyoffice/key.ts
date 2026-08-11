const KEY_MAX_LENGTH = 128;

export function onlyOfficeDocumentKey(input: {
  documentId: string;
  editorRevision: number;
  environment?: string;
}): string {
  const environment = (input.environment ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "dev")
    .replace(/[^0-9A-Za-z._=-]/g, "-")
    .slice(0, 20);
  const documentId = input.documentId.replace(/[^0-9A-Za-z._=-]/g, "-");
  const revision = Math.max(1, Math.trunc(input.editorRevision));
  return `bau-${environment}-${documentId}-r${revision}`.slice(0, KEY_MAX_LENGTH);
}

export function isValidOnlyOfficeKey(key: string): boolean {
  return key.length > 0 && key.length <= KEY_MAX_LENGTH && /^[0-9A-Za-z._=-]+$/.test(key);
}

/** ONLYOFFICE final-save status 2 closes a session; force-save status 6 does not. */
export function editorRevisionAfterCallback(current: number, status: number): number {
  return status === 2 ? current + 1 : current;
}
