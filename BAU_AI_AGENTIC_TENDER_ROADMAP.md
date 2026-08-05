# BAU AI Agentic Tender Platform

## One-Month Implementation Roadmap and Engineering Specification

**Project:** BAU AI — Clara, Dora, and Nova  
**Roadmap start:** 5 August 2026  
**Pilot target:** 4 September 2026  
**Primary stack:** Next.js, MongoDB, Redis, BullMQ, S3, LangGraph.js, LangChain.js, Python document worker  
**Document status:** Implementation-ready roadmap  
**Audience:** Engineering, product, AI/ML, QA, DevOps, procurement-domain reviewers

---

## 1. Executive Summary

BAU AI already has the most important platform foundations:

- Next.js application and API layer
- Authentication
- Tenant isolation
- MongoDB
- Redis
- S3-compatible object storage
- Tender notice records

The next step is not to build one unrestricted “fully autonomous” agent. The correct architecture is a **deterministic tender-processing platform with three bounded agentic workflows**:

- **Clara** discovers and scores tenders.
- **Dora** analyses tender packages and produces citation-grounded findings and a bid/no-bid recommendation.
- **Nova** fills supported forms, assembles evidence, validates the bid package, and prepares it for human approval.

The one-month objective is a **production-pilot vertical slice**, not the complete twenty-week programme described by the two source knowledge bases. The pilot must process a real tender end to end:

```text
Existing tender record
→ acquire or upload tender documents
→ parse and OCR files
→ classify, chunk, and embed content
→ extract typed facts with citations
→ Dora creates a structured verdict
→ human reviews and approves
→ Nova fills selected supported forms
→ package validation
→ human approves and downloads the package
```

The pilot must not automatically submit a legally binding bid. Submission remains a human action.

---

## 2. Source Basis and Architectural Adaptation

This roadmap consolidates and adapts the following internal engineering documents:

1. `AGENT_KNOWLEDGE_BASE.md` — analysis pipeline, document ingestion, retrieval, structured extraction, LangGraph orchestration, evaluation, security, and review UI.
2. `PART2_DISCOVERY_AND_FORM_FILLING.md` — discovery, chat, company master data, form fingerprinting, field resolution, form writing, package validation, and submission controls.

The source documents proposed FastAPI and Celery as the application and queue layer. BAU AI already has Next.js, Redis, MongoDB, and S3. This roadmap therefore makes the following deliberate adaptation:

| Source proposal | BAU AI implementation | Reason |
|---|---|---|
| FastAPI public API | Existing Next.js Route Handlers / API | Avoid duplicate public backend and duplicate auth/tenancy logic |
| Celery + Redis | BullMQ + Redis | Native fit for the existing TypeScript stack |
| Python orchestration | LangGraph.js for Clara, Dora, Nova | Keeps product orchestration in the existing monorepo |
| Python parsing stack | Small private Python document worker | Docling, PaddleOCR, PyMuPDF, pikepdf, lxml, and GAEB tooling are Python-first |
| Separate vector database | Existing MongoDB search/vector capability | One source of truth; no document/vector synchronization layer |
| Direct provider SDKs | Central model gateway abstraction | Model provider must remain swappable |

The architectural principles from the source documents remain unchanged:

1. An uncited factual claim is a bug.
2. Parsing, extraction, and retrieval must be independently reliable before agent orchestration.
3. Agents perform judgment and coordination; deterministic services perform data processing.
4. Every submission-affecting workflow has a human approval gate.
5. No agent receives unrestricted database, filesystem, browser, or arbitrary code-execution access.

---

## 3. Current State

### 3.1 Existing capabilities

BAU AI already has:

- A working Next.js application
- Authentication and authenticated tenant context
- Tenant-isolated application data
- MongoDB persistence
- Redis
- S3 object storage
- Tender notice ingestion
- Tender records such as:

```json
{
  "canonicalKey": "proc:4d645a3d-2951-4394-bd25-4dbcff8150e4",
  "status": "OPEN",
  "title": "Verlängerung VMware Lizenzen 2026-2029",
  "language": "de",
  "cpvCodes": ["48218000"],
  "countries": ["DE"],
  "regions": ["DE11"],
  "procedureType": "open",
  "contractNature": "supplies",
  "submissionDeadline": "2026-08-27T08:00:00.000Z",
  "enrichment": {
    "geocoding": { "status": "PENDING" },
    "translation": { "status": "PENDING" },
    "embedding": { "status": "PENDING" }
  }
}
```

### 3.2 Missing capabilities

The current tender record is a useful notice aggregate, but the system does not yet have:

- Tender notice embeddings
- Document acquisition and archive extraction
- Parsed document representations
- Page/paragraph/bounding-box citations
- Document classification
- Section-aware chunks
- Hybrid keyword/vector retrieval
- Typed extraction schemas
- Citation verification
- Resumable agent runs
- Dora analysis
- Clara matching
- Company master data
- Form template fingerprinting
- Nova field resolution and package assembly
- Human review and approval screens
- Evaluation and regression gates

---

## 4. Product Goal

The platform must answer three connected business questions.

### 4.1 Clara — “Which tenders should this company pursue?”

Clara monitors or searches available tender notices, applies hard business filters, performs semantic matching against the company capability profile, and generates a structured fit assessment.

### 4.2 Dora — “What does this tender require, what are the risks, and should we bid?”

Dora consumes the full tender package and produces:

- Deadlines
- Eligibility and suitability requirements
- Required evidence
- Award criteria
- Contract penalties
- Payment and contractual risks
- Missing or unresolved information
- Bid/no-bid/conditional recommendation
- Citations for every factual conclusion

### 4.3 Nova — “Can we prepare a complete and valid bid package?”

Nova uses:

- Dora’s approved extractions
- Versioned company master data
- Verified form templates
- Deterministic field resolvers
- Evidence documents

Nova fills supported forms, validates the package, and presents it for human approval.

---

## 5. One-Month Scope

### 5.1 In scope for the 4 September 2026 pilot

#### Foundation

- Existing Next.js application remains the public control plane.
- Existing auth and tenant isolation are reused.
- BullMQ workers run long-running jobs.
- A private Python document worker handles document formats.
- MongoDB remains the system of record.
- S3 stores immutable source documents and generated artefacts.

#### Document ingestion

- Manual document upload
- Direct downloadable document URL
- ZIP, 7z, TAR, GZ, and RAR extraction where supported
- Nested archives
- SHA-256 deduplication
- Path traversal protection
- File-count and uncompressed-size limits
- Corrupt-file warnings without failing the entire package

#### Parsing

- Native PDFs
- Scanned PDFs with OCR fallback
- DOCX
- XLSX
- Images
- AcroForm field inventory
- PDF page rendering for the review UI
- Page, paragraph, and bounding-box anchors

#### Retrieval and extraction

- Tender notice embedding
- Section-aware document chunks
- German full-text retrieval
- Vector retrieval
- Hybrid fusion
- Cross-encoder reranking
- Six initial extraction schemas
- Citation verification

#### Dora

- Resumable LangGraph.js workflow
- Structured verdict
- Human approve/amend/reject gate
- Audit history
- Review UI with source highlights

#### Chat

- Tender-scoped chat
- Structured-data-first answers
- Retrieval fallback
- Citation chips linked to the document viewer

#### Clara

- Matching over existing tender records
- CPV hierarchy expansion
- Region, procedure, deadline, and contract-type filters
- Company-profile embedding
- Structured fit scoring
- Human pursue/review/skip feedback

#### Nova

- Versioned company master data
- Three verified form templates
- AcroForm, DOCX, and XLSX output paths
- Deterministic field resolution
- Package assembly
- Blocking validation gates
- Human approval
- Downloadable package

### 5.2 Explicitly out of scope for the one-month pilot

- Automatic bid submission
- Production XVergabe submission integration
- Universal portal scraping
- Universal browser form automation
- Dynamic XFA form support across arbitrary forms
- Qualified electronic signature execution
- Full GAEB DA84 generation
- Universal GAEB legacy format support
- Every VHB/HVA/EFB form
- Fully autonomous financial pricing decisions
- Model fine-tuning
- Automated legal sign-off

These remain Phase 2 and Phase 3 work.

---

## 6. Non-Negotiable Product Rules

### 6.1 Citation grounding

Every extracted or reasoned factual value must carry provenance:

```typescript
export interface Citation {
  documentId: string;
  page: number;
  paragraph: number;
  bbox?: [number, number, number, number];
  quote: string;
  quoteHash: string;
}
```

A claim without a verified citation must be:

- marked unresolved,
- shown as unverified,
- or blocked from use in a final verdict or generated form.

### 6.2 Human approval

The following actions always require an authenticated named human:

- Approving a Dora verdict
- Accepting low-confidence extractions
- Verifying a new form template mapping
- Approving Nova’s completed package
- Signing documents
- Submitting a bid

### 6.3 Tenant isolation

Every persisted object must include `tenantId` unless it is intentionally global reference data.

Every repository query must inject tenant scope server-side.

The frontend, LLM, tool argument, and user prompt must never be trusted to supply tenant scope.

### 6.4 Immutable originals

Raw tender files are immutable. A parser update creates a new derived version; it never overwrites the source object.

### 6.5 No unrestricted agents

Agents may call only narrow, typed, tenant-safe tools. They may not receive:

- generic MongoDB access,
- generic SQL-like query execution,
- arbitrary URLs,
- arbitrary filesystem paths,
- shell access,
- arbitrary code execution,
- or a tool that accepts an uncontrolled `tenantId`.

---

## 7. Target Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Existing Next.js Application                                         │
│                                                                       │
│ UI • Auth • Tenant Context • API Routes • Review • Chat • Approval    │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
                     enqueue / query / resume
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Redis + BullMQ                                                        │
│                                                                       │
│ acquisition • parsing • embedding • extraction • analysis             │
│ preparation • validation • notifications                              │
└───────────────────┬───────────────────────────────┬───────────────────┘
                    │                               │
                    ▼                               ▼
┌──────────────────────────────┐     ┌──────────────────────────────────┐
│ TypeScript Agent Workers     │     │ Private Python Document Worker   │
│                              │     │                                  │
│ LangGraph.js                 │     │ Docling                          │
│ LangChain.js                 │     │ PaddleOCR                        │
│ Clara / Dora / Nova          │     │ PyMuPDF / pdfplumber             │
│ Structured LLM responses     │     │ pikepdf / lxml                   │
│ Retrieval and validation     │     │ openpyxl / python-docx           │
└───────────────┬──────────────┘     │ archive and GAEB adapters        │
                │                    └──────────────────┬───────────────┘
                └───────────────────────┬───────────────┘
                                        │
                     ┌──────────────────┴──────────────────┐
                     ▼                                     ▼
        ┌──────────────────────────┐          ┌─────────────────────────┐
        │ MongoDB                  │          │ S3                      │
        │                          │          │                         │
        │ notices, documents,      │          │ raw, parsed, pages,     │
        │ chunks, vectors,         │          │ generated forms,        │
        │ extractions, verdicts,   │          │ packages, receipts      │
        │ runs, master data, audit │          │                         │
        └──────────────────────────┘          └─────────────────────────┘
```

---

## 8. Component Responsibilities

### 8.1 Next.js control plane

Next.js owns:

- Public API routes
- Session validation
- Tenant resolution
- Tender access control
- Presigned upload creation
- Job creation
- Agent-run status
- SSE or polling endpoints
- Review and approval mutations
- Chat streaming
- Company master-data UI
- Citation viewer
- Package download
- Audit display

Next.js must not perform long OCR, embedding, or multi-document analysis inside a request lifecycle.

### 8.2 TypeScript worker

The TypeScript worker owns:

- LangGraph.js graphs
- Agent state and checkpointing
- Tool definitions
- LLM gateway calls
- Structured outputs
- Hybrid retrieval coordination
- Citation-verification coordination
- Human interrupts and resumes
- Clara matching
- Dora reasoning
- Nova orchestration
- Agent event publication

### 8.3 Python document worker

The Python worker owns:

- MIME and magic-byte routing
- Archive extraction
- PDF parsing
- OCR
- Page rendering
- DOCX parsing and writing
- XLSX parsing and writing
- AcroForm inspection and writing
- XFA extraction and future writing experiments
- GAEB format detection and future parsing/writing
- Exact bounding-box extraction
- Emitting the common `DocumentIR`

It is not a public backend and should not contain user authentication logic.

### 8.4 MongoDB

MongoDB stores:

- Tender aggregates
- Tender search documents
- Documents
- Parsed structures
- Chunks and embeddings
- Extractions
- Citations
- Verdicts
- Agent runs and checkpoints
- Chat threads and messages
- Company master-data versions
- Form templates
- Filled forms
- Bid packages
- Golden-set labels
- Evaluation runs
- Audit events

### 8.5 S3

S3 stores:

```text
s3://bau-ai/
├── raw/{tenantId}/{tenderId}/{sha256}.{ext}
├── parsed/{tenantId}/{tenderId}/{documentId}/{parserVersion}.json
├── markdown/{tenantId}/{tenderId}/{documentId}/{parserVersion}.md
├── pages/{tenantId}/{tenderId}/{documentId}/p-{page}.png
├── forms/{tenantId}/{tenderId}/{filledFormId}/{filename}
├── packages/{tenantId}/{tenderId}/{packageId}/{filename}
└── receipts/{tenantId}/{tenderId}/{submissionId}/{filename}
```

Only `raw/` is immutable. Derived artefacts are versioned and reproducible.

---

## 9. Monorepo Structure

```text
bau-ai/
├── apps/
│   └── web/
│       ├── app/
│       │   ├── api/
│       │   │   ├── tenders/
│       │   │   ├── documents/
│       │   │   ├── agent-runs/
│       │   │   ├── chat/
│       │   │   ├── company-master/
│       │   │   ├── form-templates/
│       │   │   └── bid-packages/
│       │   └── dashboard/
│       └── src/
│           ├── auth/
│           ├── db/
│           ├── s3/
│           ├── queues/
│           ├── repositories/
│           └── services/
│
├── workers/
│   ├── agents/
│   │   ├── src/
│   │   │   ├── graphs/
│   │   │   │   ├── clara/
│   │   │   │   ├── dora/
│   │   │   │   └── nova/
│   │   │   ├── tools/
│   │   │   ├── retrieval/
│   │   │   ├── extraction/
│   │   │   ├── validation/
│   │   │   ├── models/
│   │   │   ├── checkpoints/
│   │   │   └── queues/
│   │   └── package.json
│   │
│   └── documents/
│       ├── src/
│       │   ├── worker.py
│       │   ├── parsers/
│       │   ├── ocr/
│       │   ├── archives/
│       │   ├── forms/
│       │   ├── gaeb/
│       │   ├── storage/
│       │   └── contracts/
│       ├── tests/
│       └── pyproject.toml
│
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── tenant-context/
│   ├── queues/
│   ├── ai-schemas/
│   ├── observability/
│   └── ui/
│
├── evals/
│   ├── golden-set/
│   ├── classification/
│   ├── parsing/
│   ├── retrieval/
│   ├── extraction/
│   ├── verdict/
│   └── prompts/
│
└── infra/
    ├── docker-compose.yml
    ├── agent-worker.Dockerfile
    ├── document-worker.Dockerfile
    └── deployment/
```

---

## 10. Queue Design

### 10.1 Queues

```typescript
export const AI_QUEUES = {
  acquisition: "ai-acquisition",
  parsing: "ai-parsing",
  classification: "ai-classification",
  embedding: "ai-embedding",
  extraction: "ai-extraction",
  analysis: "ai-analysis",
  preparation: "ai-preparation",
  validation: "ai-validation",
  maintenance: "ai-maintenance",
} as const;
```

### 10.2 Common job contract

```typescript
export interface BaseAIJob {
  tenantId: string;
  actorId: string;
  runId: string;
  tenderId?: string;
  documentId?: string;
  packageId?: string;
  schemaVersion: number;
  attempt: number;
  correlationId: string;
}
```

The queue producer must derive `tenantId` and `actorId` from authenticated server context.

### 10.3 Idempotency

Every job must have a deterministic idempotency key:

```text
{jobType}:{tenantId}:{resourceId}:{processingVersion}
```

Examples:

```text
parse:tenant123:document456:docling-v1
embed:tenant123:chunk789:bge-m3-2026-08
extract:tenant123:document456:Eignungskriterien-v1
```

Workers must safely return an existing successful result when the same idempotency key is replayed.

### 10.4 Retry policy

| Failure | Retry | Action |
|---|---:|---|
| Temporary S3 or MongoDB error | 3–5 | Exponential backoff |
| LLM rate limit | 3 | Provider fallback or delayed retry |
| OCR process crash | 2 | Retry in isolated process |
| Corrupt input file | 0 | Mark document partial/failed, continue package |
| Citation verification failure | 2 | Re-extract only failed fields |
| Unsupported format | 0 | Flag for human and record format |
| Validation failure | 0 | Blocking business issue, not a technical retry |

---

## 11. API Surface

### 11.1 Tender processing

```text
POST   /api/tenders/:tenderId/documents/upload-url
POST   /api/tenders/:tenderId/documents/complete-upload
POST   /api/tenders/:tenderId/acquire
POST   /api/tenders/:tenderId/analyse
GET    /api/tenders/:tenderId/analysis
GET    /api/tenders/:tenderId/extractions
GET    /api/tenders/:tenderId/verdict
```

### 11.2 Agent runs

```text
GET    /api/agent-runs/:runId
GET    /api/agent-runs/:runId/events
POST   /api/agent-runs/:runId/resume
POST   /api/agent-runs/:runId/cancel
```

### 11.3 Review

```text
POST   /api/tenders/:tenderId/verdict/approve
POST   /api/tenders/:tenderId/verdict/amend
POST   /api/tenders/:tenderId/verdict/reject
POST   /api/extractions/:extractionId/fields/:fieldPath/correct
```

### 11.4 Chat

```text
POST   /api/chat/threads
GET    /api/chat/threads/:threadId
POST   /api/chat/threads/:threadId/messages
GET    /api/chat/threads/:threadId/events
```

### 11.5 Company master data

```text
GET    /api/company-master/current
POST   /api/company-master/versions
GET    /api/company-master/versions/:version
POST   /api/company-master/evidence/upload-url
GET    /api/company-master/expiry-report
```

### 11.6 Nova

```text
POST   /api/tenders/:tenderId/prepare-bid
GET    /api/tenders/:tenderId/forms
POST   /api/form-templates/:templateId/verify
POST   /api/filled-forms/:formId/fields/:fieldId/resolve
GET    /api/bid-packages/:packageId
POST   /api/bid-packages/:packageId/validate
POST   /api/bid-packages/:packageId/approve
GET    /api/bid-packages/:packageId/download
```

---

## 12. Data Model

All tenant-owned collections include:

```typescript
interface TenantOwned {
  tenantId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
```

### 12.1 Existing `tenders` additions

Do not put raw chunks, full documents, extraction results, or agent state inside the tender record.

Add an AI status summary:

```javascript
{
  tenantId: ObjectId,

  ai: {
    noticeIndexStatus: "PENDING",          // PENDING|PROCESSING|READY|FAILED
    documentAcquisitionStatus: "NOT_STARTED",
    documentProcessingStatus: "NOT_STARTED",
    analysisStatus: "NOT_STARTED",
    preparationStatus: "NOT_STARTED",

    latestAnalysisRunId: null,
    latestVerdictId: null,
    latestBidPackageId: null,

    lastErrorCode: null,
    lastErrorAt: null
  },

  processingVersion: 1
}
```

### 12.2 `tender_search_documents`

The notice embedding must use a curated text representation rather than serialising the entire MongoDB record.

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,

  text: "Title: ...\nDescription: ...\nLots: ...\nBuyer: ...\nCPV: ...",

  filters: {
    status: "OPEN",
    cpvCodes: ["48218000"],
    countryCodes: ["DE"],
    regionCodes: ["DE11"],
    procedureType: "open",
    contractNature: "supplies",
    estimatedValue: null,
    submissionDeadline: ISODate()
  },

  embedding: [],
  embeddingModel: "bge-m3",
  embeddingVersion: "2026-08",
  sourceHash: "sha256:...",
  indexedAt: ISODate()
}
```

### 12.3 `documents`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,

  filename: "Bewerbungsbedingungen.pdf",
  mimeType: "application/pdf",
  detectedMimeType: "application/pdf",
  extension: ".pdf",
  sha256: "...",
  byteSize: 1048576,
  blobKey: "raw/...",

  source: {
    kind: "upload",                       // upload|portal|direct_url|email
    url: null,
    portal: null,
    acquiredAt: ISODate()
  },

  acquisition: {
    status: "READY",                      // PENDING|READY|PARTIAL|FAILED
    warnings: []
  },

  parsing: {
    status: "READY",
    parser: "docling",
    parserVersion: "...",
    ocrUsed: false,
    pageCount: 24,
    parseQuality: 0.97,
    warnings: []
  },

  classification: {
    docClass: "bewerbungsbedingungen",
    confidence: 0.94,
    modelVersion: "doc-classifier-v1"
  },

  parsedObjectKey: "parsed/...",
  markdownObjectKey: "markdown/...",
  pageImagePrefix: "pages/...",

  createdAt: ISODate(),
  updatedAt: ISODate()
}
```

A SHA-256 unique index should be scoped appropriately. The same file can appear across different tenants. Use a compound uniqueness rule such as:

```javascript
db.documents.createIndex(
  { tenantId: 1, tenderId: 1, sha256: 1 },
  { unique: true }
)
```

### 12.4 `chunks`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,
  documentId: ObjectId,

  docClass: "bewerbungsbedingungen",
  sectionPath: ["3. Eignung", "3.2 Technische Leistungsfähigkeit"],

  text: "Der Bieter hat mindestens drei Referenzen ...",
  textNormalised: "...",
  legalRefs: ["§ 13 VOB/B", "§ 122 GWB"],

  anchor: {
    page: 7,
    paragraph: 12,
    bbox: [72.0, 310.5, 523.0, 388.2],
    charStart: 14203,
    charEnd: 14710
  },

  embedding: [],
  embeddingModel: "bge-m3",
  embeddingVersion: "2026-08",
  tokenCount: 187,

  createdAt: ISODate()
}
```

### 12.5 `extractions`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,
  documentId: ObjectId,

  schemaName: "Eignungskriterien",
  schemaVersion: 1,

  model: {
    gatewayModel: "extraction",
    provider: "...",
    providerModel: "...",
    temperature: 0,
    promptVersion: "..."
  },

  fields: {
    referenzenMinCount: {
      value: 3,
      confidence: 0.91,
      citations: [],
      citationState: "VERIFIED"
    }
  },

  unresolved: [],
  status: "VERIFIED",
  traceId: "...",
  extractedAt: ISODate()
}
```

### 12.6 `verdicts`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,
  agentRunId: ObjectId,

  recommendation: "conditional",          // bid|no_bid|conditional
  rationale: "...",

  scoreBreakdown: {
    eligibilityFit: 0.8,
    strategicFit: 0.9,
    capacityFit: 0.7,
    contractRisk: 0.5,
    deadlineFeasibility: 0.8
  },

  risks: [],
  blockingRequirements: [],
  unresolvedQuestions: [],

  review: {
    state: "PENDING",                     // PENDING|APPROVED|AMENDED|REJECTED
    reviewerId: null,
    reviewedAt: null,
    edits: []
  },

  createdAt: ISODate(),
  updatedAt: ISODate()
}
```

### 12.7 `agent_runs`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,
  actorId: ObjectId,

  agent: "dora",                          // clara|dora|nova|chat
  state: "RUNNING",                       // QUEUED|RUNNING|WAITING_HUMAN|DONE|FAILED|CANCELLED
  currentNode: "verifyCitations",
  progress: 62,

  inputVersion: 1,
  graphVersion: "dora-v1",
  checkpointKey: "...",

  startedAt: ISODate(),
  finishedAt: null,
  heartbeatAt: ISODate(),

  metrics: {
    llmCalls: 7,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0
  },

  errors: [],
  createdAt: ISODate(),
  updatedAt: ISODate()
}
```

### 12.8 `company_master_versions`

Company master data must be append-only and versioned. Never mutate historical bid data by updating the current profile in place.

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  companyId: ObjectId,
  version: 7,
  validFrom: ISODate(),
  status: "ACTIVE",

  identity: {
    legalName: "...",
    legalForm: "...",
    handelsregister: { court: "...", number: "..." },
    ustId: "...",
    taxNumberEncrypted: "...",
    foundingYear: 1987
  },

  addresses: {},
  contacts: {},
  bankingEncrypted: {},
  financials: {},
  insurance: {},
  certifications: [],
  references: [],
  personnel: [],
  equipment: [],
  declarations: {},

  review: {
    lastReviewedAt: ISODate(),
    nextReviewAt: ISODate(),
    reviewedBy: ObjectId()
  },

  createdAt: ISODate(),
  createdBy: ObjectId()
}
```

Every evidence-bearing field should link to a source document and validity period.

### 12.9 `form_templates`

```javascript
{
  _id: ObjectId,
  tenantId: null,                          // null for globally verified template
  fingerprint: "sha256:...",
  formNumber: "124",
  formFamily: "VHB_Bund",
  version: "2019",
  title: "Eigenerklärung zur Eignung",
  format: "acroform_pdf",
  pageCount: 3,

  fields: [{
    fieldId: "technical-field-name",
    label: "Umsatz im Geschäftsjahr 2025",
    fieldType: "currency",
    page: 1,
    bbox: [],
    required: true,

    resolver: {
      kind: "master_data",
      path: "financials.revenueByYear.2025",
      transform: "format_eur_de"
    },

    verifiedBy: ObjectId(),
    verifiedAt: ISODate()
  }],

  usageCount: 0,
  createdAt: ISODate(),
  updatedAt: ISODate()
}
```

### 12.10 `bid_packages`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  tenderId: ObjectId,
  companyMasterVersionId: ObjectId,

  forms: [],
  attachments: [],
  lvResponse: null,
  coverLetter: null,

  completeness: {
    state: "FAILED",
    blockingIssues: [],
    warnings: []
  },

  state: "DRAFT",                         // DRAFT|REVIEW|APPROVED|EXPORTED|SUBMITTED
  approvedBy: null,
  approvedAt: null,

  createdAt: ISODate(),
  updatedAt: ISODate()
}
```

### 12.11 `audit_log`

```javascript
{
  _id: ObjectId,
  tenantId: ObjectId,
  actorId: ObjectId,
  actorType: "USER",                      // USER|SYSTEM|AGENT
  action: "VERDICT_APPROVED",
  resourceType: "verdict",
  resourceId: ObjectId,
  beforeHash: "...",
  afterHash: "...",
  metadata: {},
  createdAt: ISODate()
}
```

Audit entries are append-only.

---

## 13. DocumentIR Contract

Every parser must emit the same intermediate representation.

```python
from typing import Literal
from pydantic import BaseModel

class Anchor(BaseModel):
    page: int
    paragraph: int
    bbox: tuple[float, float, float, float] | None
    char_start: int
    char_end: int

class Block(BaseModel):
    kind: Literal["heading", "paragraph", "table", "list", "form_field"]
    level: int | None = None
    text: str
    table: list[list[str]] | None = None
    anchor: Anchor

class DocumentIR(BaseModel):
    document_id: str
    parser_name: str
    parser_version: str
    doc_class: str | None = None
    blocks: list[Block]
    parse_warnings: list[str]
```

This contract is the seam between the Python document stack and the TypeScript application. Parsers can change without changing extraction, retrieval, chat, or agents.

---

## 14. Document Acquisition and Archive Handling

### 14.1 Source order

Use sources in this order:

1. Existing uploaded package
2. Official downloadable URL
3. Official API or platform-native interface
4. XVergabe where implemented
5. Portal-specific adapter
6. Playwright as last resort

For the first month, manual upload is a supported product path, not a temporary internal workaround.

### 14.2 Archive controls

```python
SUPPORTED = {".zip", ".7z", ".rar", ".tar", ".gz", ".tgz"}
MAX_DEPTH = 5
MAX_TOTAL_BYTES = 5 * 1024**3
MAX_FILE_COUNT = 5000
```

Required protections:

- Reject path traversal
- Cap nested depth
- Cap total uncompressed bytes
- Cap total extracted files
- Detect duplicate content by SHA-256
- Preserve and repair German filename encodings
- Continue when a single entry is corrupt
- Flag encrypted archives for password input
- Log every extracted path

### 14.3 External references

Tender documents often refer to forms or regulations that are not attached.

The resolution strategy is:

```text
reference detected
→ local versioned standard-forms corpus lookup
→ allowlisted official-domain fetch on miss
→ ingest and cache
→ human flag if unresolved
```

Never give the agent unrestricted web browsing.

---

## 15. Parsing and Classification

### 15.1 Parser router

| Input | Primary path | Fallback |
|---|---|---|
| Native PDF | Docling | Marker/PyMuPDF |
| Scanned PDF | Docling + PaddleOCR | Tesseract/Surya |
| DOCX/PPTX | Docling | python-docx/python-pptx |
| XLSX | openpyxl | pandas |
| Images | PaddleOCR + metadata | alternate OCR |
| AcroForm | pypdf/PyMuPDF | overlay path |
| XFA PDF | pikepdf + lxml | flatten/overlay fallback |
| GAEB XML | lxml + custom mapper | human fallback |
| Legacy GAEB | custom parser | unsupported in pilot unless selected |

### 15.2 Native versus scanned PDF detection

Use text-layer coverage and character density. If usable text covers less than a configured percentage of the page, schedule OCR.

### 15.3 Initial document classes

- tender_notice
- bewerbungsbedingungen
- vertragsbedingungen
- leistungsverzeichnis
- preisblatt
- eignungsnachweis_form
- zuschlagsmatrix
- fristen_terminplan
- technische_spezifikation
- formblatt
- anlage
- unknown

### 15.4 Classification approach

Use a staged classifier:

1. Filename and extension heuristics
2. Form number or title detection
3. Lightweight model classification where heuristics are uncertain
4. Human correction path

Classification corrections must feed evaluation data.

---

## 16. Chunking

### 16.1 Rules

- Chunk by semantic section.
- Target 300–800 tokens.
- Hard cap 1,200 tokens.
- Do not split a table mid-row.
- Repeat headers when a table is split into row groups.
- Carry section headings into embedded text.
- Carry page, paragraph, bbox, and character offsets.
- Use one-sentence overlap rather than arbitrary token overlap.
- Extract legal references into a dedicated field.

### 16.2 Legal reference detection

```python
LEGAL_REF = re.compile(
    r"§+\s*\d+[a-z]?\s*(?:Abs\.?\s*\d+)?\s*(?:Nr\.?\s*\d+)?\s*"
    r"(VOB/[AB]|VgV|GWB|UVgO|HOAI|BGB|VwVfG)"
)
```

Legal references must also be indexed as exact keywords because semantic embeddings may not distinguish `§ 13` from `§ 14` reliably.

---

## 17. Embeddings and Retrieval

### 17.1 Embedding model

Initial model:

- `bge-m3`

Fallback:

- `multilingual-e5-large`

Store both model name and embedding version on every vector.

### 17.2 What gets embedded

- Tender notice search document
- Document chunks
- Company capability profile
- Company references
- Standard-form corpus chunks

Do not embed raw unfiltered MongoDB JSON.

### 17.3 Retrieval pipeline

```text
query
→ legal-reference detection
→ query embedding
→ MongoDB keyword search
→ MongoDB vector search
→ reciprocal-rank or native rank fusion
→ top 40 candidates
→ bge-reranker-v2-m3
→ top 8–12 chunks
```

### 17.4 Required filters

Every search must support:

- `tenantId`
- `tenderId`
- `documentId`
- `docClass`
- `language`
- `legalRefs`

### 17.5 Retrieval test cases

At minimum:

- “What is the submission deadline?”
- “Which references are required?”
- “What insurance coverage is required?”
- “Are alternative bids allowed?”
- “What contractual penalties apply?”
- “What does § 13 VOB/B say in this package?”
- “Which required documents are missing?”

---

## 18. Structured Extraction

### 18.1 Initial schemas

The pilot implements:

1. `Fristen`
2. `Eignungskriterien`
3. `Zuschlagskriterien`
4. `Nachweise`
5. `Vertragsstrafen`
6. `Zahlungsbedingungen`

Optional seventh schema if capacity permits:

7. `Nebenangebote`

### 18.2 Field shape

```typescript
export interface CitedValue<T> {
  value: T | null;
  confidence: number;
  citations: Citation[];
  citationState: "VERIFIED" | "UNVERIFIED" | "MISSING";
}
```

### 18.3 Extraction rules

- One document per extraction call.
- One schema per call where practical.
- Temperature zero.
- Structured response only.
- Every field is optional.
- `unresolved` is a valid model output.
- The model must not invent values to satisfy a required JSON shape.
- Company master-data values must not be sent during template mapping; only the schema paths are sent.

### 18.4 Citation verification

After every extraction:

1. Confirm the cited page exists.
2. Normalise whitespace.
3. Confirm the quote exists on that page.
4. Confirm the associated chunk contains the quote.
5. Confirm the bbox belongs to that page.
6. Hash the quote.
7. Mark the citation verified or failed.

Failed fields are re-extracted at most twice, then flagged for human review.

---

## 19. Agent Tool Registry

Use one internal typed tool registry shared by Clara, Dora, Nova, and chat. MCP exposure can be added after internal contracts stabilise.

```text
get_tender_notice(tenderId)
list_tender_documents(tenderId)
get_document_page(documentId, page)
get_document_blocks(documentId, pageRange)
get_extraction(tenderId, schemaName)
search_tender_chunks(tenderId, query, docClass?)
lookup_standard_form(reference)
get_tender_summary(tenderId)
check_company_capability(requirement)
get_company_master(version)
get_form_template(fingerprint)
get_form_status(tenderId)
get_bid_package_status(packageId)
explain_filled_field(formId, fieldId)
flag_for_human(reason, severity)
save_review_decision(resourceId, decision)
```

Each tool:

- validates its input schema,
- injects tenant scope from runtime context,
- returns bounded data,
- emits an audit event where appropriate,
- and never returns secrets not required by the caller.

---

## 20. Dora Workflow

### 20.1 Dora state

```typescript
export interface DoraState {
  tenantId: string;
  actorId: string;
  tenderId: string;
  runId: string;

  documentIds: string[];
  extractionIds: string[];
  unresolvedQuestions: string[];
  retrievedChunks: RetrievedChunk[];

  draftVerdict?: TenderVerdict;
  citationReport?: CitationReport;
  reviewDecision?: ReviewDecision;

  retryCount: number;
  errors: AgentError[];
}
```

### 20.2 Dora graph

```text
loadTender
→ ensureDocuments
→ dispatchParsingJobs
→ waitForDocuments
→ dispatchEmbeddingJobs
→ waitForEmbeddings
→ runStructuredExtractions
→ verifyCitations
   ├─ failed and retryCount < 2 → rerunFailedExtractions
   └─ passed or human flag
→ identifyInformationGaps
→ hybridRetrieveForGaps
→ reasonOverExtractionsAndEvidence
→ draftVerdict
→ interruptForHumanReview
   ├─ approved → finalise
   ├─ amended → applyAmendments → finalise
   └─ rejected → stop
```

### 20.3 Dora output

```typescript
export interface TenderVerdict {
  recommendation: "bid" | "no_bid" | "conditional";
  rationale: string;
  scoreBreakdown: {
    eligibilityFit: number;
    strategicFit: number;
    capacityFit: number;
    contractRisk: number;
    deadlineFeasibility: number;
  };
  risks: CitedRisk[];
  blockingRequirements: CitedRequirement[];
  unresolvedQuestions: string[];
  citations: Citation[];
}
```

### 20.4 Dora design rule

Dora does not re-parse files and does not perform broad extraction inside reasoning nodes. Dora consumes completed typed extractions, retrieves only unresolved evidence, applies judgment, and creates a reviewable verdict.

---

## 21. Clara Workflow

### 21.1 Clara funnel

```text
all available notices
→ hard filters
→ semantic company/tender similarity
→ top shortlist
→ structured LLM fit judgment
→ human pursue/review/skip
```

### 21.2 Hard filters

- Tender is open
- Deadline is feasible
- CPV matches company profile, including hierarchy descendants
- Region is serviceable
- Procedure type is accepted
- Contract type is supported
- Estimated value is within company range where available
- Excluded capabilities are absent

Deadline feasibility is a hard filter, not a soft score.

### 21.3 Company capability profile

```javascript
{
  tenantId: ObjectId,
  companyId: ObjectId,
  cpvCodes: [],
  regionsNuts: [],
  valueBandEur: { min: 0, max: 0 },
  capabilitiesText: "...",
  certifications: [],
  capacity: {
    concurrentProjectsMax: 0,
    currentLoad: 0
  },
  exclusions: [],
  strategicTargets: [],
  embedding: []
}
```

### 21.4 Clara output

```typescript
export interface TenderFit {
  fitScore: number;
  recommendation: "pursue" | "review" | "skip";
  eligibilityFeasible: boolean;
  eligibilityGaps: string[];
  capacityConflict: boolean;
  strategicValue: "high" | "medium" | "low";
  reasoning: string;
  citations: Citation[];
}
```

### 21.5 Feedback loop

Store every human decision:

```javascript
{
  tenantId: ObjectId,
  tenderId: ObjectId,
  recommended: "pursue",
  humanDecision: "skip",
  reason: "...",
  decidedBy: ObjectId,
  decidedAt: ISODate()
}
```

These decisions later become examples and ranking signals.

---

## 22. Chat Architecture

### 22.1 Rule

Chat queries completed artefacts first. It must not silently re-analyse the package on every question.

Correct order:

```text
get_extraction
→ get_tender_summary
→ get_form_status
→ retrieval fallback only when structured data is insufficient
```

### 22.2 Thread scopes

- Global tenant thread
- Tender-bound thread
- Bid-package-bound thread

Tender-bound threads automatically restrict every tool call to that tender.

### 22.3 Chat tools

```text
search_tenders
get_tender_summary
get_extraction
search_tender_chunks
get_form_status
explain_filled_field
compare_tenders
get_deadline_calendar
```

### 22.4 Streaming

Stream:

- response tokens,
- current tool status,
- document being searched,
- and citation metadata.

Do not expose internal chain-of-thought. Expose concise progress events such as:

```text
Loading approved extraction...
Searching contractual conditions...
Verifying the cited paragraph...
```

---

## 23. Company Master Data

### 23.1 Why it is required early

A majority of tender-form values are stable company facts. Filling them with an LLM on every tender is slower, more expensive, less private, and less reliable than deterministic lookup.

### 23.2 Sections

- Identity
- Legal registration
- Addresses
- Management and contacts
- Banking
- Financial history
- Employee history
- Insurance
- Certifications
- Reference projects
- Key personnel
- Equipment
- Declarations
- Evidence documents

### 23.3 Versioning

Every bid package references the exact master-data version used. Creating a new version does not change historical packages.

### 23.4 Evidence and expiry

Each certification or insurance record includes:

- document ID,
- issuer,
- number,
- valid-from date,
- valid-until date,
- review state.

Nova must block package approval when a required evidence item is expired or will expire before the relevant bind period.

### 23.5 Maintenance UI

The UI needs:

- current completeness score,
- sections requiring review,
- certificates expiring in 30/60/90 days,
- missing evidence,
- pending human verification,
- and a version history.

---

## 24. Form Fingerprinting and Template Store

### 24.1 Principle

Do not solve form filling anew for every tender. Solve each form template once and reuse the verified mapping.

```text
form received
→ fingerprint
→ exact known template?
   ├─ yes → deterministic field map
   └─ no → near-match
          ├─ high similarity → human review
          └─ unknown → LLM proposes resolver map → human verifies
```

### 24.2 Fingerprint signals

- Form number
- Form family
- Version
- AcroForm/XFA field names
- Heading text
- Table shape
- Page count
- Structural hash with tender-specific values removed

### 24.3 Near-match policy

A near-match is never promoted automatically. A human verifies it before reuse.

### 24.4 Initial templates

Select three high-frequency forms from real customer packages. Prefer:

- one AcroForm PDF,
- one DOCX form,
- one XLSX price or declaration sheet.

The exact templates must be chosen from customer data during Week 1.

---

## 25. Nova Field Resolution

### 25.1 Resolver types

```typescript
type Resolver =
  | MasterDataResolver
  | ComputedResolver
  | TenderResolver
  | HumanRequiredResolver;
```

#### `master_data`

```typescript
interface MasterDataResolver {
  kind: "master_data";
  path: string;
  transform?: string;
}
```

#### `computed`

```typescript
interface ComputedResolver {
  kind: "computed";
  expression: string;
  dependsOn: string[];
}
```

Only allow expressions from a safe restricted expression engine. Never use `eval`.

#### `from_tender`

```typescript
interface TenderResolver {
  kind: "from_tender";
  schemaName: string;
  fieldPath: string;
}
```

#### `human_required`

```typescript
interface HumanRequiredResolver {
  kind: "human_required";
  prompt: string;
  options?: string[];
  default?: string;
}
```

### 25.2 Provenance

Every field stores:

```typescript
interface FilledFieldValue {
  value: unknown;
  source: "master_data" | "computed" | "tender" | "human";
  confidence: number;
  provenance: string;
  citations?: Citation[];
  requiresInput: boolean;
  verifiedBy?: string;
  verifiedAt?: Date;
}
```

### 25.3 Template mapping privacy

When asking an LLM to propose field mappings, send:

- form field names,
- labels,
- nearby form text,
- master-data schema paths and types,
- extraction schema paths.

Do not send company bank details, financial values, personal contact values, or certificate numbers for the mapping task.

---

## 26. Format Writers

### 26.1 Pilot support

| Format | Pilot status | Method |
|---|---|---|
| AcroForm PDF | Supported | Set values, flatten if needed, re-read verify |
| DOCX | Supported | Content controls/placeholders, preserve styles |
| XLSX | Supported | Write typed cell values, preserve formulas and formatting |
| XFA PDF | Fallback only | Extract/read; overlay or human completion |
| GAEB DA84 | Not in pilot | Phase 2 proprietary implementation |
| Browser form | Not in pilot | Future portal-specific adapter with human submit |

### 26.2 Independent verification

Written files must be verified through a different read path than the writer where possible.

Examples:

- write AcroForm using pypdf, re-read using PyMuPDF,
- write XLSX using openpyxl, reopen and validate formulas/cells,
- write DOCX using python-docx/docxtpl, reopen and inspect XML or rendered output.

A successful write call is not proof that the recipient will see the expected value.

---

## 27. Package Assembly and Validation

### 27.1 Package contents

- Filled forms
- Evidence documents
- Optional cover letter
- Optional pricing/LV response
- Completeness report
- Validation report
- Human decisions

### 27.2 Blocking gates

| Gate | Rule |
|---|---|
| Completeness | Every required field and evidence item exists |
| Expiry | No required certificate is expired or invalid for the relevant period |
| Consistency | Company name, address, tax identifiers, and repeated values agree |
| Arithmetic | Totals, VAT, discounts, and formulas agree |
| Cross-form | Repeated values are identical across forms |
| Citation | Every tender-derived value has verified provenance |
| Format | Output files open and pass format-specific verification |
| Deadline | The submission window is still open with configured safety buffer |
| Signature | Required signature level is known and satisfiable |
| Human fields | Every `human_required` resolver has been completed |

A failed gate is blocking. It is not a yellow warning that can silently pass.

### 27.3 Submission rule

```text
Nova assembles
→ Nova validates
→ human reviews
→ human approves
→ human signs when required
→ human submits
```

The pilot exports a package. It does not click the final submission button.

---

## 28. Review UI

### 28.1 Dora review

Minimum layout:

- Left: extraction/verdict field list
- Right: source document page
- Highlight: citation bbox
- Field confidence
- Citation verification state
- Inline correction
- Unresolved fields
- Risk severity
- Approve/amend/reject actions
- Run and model version

### 28.2 Nova review

- Form inventory
- Completion percentage
- Each field’s source
- `explain field` action
- Human-required fields
- Missing evidence
- Expiry status
- Package-validation report
- Diff against previous similar package where available
- Approve/export action

### 28.3 Human corrections

Every correction stores:

- original value,
- corrected value,
- reason,
- user,
- timestamp,
- source citation,
- schema/template version.

Corrections feed the golden set; they do not silently overwrite evaluation history.

---

## 29. Security and DSGVO

### 29.1 Required controls

| Requirement | Implementation |
|---|---|
| Data residency | EU MongoDB and S3 region or self-hosted EU deployment |
| Encryption at rest | Database and S3 encryption |
| Field encryption | Sensitive banking, tax, and personal data encrypted at field level |
| Transport security | TLS for all inter-service traffic |
| Tenant isolation | Server-injected tenant filter on every repository operation |
| Least privilege | Separate credentials for web, agent worker, and document worker |
| Audit | Append-only audit events for all review/submission-related mutations |
| Trace privacy | Remove or mask sensitive values before model/trace logging |
| Retention | Tenant policy with TTL where appropriate |
| Erasure | Delete source files, parsed data, chunks, embeddings, traces, and checkpoints |
| Prompt injection | No free browsing; retrieved web content treated as untrusted data |
| Secrets | Stored in secret manager; never placed in prompts or queue payloads |

### 29.2 Worker permissions

#### Next.js

- Read/write tenant application data
- Create presigned S3 operations
- Enqueue jobs
- Approve/reject workflows

#### TypeScript agent worker

- Read/write AI collections
- Read derived documents
- Read approved master-data fields through a service layer
- No unrestricted secret access

#### Python document worker

- Read specified S3 object
- Write specified derived S3 prefix
- Read/write only document-processing collections
- No user-session or broad business-data access

### 29.3 Erasure path

A delete operation must cover:

- raw S3 files,
- parsed S3 objects,
- page images,
- generated forms,
- MongoDB documents,
- chunks,
- embeddings,
- extractions,
- verdicts,
- chat messages,
- checkpoints,
- traces,
- and cached model outputs.

---

## 30. Observability

### 30.1 Per-run metrics

- Current graph node
- Queue wait time
- Processing time by step
- File parse duration
- OCR duration
- Embedding duration
- Retrieval latency
- Extraction calls
- LLM tokens and cost
- Citation pass rate
- Retry count
- Human wait time
- Final state

### 30.2 Product metrics

- Tenders processed
- Processing completion rate
- Average analysis time
- Average cost per tender
- Human correction rate
- Retrieval Recall@10
- Extraction field accuracy
- Citation verification rate
- Verdict agreement with reviewer
- Clara Precision@5
- Form auto-fill percentage
- Package validation failure reasons

### 30.3 Alerts

- Queue backlog over threshold
- Worker heartbeat missing
- Citation pass rate below threshold
- Parsing quality regression
- LLM cost spike
- Repeated portal acquisition failure
- Deadline approaching while package remains incomplete
- Expiring company certificate

---

## 31. Evaluation Strategy

### 31.1 Golden set

The full source plan calls for 30–50 labelled tender packages. In the one-month pilot:

- Minimum usable set: 20 real packages
- Target: 30 packages if domain reviewers are available
- At least 5 packages must contain difficult scans or tables
- At least 3 must contain forms selected for Nova
- At least 5 should be from different portals or authorities

### 31.2 Labels

For each package:

- Correct document class
- Parse-quality notes
- Correct extraction values
- Page and paragraph evidence
- Canonical retrieval questions
- Expected relevant chunks
- Expected recommendation
- Key risks
- Required evidence
- Supported form mappings

### 31.3 Quality gates

| Area | Pilot target |
|---|---:|
| Parse quality on selected formats | > 95% |
| Document classification macro-F1 | > 0.92 |
| Extraction field accuracy | > 0.90 |
| Citation verification pass rate | > 0.98 |
| Uncited factual fields in approved output | 0 |
| Retrieval Recall@10 | > 0.90 |
| Dora reviewer agreement | > 0.85 on pilot set |
| Clara Precision@5 | Initial measured baseline; target > 0.60 after feedback data |
| Supported form field fill rate | > 70% deterministic |
| Package validation false pass | 0 on golden cases |

### 31.4 CI gates

No prompt, schema, parser, retrieval, or model configuration change merges without:

- regression evaluation,
- no material decline in citation verification,
- no material decline in field accuracy,
- no breaking schema change without version increment.

---

## 32. One-Month Delivery Plan

## Week 1 — Foundation, Acquisition, and Parsing

**Dates:** 5–14 August 2026

### Goals

- Establish queue and worker infrastructure.
- Freeze contracts and schemas.
- Process real documents into `DocumentIR`.
- Start the golden set.

### Workstream A — Platform

- Create `packages/queues`.
- Configure BullMQ queues.
- Add agent-run creation and status endpoints.
- Add SSE/polling event endpoint.
- Add worker heartbeat.
- Add idempotency keys.
- Add tenant-safe repository base.
- Add audit-log service.

### Workstream B — Document worker

- Create Python worker container.
- Add Redis/BullMQ-compatible consumer or agreed queue bridge.
- Implement S3 download/upload.
- Implement magic-byte detection.
- Implement archive extraction.
- Implement native PDF parsing.
- Implement OCR fallback.
- Implement DOCX and XLSX paths.
- Render PDF pages.
- Emit `DocumentIR`.

### Workstream C — Domain and evaluation

- Select 20–30 packages.
- Freeze initial six extraction schemas.
- Label five packages in full.
- Select the three Nova forms.
- Define document classes.

### Workstream D — UI

- Document upload UI.
- Processing-status timeline.
- Basic document viewer.

### Week 1 exit gate

A developer can:

```text
open an existing tender
→ upload a tender package
→ observe a queued job
→ see files extracted to S3
→ see document records in MongoDB
→ inspect DocumentIR blocks
→ open rendered pages
```

No agent is required yet.

---

## Week 2 — Chunking, Embeddings, Retrieval, and Extraction

**Dates:** 15–21 August 2026

### Goals

- Make tender contents reliably searchable.
- Produce typed facts with verified citations.
- Run the VMware tender through the complete deterministic pipeline.

### Workstream A — Chunking and indexes

- Section-aware chunking.
- Table-preserving chunk strategy.
- Legal-reference extraction.
- German text index.
- Vector index.
- Tenant/tender/doc-class filters.

### Workstream B — Embeddings and reranking

- Deploy or integrate `bge-m3`.
- Embed tender notices.
- Embed chunks.
- Embed capability profile and references.
- Add reranker.
- Version embeddings.

### Workstream C — Extraction

Implement:

- Fristen
- Eignungskriterien
- Zuschlagskriterien
- Nachweise
- Vertragsstrafen
- Zahlungsbedingungen

Add:

- structured-output validation,
- unresolved fields,
- citation verification,
- extraction retries,
- prompt/model version capture.

### Workstream D — Evaluation

- Add canonical retrieval questions.
- Calculate Recall@10.
- Calculate field accuracy.
- Track citation verification.
- Add failure corpus.

### Week 2 exit gate

The VMware tender or another selected real package produces:

- indexed documents,
- searchable chunks,
- all six extraction objects,
- verified citations,
- unresolved-field list,
- and a machine-readable analysis foundation.

---

## Week 3 — Dora, Review UI, and Tender Chat

**Dates:** 22–28 August 2026

### Goals

- Build the first bounded agent workflow.
- Deliver human-reviewable analysis.
- Add structured-data-first chat.

### Workstream A — Dora graph

- Implement Dora state.
- Implement graph nodes.
- Add MongoDB checkpointing.
- Add resumability after worker restart.
- Add human interrupt.
- Add two-retry citation branch.
- Add cost and trace metadata.

### Workstream B — Verdict

- Create verdict schema.
- Implement risk severity.
- Implement score breakdown.
- Implement blocking requirements.
- Add source-citation aggregation.

### Workstream C — Review UI

- Side-by-side field and source view.
- Bbox highlights.
- Confidence and verification state.
- Inline correction.
- Approve/amend/reject.
- Audit timeline.

### Workstream D — Chat

- MongoDB chat threads/messages.
- Tender-bound thread context.
- Structured artefact tools.
- Retrieval fallback.
- Citation chips.
- Streaming tool status.

### Week 3 exit gate

A reviewer can:

```text
start analysis
→ watch Dora progress
→ review every extracted field
→ click through to evidence
→ correct a value
→ review risks and recommendation
→ approve/amend/reject
→ ask tender-specific questions
```

---

## Week 4 — Clara, Company Master Data, Nova, and Hardening

**Dates:** 29 August–4 September 2026

### Goals

- Match existing tenders to a company.
- Fill selected forms.
- Assemble and validate one real package.
- Harden the complete pilot.

### Workstream A — Clara

- CPV hierarchy loader.
- Hard-filter query.
- Notice/company embedding similarity.
- Structured fit output.
- Human pursue/review/skip action.
- Feedback record.

### Workstream B — Company master data

- Master-data schema.
- Version creation UI.
- Evidence uploads.
- Expiry dates.
- Completeness dashboard.
- One real company fully entered.

### Workstream C — Form templates

- Fingerprint selected forms.
- Build field inventories.
- Propose mappings.
- Human verify mappings.
- Save three templates.

### Workstream D — Nova

- Build Nova graph.
- Resolve master-data fields.
- Resolve tender fields.
- Add human-required fields.
- Add safe computations.
- Write AcroForm/DOCX/XLSX.
- Re-read and verify outputs.
- Assemble evidence.
- Run blocking validation.
- Approve and export.

### Workstream E — Hardening

- Load test queues.
- Simulate worker restart.
- Test duplicate jobs.
- Test tenant-boundary failures.
- Test file corruption.
- Test S3 failure.
- Test model-provider failure.
- Run full regression set.
- Create operator runbook.

### Week 4 exit gate

```text
existing tender
→ documents acquired/uploaded
→ parsed and indexed
→ Dora analysis approved
→ company master selected
→ three supported forms filled
→ evidence attached
→ package validation passes
→ human approves
→ package downloads successfully
```

---

## 33. Detailed First Ten Working Days

### Day 1 — Architecture freeze

- Confirm pilot scope.
- Assign owners.
- Freeze `DocumentIR`.
- Freeze initial extraction schemas.
- Create project boards and milestones.
- Create worker service skeletons.

### Day 2 — Queue and run model

- Create BullMQ queues.
- Create `agent_runs` collection.
- Implement run events.
- Add idempotency.
- Add tenant-safe job producer.

### Day 3 — Upload and S3 flow

- Create presigned upload endpoint.
- Complete-upload callback.
- Document records.
- SHA-256 calculation.
- Start parse job.

### Day 4 — PDF path

- Native PDF parse.
- Page count.
- Markdown output.
- Page rendering.
- Basic anchors.

### Day 5 — OCR and archive path

- OCR fallback.
- ZIP extraction.
- Nested archive limits.
- Corrupt-entry reporting.

### Day 6 — DOCX/XLSX path

- DOCX extraction.
- XLSX tables.
- Normalised blocks.
- Parser test fixtures.

### Day 7 — Chunking

- Section chunker.
- Table handling.
- Legal-reference detector.
- Chunk persistence.

### Day 8 — Embeddings

- Model service.
- Notice embedding.
- Chunk embedding.
- Vector indexes.

### Day 9 — Hybrid retrieval

- German text index.
- Vector query.
- Fusion.
- Reranking.
- Canonical retrieval tests.

### Day 10 — First extraction

- Fristen schema.
- Structured model call.
- Citation verification.
- Review of first real package.

---

## 34. Team Allocation

A six-to-eight-person team can run parallel workstreams.

| Role | Primary responsibility |
|---|---|
| Tech lead / architect | Contracts, sequencing, cross-service decisions, review gates |
| Backend/platform engineer | Next.js APIs, BullMQ, repositories, audit, tenant safety |
| Document intelligence engineer | Python worker, parsing, OCR, archives, citations |
| Retrieval/ML engineer | Chunking, embeddings, indexes, reranking, evaluation |
| Agent engineer | LangGraph.js, tools, structured outputs, Clara/Dora/Nova |
| Frontend engineer | Review UI, document viewer, chat, company master, forms |
| QA/evaluation engineer | Golden set, regression tests, metrics, failure corpus |
| Procurement-domain reviewer | Schema definitions, labels, form mappings, verdict validation |

### 34.1 Coding-agent usage

Codex and Claude Code are suitable for:

- scaffolding routes and workers,
- implementing typed contracts,
- writing parser adapters,
- generating unit tests,
- generating fixtures,
- building form writers,
- creating database indexes,
- refactoring repeated patterns,
- and documenting APIs.

Humans must own:

- legal/domain schema meaning,
- golden-set correctness,
- citation validation policy,
- form resolver verification,
- security review,
- and release approval.

Coding speed does not replace the time required to establish whether a tender value is legally and commercially correct.

---

## 35. Definition of Done

The one-month pilot is complete only when all of the following are true.

### Platform

- [ ] Every tenant-owned collection and S3 key is tenant-scoped.
- [ ] No public request performs long-running analysis inline.
- [ ] Jobs are idempotent.
- [ ] Agent runs resume after worker restart.
- [ ] Worker heartbeats and failures are visible.
- [ ] Audit logs exist for all human decisions.

### Documents

- [ ] Raw originals are immutable.
- [ ] ZIP and nested ZIP packages are handled safely.
- [ ] Native and scanned PDFs are supported.
- [ ] DOCX and XLSX are supported.
- [ ] Page images are generated.
- [ ] Page, paragraph, and bbox anchors are stored.
- [ ] Unsupported files are flagged without losing the package.

### Retrieval and extraction

- [ ] Tender notices and chunks are embedded.
- [ ] Hybrid retrieval is tenant- and tender-filtered.
- [ ] Reranking is enabled.
- [ ] Six extraction schemas work.
- [ ] Citation verification is automatic.
- [ ] No approved field contains an uncited factual value.

### Dora

- [ ] Dora uses completed extractions first.
- [ ] Dora has bounded typed tools.
- [ ] Dora has a human gate.
- [ ] Verdict changes are audited.
- [ ] Source evidence opens in one click.

### Chat

- [ ] Tender-scoped threads are supported.
- [ ] Structured artefacts are queried before raw retrieval.
- [ ] Factual answers include citations.

### Clara

- [ ] CPV hierarchy is applied.
- [ ] Deadline feasibility is a hard filter.
- [ ] Company profile is embedded.
- [ ] Fit result is structured.
- [ ] Human decisions are stored as feedback.

### Nova

- [ ] Company master data is versioned.
- [ ] One real company profile is complete.
- [ ] Three form templates are verified.
- [ ] Resolver provenance is stored.
- [ ] Written files are independently re-read.
- [ ] Package validation is blocking.
- [ ] Human approval is required.
- [ ] No automatic submission exists.

### Quality

- [ ] Parse quality exceeds the pilot threshold.
- [ ] Classification F1 exceeds the pilot threshold.
- [ ] Extraction accuracy exceeds the pilot threshold.
- [ ] Citation verification exceeds the pilot threshold.
- [ ] Retrieval Recall@10 exceeds the pilot threshold.
- [ ] Regression evaluation runs in CI.

---

## 36. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Bad PDF parsing | Incorrect extractions and citations | Treat parse quality as a release gate; keep page-level review |
| Scanned or low-quality documents | OCR errors | OCR fallback, confidence, human review, failure corpus |
| Portal blocks acquisition | Missing package | Manual upload first-class; adapters later |
| MongoDB hybrid feature availability differs | Retrieval blocked | Abstract retrieval and keep application-side fusion fallback |
| LLM produces plausible wrong data | Legal/business risk | Structured schema, unresolved escape, citation verification |
| Long jobs die during deploy | Incomplete analysis | BullMQ jobs, checkpoints, idempotency, heartbeats |
| Cross-tenant access bug | Severe security incident | Server-injected tenant context, repository tests, least privilege |
| Company data becomes stale | Incorrect form values | Versioning, expiry dashboard, hard validation blocks |
| XFA forms fail silently | Empty submitted values | Re-read verification, overlay/human fallback |
| Form mapping is wrong | Incorrect package | Human verification before template activation |
| Agent prompt injection | Unsafe actions | No free browser, narrow tools, retrieved content as data only |
| Team starts with agent UX | Unreliable demo | Bottom-up gates: parse → extract → retrieve → agent |
| Scope expands to submission | Missed one-month target | Explicitly exclude automatic submission and QES |

---

## 37. Phase 2 Roadmap After the Pilot

### Months 2–3

- Expand golden set to 50+ packages.
- Increase extraction schema coverage.
- Map 10–20 common forms.
- Add local standard-forms corpus.
- Improve company-reference selection.
- Add certificate-expiry automation.
- Add additional portal acquisition adapters.
- Improve Clara feedback-based ranking.

### Months 3–4

- XFA write/overlay production path.
- GAEB XML parser.
- Initial GAEB DA84 writer.
- Pricing-system integration.
- Cross-form consistency engine.
- Package diffs against previous bids.

### Months 4–5

- TED continuous ingestion.
- Contract award intelligence.
- XVergabe retrieval integration.
- Signature-level detection.
- Submission receipt storage.

### Ongoing

- XVergabe conformance.
- Additional web-form adapters where legally permitted.
- Self-hosted inference option.
- Retrieval/model evaluation at scale.
- Domain-specific schema expansion.
- Customer-specific form-template libraries.

---

## 38. Immediate Next Actions

1. Create the roadmap milestone ending 4 September 2026.
2. Assign an owner to each workstream.
3. Select 20–30 real tender packages.
4. Select the three Nova form templates.
5. Freeze `DocumentIR` and the six extraction schemas.
6. Add BullMQ queues and the `agent_runs` collection.
7. Build the first path:

```text
existing tender
→ upload one PDF
→ S3
→ parsing job
→ DocumentIR
→ chunks
→ embedding
→ retrieval with page and bbox
```

8. Do not begin Clara, Dora, or Nova orchestration until that path works reliably.
9. Process the VMware licence tender as an early pilot because its deadline is 27 August 2026.
10. Hold a twice-weekly quality review focused on evidence, not feature count.

---

## 39. Final Architectural Decision

BAU AI should build:

```text
Next.js
  = UI, public APIs, auth, tenancy, review, approval, chat

Redis + BullMQ
  = durable background workflow execution

MongoDB
  = notices, documents, chunks, vectors, extractions, state, master data, audit

S3
  = immutable originals and generated artefacts

LangGraph.js + LangChain.js
  = bounded Clara, Dora, Nova, and chat orchestration

Private Python document worker
  = parsing, OCR, PDF coordinates, forms, XFA, and GAEB work
```

The platform’s defensibility will not come from the choice of framework. It will come from:

- the German tender extraction schemas,
- the verified citation pipeline,
- the labelled evaluation set,
- the form-template library,
- the field-resolution mappings,
- the company evidence model,
- the XFA and GAEB implementation,
- and the accumulated customer feedback loop.

Build the reliable evidence and form-processing foundation first. Add agentic judgment only on top of components that already pass deterministic quality gates.
