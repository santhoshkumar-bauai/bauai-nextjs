import { cache } from "react";

import { getCompanyContext } from "@/lib/company/context";
import {
  serializeCompanyFile,
  serializeCompanyProfile,
  type SerializedCompanyFile,
  type SerializedCompanyProfile,
} from "@/lib/company/serialize";
import { createDownloadUrl } from "@/lib/storage/s3";
import { CompanyFile } from "@/models/company-file";

export type SettingsData = {
  profile: SerializedCompanyProfile;
  files: SerializedCompanyFile[];
  canEdit: boolean;
  trialEndsAt: string;
};

/**
 * Loads everything the settings routes render: the serialized company profile
 * (with a presigned logo URL), the uploaded files, whether the caller may edit
 * (admins only), and the trial end date for the billing tab.
 *
 * Wrapped in React `cache` so a layout and its page share one DB round-trip per
 * request. Returns null when the caller has no active company membership.
 */
export const getSettingsData = cache(async (): Promise<SettingsData | null> => {
  const context = await getCompanyContext();
  if (!context) return null;

  let logoUrl: string | null = null;
  if (context.company.logoKey) {
    try {
      logoUrl = (await createDownloadUrl({ key: context.company.logoKey }))
        .downloadUrl;
    } catch (error) {
      console.error("Failed to resolve company logo URL", error);
    }
  }

  const files = await CompanyFile.find({
    companyId: context.company._id,
  }).sort({ createdAt: -1 });

  return {
    profile: serializeCompanyProfile(context.company, { logoUrl }),
    files: files.map(serializeCompanyFile),
    canEdit: context.role === "admin",
    trialEndsAt: context.company.trial.endsAt.toISOString(),
  };
});
