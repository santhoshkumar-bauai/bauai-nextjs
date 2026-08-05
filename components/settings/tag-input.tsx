"use client";

import { X } from "lucide-react";
import { useState } from "react";

import { fieldInput } from "@/components/settings/settings-ui";

/** A minimal tag editor for string[] fields (trades, services, CPV codes, …). */
export function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!value.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...value, trimmed]);
    }
    setDraft("");
  };

  const remove = (index: number) =>
    onChange(value.filter((_, i) => i !== index));

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {value.map((tag, index) => (
            <span
              key={`${tag}-${index}`}
              className="inline-flex items-center gap-1 rounded-full bg-[#f3eaff] px-2.5 py-1 text-[11px] font-medium text-[#5e12bf]"
            >
              {tag}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="text-[#8b5cf6] hover:text-[#5e12bf]"
                  aria-label={`Remove ${tag}`}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          className={fieldInput}
        />
      )}
    </div>
  );
}
