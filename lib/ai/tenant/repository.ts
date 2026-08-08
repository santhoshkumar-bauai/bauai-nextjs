import {
  ObjectId,
  type Collection,
  type DeleteResult,
  type Filter,
  type FindOptions,
  type OptionalUnlessRequiredId,
  type UpdateFilter,
  type UpdateResult,
  type WithId,
} from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { TenantId, type TenantOwned } from "./types.ts";

/**
 * Tenant-safe access to a tenant-owned collection. Every read merges the
 * tenant into the filter and every write stamps it, so application code can
 * not express a cross-tenant query through this type — the roadmap's §6.3
 * rule enforced at the seam rather than remembered at every call site.
 *
 * Deliberately NOT exposed: aggregate/distinct/bulkWrite. Add them here with
 * tenant injection when a real caller appears; never reach for the raw
 * collection in feature code.
 */
export class TenantRepository<T extends TenantOwned> {
  private readonly collection: Collection<T>;
  private readonly tenant: TenantId;

  constructor(collection: Collection<T>, tenant: TenantId) {
    this.collection = collection;
    this.tenant = tenant;
  }

  get tenantId(): ObjectId {
    return this.tenant.value;
  }

  private scope(filter: Filter<T>): Filter<T> {
    // Spread order matters: a caller-supplied `tenantId` is always overwritten.
    return { ...filter, tenantId: this.tenant.value } as Filter<T>;
  }

  async findOne(filter: Filter<T>, options?: FindOptions): Promise<WithId<T> | null> {
    return this.collection.findOne(this.scope(filter), options);
  }

  async findMany(filter: Filter<T>, options?: FindOptions): Promise<WithId<T>[]> {
    return this.collection.find(this.scope(filter), options).toArray();
  }

  async countDocuments(filter: Filter<T> = {}): Promise<number> {
    return this.collection.countDocuments(this.scope(filter));
  }

  async insertOne(
    document: Omit<T, "tenantId" | "createdAt" | "updatedAt">,
  ): Promise<ObjectId> {
    const now = new Date();
    const stamped = {
      ...document,
      tenantId: this.tenant.value,
      createdAt: now,
      updatedAt: now,
    } as unknown as OptionalUnlessRequiredId<T>;
    const result = await this.collection.insertOne(stamped);
    return result.insertedId as ObjectId;
  }

  async updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T>,
  ): Promise<UpdateResult> {
    const withTimestamp: UpdateFilter<T> = {
      ...update,
      $set: {
        ...(update.$set ?? {}),
        updatedAt: new Date(),
      } as UpdateFilter<T>["$set"],
    };
    // $setOnInsert/$unset cannot smuggle a foreign tenantId past the filter:
    // the scoped filter guarantees only this tenant's documents match.
    delete (withTimestamp.$set as Record<string, unknown>)?.tenantId;
    return this.collection.updateOne(this.scope(filter), withTimestamp);
  }

  async deleteOne(filter: Filter<T>): Promise<DeleteResult> {
    return this.collection.deleteOne(this.scope(filter));
  }

  async deleteMany(filter: Filter<T>): Promise<DeleteResult> {
    return this.collection.deleteMany(this.scope(filter));
  }
}

/**
 * The only two blessed entry points into a tenant scope:
 * an authenticated company context (API routes) or a validated job payload
 * whose producer derived the tenant server-side (§10.2).
 */
export function forCompanyContext(context: CompanyContext): TenantId {
  return TenantId.of(new ObjectId(String(context.company._id)));
}

export function forJobPayload(tenantIdHex: string): TenantId {
  if (!ObjectId.isValid(tenantIdHex)) {
    throw new Error(`job payload carried an invalid tenantId: "${tenantIdHex}"`);
  }
  return TenantId.of(new ObjectId(tenantIdHex));
}
