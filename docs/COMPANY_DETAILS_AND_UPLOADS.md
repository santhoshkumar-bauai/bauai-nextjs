# Company details & S3 presigned uploads

Replicates the company-details data the mvp1 app (`mvp1-bauai`) stored in the
Supabase `companies` row, re-modelled as typed Mongoose schemas, and adds a
secure S3 presigned-URL flow for file uploads (logos + knowledge-base
documents).

## Data model

### `Company` (`models/company.ts`)

The existing company/org document is extended with the mvp1 profile fields, all
strongly typed:

- **Profile**: `companyDomain`, `companyDomainOther`, `email`, `phone`,
  `vatNumber`, `registrationNumber`, `address`, `addressCoordinates`,
  `employeeCount`, `logoKey` (the S3 key of the current logo).
- **Tender profile**: `trade[]`, `specializations[]`, `certifications[]`,
  `projectSizeRange { min, max }` (`services[]`, `cpvCodes[]`, `region` already
  existed).
- **`bankDetails`**: `{ bankName, accountNumber, accountHolder, iban, bic }`.
- **`insurances[]`**: `{ type, amount, details? }`.
- **`referenceProjects[]`**: `{ title, description, client?, year?, value? }`.
- **`knowledgeBase`**: the full nested KB (companyExtended, principalOffice,
  mailingAddress, contactInfo, primaryContact, authorizedSigner, financialInfo,
  bankExtended, insuranceDetails, bonding, businessCertifications,
  technicalNarratives). mvp1 kept this as an untyped JSON blob; here every field
  has a schema. Field names are camelCased to match the codebase convention
  (mvp1 used snake_case).

### `CompanyFile` (`models/company-file.ts`)

A dedicated collection for uploaded files, replacing mvp1's untyped
`insurance_documents` / `certification_documents` / … JSON arrays. Each row holds
metadata only — the bytes live in S3, addressed by `s3Key`. Categories:
`insurance`, `certification`, `reference-project`, `general` (the logo lives on
`Company.logoKey`, not here).

## Presigned upload flow

The browser never sees bucket credentials. Three steps:

1. **`POST /api/company/documents/upload-url`** — validates auth/membership,
   category, content type, and size, then returns a short-lived presigned `PUT`
   URL plus the object `key`. No DB row is written yet.
2. Browser **`PUT`s the file directly to S3** using that URL (Content-Type must
   match the signed value).
3. **`POST /api/company/documents`** — echoes the `key`; the server verifies the
   key belongs to this company, confirms the object landed (`HeadObject`), then
   persists a `CompanyFile` row (or sets `Company.logoKey` for a logo, replacing
   the previous logo object).

Reads and deletes:

- **`GET /api/company/documents`** — list files (optional `?category=`).
- **`GET /api/company/documents/:id`** — short-lived presigned view URL.
- **`DELETE /api/company/documents/:id`** — deletes the S3 object then the row.

### Profile

- **`GET /api/company/profile`** — the full company profile (logo resolved to a
  presigned URL).
- **`PATCH /api/company/profile`** — admin-only partial update. The body is
  whitelisted by `lib/validation/company-profile.ts`; `domain`, `members`,
  `trial`, and ownership are never settable here.

## Client helper

`lib/company/upload-client.ts` wraps the three-step flow for client components:
`uploadCompanyFile(file, category)`, `getCompanyFileUrl(id)`,
`deleteCompanyFile(id)`.

## Configuration

Uses the same S3 bucket/credentials as the tender ingestion pipeline
(`S3_BUCKET_NAME`, `S3_ENDPOINT`, `S3_REGION`, `S3_KEY_ID`,
`S3_APPLICATION_KEY`), namespaced under a separate prefix:

```
S3_COMPANY_PREFIX=companies
```

Limits live in `lib/storage/s3.ts`: `MAX_UPLOAD_BYTES` (25 MB) and the
content-type allowlists for logos vs documents.

## Frontend

`/settings` is a nested route tree — each section is its own path (not a
client-side tab), under `app/(workspace)/settings/`:

- `settings/layout.tsx` — auth guard + dashboard shell + top-tab nav
  (`SettingsTabs`). Tabs: `/settings`, `/settings/tender-information`,
  `/settings/employee-information`, `/settings/billing`,
  `/settings/dora-playbook`.
- `settings/(company)/` — a route group (no URL segment) that adds the KB
  sidebar (`CompanySidebar`) around the Company Information sub-sections, each
  its own path: `/settings/company-info`, `/settings/company-details`,
  `/settings/principal-office`, `/settings/mailing-address`,
  `/settings/primary-contact`, `/settings/financial-information`,
  `/settings/insurance`, `/settings/certifications`, `/settings/documents`.
  `/settings` redirects to `/settings/company-info`.

Server pages are thin: each loads `getSettingsData()` (cached per request —
serialized profile + files + `canEdit` + trial date) and renders a client form:

- `SectionForm` — config-driven editable card (`lib/company/settings-sections.ts`)
  that PATCHes `/api/company/profile`. Handles root fields, `bankDetails`,
  `projectSizeRange`, and knowledge-base slices (KB sections merge so saving one
  never wipes another). Tag fields use `TagInput`.
- `CertificationsForm`, `InsurancesEditor` — the boolean-grid and array sections.
- `LogoUploader`, `DocumentsManager` — the presigned upload UI, built on
  `lib/company/upload-client.ts`.

Only admins (`canEdit`) see save buttons and upload controls; members get a
read-only view.

## Internationalization

The whole settings surface is bilingual (English + German) via next-intl. All
copy lives under the `Settings` namespace in `messages/en.json` and
`messages/de.json`; `lib/company/settings-sections.ts` carries only message ids
(`sections.<id>.title/description/fields.<key>`, `sidebar.*`,
`certificationFlags.*`, `documents.categories.*`, `actions.*`, `feedback.*`) and
the client components resolve them with `useTranslations("Settings")`. Adding a
field means adding its label key to both locale files. Language-neutral example
placeholders (e.g. "GmbH", "€5,000,000") stay in the config as `sample` values.

## Not included / next steps

- Out-of-band sweeping of orphan S3 objects from abandoned uploads (upload URLs
  are minted without a DB row, so an abandoned upload leaves only an S3 object).
