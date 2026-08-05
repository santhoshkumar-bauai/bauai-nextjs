"use client";

import { Check, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { card, formatDate, initial } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";

export type SettingsMember = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
  joinedAt: string;
};
export type SettingsRequest = {
  id: string;
  email: string;
  requestedAt: string;
};

/** Team members table + pending join requests. Display + refresh only. */
export function EmployeesPanel({
  members,
  requests,
}: {
  members: SettingsMember[];
  requests: SettingsRequest[];
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    router.refresh();
    window.setTimeout(() => setRefreshing(false), 500);
  };

  return (
    <div className="mx-auto my-7 grid max-w-[1280px] gap-[18px]">
      <section className={`${card} p-5 sm:p-6`}>
        <header className="block sm:flex sm:items-start sm:justify-between sm:gap-5">
          <div>
            <h2 className="m-0 text-base font-bold tracking-[-.02em]">
              Team members
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              Everyone with access to this company workspace.
            </p>
          </div>
          <div className="mt-3 flex gap-2 sm:mt-0">
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              disabled={refreshing}
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </Button>
          </div>
        </header>
        <div className="mt-5 overflow-x-auto">
          <table className="min-w-[640px] w-full border-collapse text-left">
            <thead>
              <tr>
                {["Name", "Email", "Role", "Status", "Joined"].map((label) => (
                  <th
                    key={label}
                    className="border-b border-[#e9e8ed] px-3 pb-3 text-[11px] font-bold text-[#66626c]"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="border-b border-[#f0eff2] px-3 py-3">
                    <span className="flex items-center gap-2 text-[#222027]">
                      <i className="grid size-8 place-items-center rounded-full border border-[#dfc9ff] bg-[#f0e4ff] text-[10px] font-extrabold not-italic text-[#6423ba]">
                        {initial(member.name)}
                      </i>
                      <strong>{member.name}</strong>
                    </span>
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-xs text-[#57535d]">
                    {member.email}
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-xs text-[#57535d]">
                    {member.role === "admin" ? "Admin" : "Member"}
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3">
                    <span className="rounded-full bg-[#dbf9e9] px-2 py-1 text-[10px] font-bold text-[#0b8b4b]">
                      Active
                    </span>
                  </td>
                  <td className="border-b border-[#f0eff2] px-3 py-3 text-[10px] text-[#93909a]">
                    {formatDate(member.joinedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={`${card} p-5 sm:p-6`}>
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="m-0 text-base font-bold">Pending requests</h2>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              People who requested to join this company.
            </p>
          </div>
          <span className="grid size-7 place-items-center rounded-full bg-[#f1e6ff] text-xs font-extrabold text-[#6f19c8]">
            {requests.length}
          </span>
        </header>
        {requests.length ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {requests.map((request) => (
              <div
                key={request.id}
                className="flex items-center gap-2 rounded-xl border border-[#eee9f3] p-2.5"
              >
                <span className="grid size-8 place-items-center rounded-full border border-[#dfc9ff] bg-[#f0e4ff] text-[10px] font-extrabold text-[#6423ba]">
                  {initial(request.email)}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-[11px]">
                    {request.email}
                  </strong>
                  <p className="mt-0.5 text-[10px] text-[#8d8993]">
                    {formatDate(request.requestedAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2 text-xs text-[#4e785e]">
            <Check size={18} className="text-[#1c9a5f]" />
            No pending requests.
          </div>
        )}
      </section>
    </div>
  );
}
