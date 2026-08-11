export const WORKSPACE_MAX_FILE_BYTES = 100_000_000;

export type WorkspaceFormat = {
  extension: "doc" | "docx" | "xls" | "xlsx" | "pdf";
  canonicalExtension: "docx" | "xlsx" | "pdf";
  contentType: string;
  documentType: "word" | "cell" | "pdf";
  requiresConversion: boolean;
};

const formats: Record<string, WorkspaceFormat> = {
  doc: {
    extension: "doc",
    canonicalExtension: "docx",
    contentType: "application/msword",
    documentType: "word",
    requiresConversion: true,
  },
  docx: {
    extension: "docx",
    canonicalExtension: "docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    documentType: "word",
    requiresConversion: false,
  },
  xls: {
    extension: "xls",
    canonicalExtension: "xlsx",
    contentType: "application/vnd.ms-excel",
    documentType: "cell",
    requiresConversion: true,
  },
  xlsx: {
    extension: "xlsx",
    canonicalExtension: "xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    documentType: "cell",
    requiresConversion: false,
  },
  pdf: {
    extension: "pdf",
    canonicalExtension: "pdf",
    contentType: "application/pdf",
    documentType: "pdf",
    requiresConversion: false,
  },
};

export const WORKSPACE_ACCEPT = ".doc,.docx,.xls,.xlsx,.pdf";

export function extensionFromFileName(fileName: string): string {
  const clean = fileName.trim().split(/[\\/]/).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function workspaceFormat(fileName: string): WorkspaceFormat | null {
  return formats[extensionFromFileName(fileName)] ?? null;
}

export function validateWorkspaceFile(input: {
  fileName: string;
  size: number;
}): { format: WorkspaceFormat } | { error: string } {
  const format = workspaceFormat(input.fileName);
  if (!format) return { error: "unsupported_file_type" };
  if (!Number.isFinite(input.size) || input.size <= 0) return { error: "empty_file" };
  if (input.size > WORKSPACE_MAX_FILE_BYTES) return { error: "file_too_large" };
  return { format };
}

export function fileNameWithExtension(fileName: string, extension: string): string {
  const current = extensionFromFileName(fileName);
  const stem = current ? fileName.slice(0, -(current.length + 1)) : fileName;
  return `${stem}.${extension}`;
}
