import type { Config } from "@onlyoffice/doceditor-types";

import type { CompanyContext } from "@/lib/company/context";
import { createDownloadUrl } from "@/lib/storage/s3";
import type { WorkspaceDocumentDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";
import type { HydratedDocument } from "mongoose";

import { signDoraEditorGrant } from "@/lib/dora-gateway/tokens";

import { onlyOfficeEnv, onlyOfficeUiDev } from "./env";
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
  // GAEB opens in the BAU AI BOQ editor; the page never renders the
  // ONLYOFFICE client for it, so a config request here is a routing bug.
  if (input.document.documentType === "gaeb") {
    throw new Error("gaeb documents have no ONLYOFFICE editor config");
  }
  // Three-way. PDFs previously fell through to "document", which told the
  // panel it was running inside the Word editor — a different app, a different
  // API surface, and a different set of capabilities.
  const editorKind =
    input.document.documentType === "cell"
      ? "spreadsheet"
      : input.document.documentType === "pdf"
        ? "pdf"
        : "document";

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
      // For a PDF, api.js reads document.isForm to choose the app. Left
      // undefined it loads apps/common/index.html first — a sniffer page that
      // downloads the file's first bytes to detect an ONLYOFFICE form (oform)
      // and only then swaps in the real editor. If that round trip stalls, the
      // frame sits on the sniffer forever with no error. We already know what
      // this file is, and our PDFs are never ONLYOFFICE forms, so state it and
      // go straight to the PDF editor.
      ...(input.document.documentType === "pdf" ? { isForm: false } : {}),
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

  // The native Dora panel reads customization.dora from the signed config and
  // exchanges the grant at /api/dora-gateway/token (cookies don't cross the
  // editor origin). Embedded only when gateway origins are configured.
  const doraEnabled = Boolean(process.env.DORA_EDITOR_ORIGINS?.trim());
  const isPdf =
    input.document.documentType === "pdf" && input.document.extension === "pdf";
  // Upstream ONLYOFFICE hardcodes PDFs into view mode (pdfeditor Main.js:1346).
  // Our fork restores the real expression, gated on this flag, so a host that
  // does not set it keeps stock upstream behaviour.
  const pdfEditByDefault = isPdf && process.env.DORA_PDF_EDIT_BY_DEFAULT !== "false";
  const signable = doraEnabled
    ? {
        ...unsigned,
        editorConfig: {
          ...unsigned.editorConfig,
          customization: {
            ...unsigned.editorConfig.customization,
            dora: {
              gatewayOrigin: env.publicAppUrl,
              documentId,
              editorKey: input.document.activeEditorKey,
              editorKind,
              pdfEditByDefault,
              effectivePermissions: {
                read: true,
                edit: isPdf
                  ? pdfEditByDefault
                  : Boolean(unsigned.document.permissions.edit),
              },
              capabilities: {
                documentFill:
                  (input.document.documentType === "word" &&
                    input.document.extension === "docx") ||
                  (isPdf && process.env.DORA_PDF_FILL_ENABLED !== "false"),
                pdf: isPdf && process.env.DORA_PDF_ENABLED !== "false",
                pdfFieldNavigation:
                  isPdf && process.env.DORA_PDF_FIELD_NAV_ENABLED !== "false",
                spreadsheet: editorKind === "spreadsheet" &&
                  process.env.DORA_SPREADSHEET_ENABLED !== "false",
                spreadsheetWrites: editorKind === "spreadsheet" &&
                  process.env.DORA_SPREADSHEET_ENABLED !== "false" &&
                  process.env.DORA_SPREADSHEET_WRITES_ENABLED !== "false" &&
                  Boolean(unsigned.document.permissions.edit),
                developerConnector: process.env.DORA_SPREADSHEET_DEVELOPER_CONNECTOR === "true",
              },
              bridgePreference: process.env.DORA_SPREADSHEET_DEVELOPER_CONNECTOR === "true"
                ? "developer_connector"
                : "community_native",
              // V2 is the Word snapshot/range engine; it has no meaning in the
              // PDF editor, which exposes no such document model.
              editEngineV2: !isPdf && process.env.DORA_EDIT_ENGINE_V2 === "true",
              locale: unsigned.editorConfig.lang,
              grant: await signDoraEditorGrant({
                userId: input.context.userId,
                companyId,
                documentId,
                name: input.context.name,
                email: input.context.email,
              }),
            },
          },
        },
      }
    : unsigned;

  const token = await signOnlyOfficeConfig(
    signable as unknown as Record<string, unknown>,
    onlyOfficeUiDev()?.jwtSecret,
  );
  return { ...signable, token } as Config;
}
