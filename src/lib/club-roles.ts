type ClubMemberRole = { role?: unknown; primaryAdmin?: unknown; displayName?: unknown };

export function isClubPresident(member: ClubMemberRole) {
  // Legacy ADMIN accounts without the flag remain compatible. Explicit false wins.
  return member.role === "ADMIN" && (member.primaryAdmin === true || (
    member.primaryAdmin === undefined && String(member.displayName ?? "").toLowerCase() === "barryadmin"
  ));
}

export const PRESIDENT_EXIT_MESSAGE = "您目前是社長，無法直接退出社團。請先將社長權限轉交給其他社員。";
