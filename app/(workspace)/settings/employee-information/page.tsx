import { redirect } from "next/navigation";

import { EmployeesPanel } from "@/components/settings/employees-panel";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";

export default async function EmployeeInformationPage() {
  const context = await getCompanyContext();
  if (!context) redirect("/dashboard");

  const members = context.company.members ?? [];
  const memberUserIds = members.map((member) => member.userId);
  const accountUsers = memberUserIds.length
    ? await mongoDatabase
        .collection<{ id: string; name?: string; email?: string }>("user")
        .find(
          { id: { $in: memberUserIds } },
          { projection: { id: 1, name: 1, email: 1 } },
        )
        .toArray()
    : [];
  const usersById = new Map(accountUsers.map((user) => [user.id, user]));

  return (
    <EmployeesPanel
      members={members.map((member) => {
        const user = usersById.get(member.userId);
        return {
          id: member.userId,
          name:
            user?.name ||
            (member.userId === context.userId
              ? context.email.split("@")[0]
              : member.email.split("@")[0]),
          email: user?.email || member.email,
          role: member.role,
          joinedAt: member.joinedAt.toISOString(),
        };
      })}
      requests={context.company.membershipRequests
        .filter((request) => request.status === "pending")
        .map((request) => ({
          id: request.userId,
          email: request.email,
          requestedAt: request.requestedAt.toISOString(),
        }))}
    />
  );
}
