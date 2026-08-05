"use client";

import { ImagePlus, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { card } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { uploadCompanyFile } from "@/lib/company/upload-client";

/** Company logo upload via the presigned-URL flow. */
export function LogoUploader({
  initialLogoUrl,
  canEdit,
}: {
  initialLogoUrl: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const inputRef = useRef<HTMLInputElement>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const onSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadCompanyFile(file, "logo");
      if (result.category === "logo") setLogoUrl(result.logoUrl);
      router.refresh();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : t("feedback.uploadFailed"),
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className={`${card} flex items-center gap-4 p-5`}>
      <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-[#eceaf2] bg-[#faf8ff]">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL, not a static asset
          <img src={logoUrl} alt="Company logo" className="size-full object-contain" />
        ) : (
          <ImagePlus className="text-[#b9b4c6]" size={22} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-bold">{t("logo.title")}</h2>
        <p className="mt-0.5 text-xs text-[#85818c]">{t("logo.description")}</p>
        {error && (
          <p className="mt-1 text-[11px] font-semibold text-[#c02626]">{error}</p>
        )}
      </div>
      {canEdit && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden"
            onChange={onSelect}
          />
          <Button
            type="button"
            variant="outline"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" size={15} /> : <ImagePlus size={15} />}
            {logoUrl ? t("actions.replace") : t("actions.upload")}
          </Button>
        </>
      )}
    </section>
  );
}
