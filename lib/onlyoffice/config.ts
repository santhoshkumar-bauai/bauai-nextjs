import type { Config } from "@onlyoffice/doceditor-types";

import type { CompanyContext } from "@/lib/company/context";
import { createDownloadUrl } from "@/lib/storage/s3";
import type { WorkspaceDocumentDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";
import type { HydratedDocument } from "mongoose";

import { onlyOfficeEnv } from "./env";
import { signOnlyOfficeConfig } from "./tokens";

export async function buildOnlyOfficeConfig(input: {
  document: HydratedDocument<WorkspaceDocumentDocument>;
  context: CompanyContext;
  locale: string;
}): Promise<Config> {
  const env = onlyOfficeEnv();
  const version = input.document.currentVersionId
    ? await WorkspaceDocumentVersion.findOne({
        _id: input.document.currentVersionId,
        documentId: input.document._id,
        state: "committed",
      }).lean()
    : null;
  if (!version) throw new Error("Document has no committed version");

  const source = await createDownloadUrl({
    key: version.s3Key,
    fileName: input.document.fileName,
    expiresIn: 60 * 60,
  });
  const companyId = String(input.context.company._id);
  const documentId = String(input.document._id);

  const unsigned = {
    type: "desktop",
    width: "100%",
    height: "100%",
    documentType: input.document.documentType,
    document: {
      title: input.document.fileName.slice(0, 128),
      url: source.downloadUrl,
      fileType: input.document.extension as NonNullable<Config["document"]>["fileType"],
      key: input.document.activeEditorKey,
      referenceData: { fileKey: documentId, instanceId: env.publicAppUrl },
      permissions: {
        chat: false,
        comment: true,
        copy: true,
        download: true,
        edit: true,
        fillForms: true,
        modifyContentControl: true,
        modifyFilter: true,
        print: true,
        review: true,
      },
    },
    editorConfig: {
      callbackUrl: `${env.callbackBaseUrl}/api/onlyoffice/callback/${documentId}`,
      lang: input.locale.toLowerCase().startsWith("de") ? "de" : "en",
      mode: "edit",
      user: {
        id: input.context.userId,
        name: input.context.name,
        group: companyId,
      },
      customization: {
        about: false,
        autosave: true,
        chat: false,
        comments: true,
        compactHeader: true,
        forcesave: true,
        help: false,
        spellcheck: true,
      },
    },
  } satisfies Config;

  const token = await signOnlyOfficeConfig(unsigned as unknown as Record<string, unknown>);
  return { ...unsigned, token } as Config;
}
