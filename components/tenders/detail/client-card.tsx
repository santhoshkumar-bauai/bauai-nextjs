"use client";

import { Building2, Globe, Mail, MapPin, Phone } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SerializedTenderDetail } from "@/lib/tenders/detail";

/**
 * The client (contracting authority) card: identity, classification, full
 * address, and contact channels.
 */
export function ClientCard({ buyer }: { buyer: NonNullable<SerializedTenderDetail["buyer"]> }) {
  const t = useTranslations("Tenders.detail");

  const addressParts = buyer.address
    ? [
        buyer.address.streetName,
        [buyer.address.postalCode, buyer.address.city].filter(Boolean).join(" "),
        buyer.address.countryCode,
      ].filter(Boolean)
    : [];

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Building2 className="size-3.5 text-primary" />
        {buyer.name ?? t("client")}
      </span>

      {(buyer.legalType || buyer.activityType) && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {buyer.legalType && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t("legalType")}</dt>
              <dd className="text-foreground">{buyer.legalType}</dd>
            </div>
          )}
          {buyer.activityType && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t("activityType")}</dt>
              <dd className="text-foreground">{buyer.activityType}</dd>
            </div>
          )}
        </dl>
      )}

      {addressParts.length > 0 && (
        <span className="inline-flex items-start gap-1 text-xs text-muted-foreground">
          <MapPin className="mt-0.5 size-3 shrink-0" />
          {addressParts.join(", ")}
        </span>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {buyer.email && (
          <a
            href={`mailto:${buyer.email}`}
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            <Mail className="size-3" />
            {buyer.email}
          </a>
        )}
        {buyer.phone && (
          <span className="inline-flex items-center gap-1">
            <Phone className="size-3" />
            {buyer.phone}
          </span>
        )}
        {buyer.website && (
          <a
            href={buyer.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            <Globe className="size-3" />
            {t("website")}
          </a>
        )}
      </div>
    </div>
  );
}
