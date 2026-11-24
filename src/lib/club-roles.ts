type ClubMemberRole = { role?: unknown; primaryAdmin?: unknown; displayName?: unknown; accountName?: unknown };

export function isClubPresident(member: ClubMemberRole) {
  // Legacy ADMIN accounts without the flag remain compatible. Explicit false wins.
  return member.role === "ADMIN" && (member.primaryAdmin === true || (
    member.primaryAdmin === undefined && String((Object.hasOwn(member, "accountName") ? member.accountName : member.displayName) ?? "").toLowerCase() === "barryadmin"
  ));
}

export const PRESIDENT_EXIT_MESSAGE = "您目前是社長，無法直接退出社團。請先將社長權限轉交給其他社員。";

type ClubIdentity = { role?: unknown; primaryAdmin?: unknown; membershipStatus?: unknown; member?: boolean };

// Display one identity. Membership and permission checks continue to use their own fields.
export function clubIdentityLabel(person: ClubIdentity) {
  const administrator = person.role === "ADMIN" || person.role === "admin";
  if (administrator && person.primaryAdmin === true) return "社長";
  if (administrator) return "幹部管理者";
  if (person.membershipStatus === "EXITING") return "本期後退出";
  return person.member === true || person.membershipStatus === "MEMBER" ? "社員" : "非社員";
}
