import type { ObjectId } from "mongodb";

/**
 * Tenancy for the AI subsystem (roadmap §6.3, §12).
 *
 * The tenant is the company: `tenantId` is always a `Company._id`. Tender
 * notices, tender documents, and their shared chunks/embeddings are global
 * reference data and carry no tenant. Everything a company or an agent
 * produces — extractions, verdicts, agent runs, chat threads, capability
 * profiles — is tenant-owned and MUST go through `TenantRepository`, which
 * injects the tenant scope server-side. The frontend, an LLM, a tool
 * argument, or a user prompt is never trusted to supply it (§6.3).
 */

/** Common header for every tenant-owned document (roadmap §12). */
export interface TenantOwned {
  tenantId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Wrapper that makes "which tenant?" an explicit, deliberate decision at the
 * boundary (an authenticated request or a validated job payload) instead of a
 * field any caller can pass. Constructed only via `tenantIdFrom`.
 */
export class TenantId {
  readonly value: ObjectId;
  private constructor(value: ObjectId) {
    this.value = value;
  }

  /** @internal — use `tenantIdFrom` / `forCompanyContext`. */
  static of(value: ObjectId): TenantId {
    return new TenantId(value);
  }

  toString(): string {
    return this.value.toHexString();
  }
}
