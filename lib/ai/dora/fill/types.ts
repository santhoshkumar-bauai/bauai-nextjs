import type { ObjectId } from "mongodb";

export type DocumentFillFieldState =
  | "ready"
  | "needs_review"
  | "missing"
  | "manual"
  | "not_applicable";

/** Which engine fills a run. Absent on pre-PDF rows, which are all docx. */
export type DocumentFillFormat = "docx" | "pdf" | "gaeb";

/**
 * PDF COORDINATE CONTRACT — normative. Every producer and consumer obeys it.
 *
 *   page      0-based. Page 0 is the first page. Matches pdf-lib getPages()[i]
 *             and the editor's api.goToPage(idx). pdf.js getPage(n) is 1-BASED;
 *             convert once, at the pdfjs boundary in pdf/manifest.ts, and never
 *             again.
 *   units     PDF points (1/72 inch).
 *   space     UNROTATED PDF user space, origin BOTTOM-LEFT. Verified identical
 *             to pdf-lib page.drawText({x,y}) and to a widget /Rect.
 *   rect      {x,y} is the LOWER-LEFT corner. A widget /Rect [x1,y1,x2,y2]
 *             normalizes to {x:min(x1,x2), y:min(y1,y2), width:|x2-x1|, ...}.
 *   baseline  A text BASELINE, not a box bottom. Drawing at rect.y sits the
 *             text too low; drawing a box at baseline.y clips descenders.
 *
 * Y-AXIS FLIP TRAP — three spaces are in play and only two agree:
 *  (1) unpdf.extractTextItems() -> transform[4]/[5], no viewport, bottom-left.
 *      Agrees with pdf-lib to 0.00pt (probe P1.7b). USE THIS.
 *  (2) pdf.js page.getViewport({scale}) applies [1,0,0,-1,-x0,y1] and flips to
 *      TOP-LEFT. Analysis constructs a viewport ONLY to read width/height/
 *      rotation — never to transform a point.
 *  (3) The editor's AscPDF.GetGlobalCoordsByPageCoords takes ONLYOFFICE page
 *      space (top-left origin). Converting to it is the panel's job and lives
 *      in exactly one function, DoraPdfNav.toEditorPageCoords.
 */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DocumentFillLocator =
  | { strategy: "form_key"; nodeId: string; path: string; formKey: string }
  | {
      strategy: "unique_text";
      nodeId: string;
      path: string;
      searchText: string;
      occurrence: 1;
    }
  /** An interactive AcroForm field, addressed by its fully-qualified name. */
  | {
      strategy: "pdf_acroform";
      /** `af:<manifestIndex>` */
      nodeId: string;
      /** Page of the FIRST widget; a field may have widgets on several pages. */
      page: number;
      fieldName: string;
      fieldType: PdfFormFieldType;
      /**
       * >1 means ONE field with linked widgets — initials repeated on every
       * page. That is legitimate and shares a single value by design, so it is
       * never a rejection; it exists so the review UI can say "on 3 pages".
       */
      widgetCount: number;
      rect: PdfRect;
    }
  /**
   * Text drawn onto a page next to a unique label. All geometry here is
   * DERIVED from the manifest, never from the model — the model only names the
   * anchor. `anchorText` is re-verified at generation time exactly like
   * `unique_text` does for docx.
   */
  | {
      strategy: "pdf_overlay_text";
      /** `tl:<page>:<lineIndex>` */
      nodeId: string;
      page: number;
      anchorText: string;
      anchorOccurrence: 1;
      /** The writable span after the anchor; also the whiteout box. */
      rect: PdfRect;
      baseline: { x: number; y: number };
      fontSize: number;
      /** Cover `rect` before drawing. Decided in resolve-pdf, not at write time. */
      whiteout: boolean;
    }
  /**
   * Vision-derived geometry for scanned pages, where no text layer exists to
   * verify against. NOTHING checks the rect is empty, on-page, or clear of
   * existing ink — so this can never auto-reach `ready` and is never generated
   * without an explicit human decision. See locators.ts#canAutoApply.
   */
  | {
      strategy: "pdf_overlay_vision";
      /** `vis:<page>:<roundedX>:<roundedY>` */
      nodeId: string;
      page: number;
      rect: PdfRect;
      baseline: { x: number; y: number };
      fontSize: number;
      /** Nearest recognised text, for the review UI only. */
      nearestText: string;
    }
  /**
   * A GAEB X84 metadata slot (bidder block). Per-position unit prices are NOT
   * fill fields — they live in the price sheet and gaeb_fill_items; run.fields
   * carries only these few profile-groundable document-level values.
   */
  | {
      strategy: "gaeb_meta";
      /** `gm:<key>` */
      nodeId: string;
      /** XML target the X84 writer fills, e.g. "Award/CTR/Address/Name1". */
      path: string;
      key:
        | "bidder.name"
        | "bidder.street"
        | "bidder.zip"
        | "bidder.city"
        | "bidder.contact"
        | "bidder.email";
    };

export type PdfFormFieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "optionlist"
  | "button"
  | "signature";

/** How a PDF's fillable surface is shaped; picks the primary strategy. */
export type PdfDocumentClass = "acroform" | "digital" | "scanned";

/** Summary of the analysed PDF, carried on the run and out to the panel. */
export interface DocumentFillPdfSummary {
  documentClass: PdfDocumentClass;
  pageCount: number;
  pages: Array<{ width: number; height: number; rotation: number }>;
  /**
   * sha256 of the deterministic manifest — the PDF analogue of snapshotHash.
   * Generation re-derives it from the bytes it is about to fill and refuses on
   * mismatch, which is what makes overlay geometry safe.
   */
  manifestHash: string;
  acroFieldCount: number;
  textCharCount: number;
  /** True when the PDF bytes were sent to the model natively. */
  nativeVision: boolean;
}

export interface DocumentFillEvidence {
  source: "company_profile" | "company_document" | "tender" | "user" | "web";
  reference: string;
  excerpt: string;
}

export interface DocumentFillField {
  id: string;
  label: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  value: string | null;
  confidence: number;
  state: DocumentFillFieldState;
  locator: DocumentFillLocator | null;
  evidence: DocumentFillEvidence[];
  reason: string;
  updatedBy: "ai" | "user";
}

/**
 * Global tender conditions extracted once per GAEB run and attached to every
 * pricing batch — the model prices "steel pipe demolition in an occupied
 * school", not "steel pipe demolition" in a vacuum.
 */
export interface GaebTenderContext {
  projectType: string[];
  building: string | null;
  existingBuilding: boolean | null;
  occupiedDuringConstruction: boolean | null;
  region: string | null;
  siteConditions: string[];
  riskFactors: Array<{ factor: string; pricingImpact: "low" | "medium" | "high" }>;
  summary: string;
}

/** Progress + context for a GAEB run, carried on the run and out to the UI. */
export interface DocumentFillGaebSummary {
  phase: number;
  flavor: string;
  parserVersion: string;
  sourceItemCount: number;
  batchSize: number;
  batchCount: number;
  classifiedCount: number;
  pricedCount: number;
  failedCount: number;
  skippedCount: number;
  webLookupsDone: number;
  webLookupsTotal: number;
  /**
   * Persisted so a retry_failed pass reuses the evidence instead of paying
   * for the same searches again. Small by construction (lookup cap × ~200B).
   */
  webFindings?: Array<{
    product: string;
    unitPrice: number | null;
    unit: string;
    currency: string;
    sourceUrl: string;
    sourceTitle: string;
    note: string;
  }>;
  /** sha256 over the serialized context; generation refuses on drift. */
  contextHash: string | null;
  context: GaebTenderContext | null;
  warnings: string[];
}

export interface DocumentFillRunDocument {
  _id: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  /** Absent on rows written before PDF support; read via fillRunFormat(). */
  format?: DocumentFillFormat;
  sourceVersionId: ObjectId;
  sourceStorageRevision: number;
  sourceSha256: string;
  /**
   * Word runs pin a live editor snapshot. PDF analysis reads the committed S3
   * bytes instead, so both are null there — a "" sentinel would let a bug
   * compare two empty strings and pass, where null forces a branch. What a PDF
   * run pins is sourceSha256 (already enforced in generate.ts) plus
   * pdf.manifestHash.
   */
  snapshotId: string | null;
  snapshotHash: string | null;
  /** Present only on PDF runs. */
  pdf?: DocumentFillPdfSummary | null;
  /** Present only on GAEB runs. */
  gaeb?: DocumentFillGaebSummary | null;
  status:
    | "queued"
    | "analyzing"
    | "review"
    | "generating"
    | "completed"
    | "failed"
    | "cancelled";
  stage:
    | "queued"
    | "discovering"
    | "grounding"
    | "validating"
    | "review"
    | "building"
    | "storing"
    | "done";
  fields: DocumentFillField[];
  generatedDocumentId: ObjectId | null;
  error: string | null;
  startedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}
