/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient, BookingStatus, InvoiceType, PaymentStatus, MembershipStatus, UserRole, FeeKind } = require("@prisma/client");
const prisma = new PrismaClient();

const eventAt = (day, courts, regular = 10, standby = 4) => ({
  startsAt: new Date(`2026-09-${day}T19:00:00+08:00`),
  endsAt: new Date(`2026-09-${day}T21:00:00+08:00`),
  courts, regularCapacity: regular, standbyCapacity: standby,
});

async function main() {
  await prisma.transfer.deleteMany(); await prisma.invoice.deleteMany(); await prisma.booking.deleteMany();
  await prisma.clubEvent.deleteMany(); await prisma.announcement.deleteMany(); await prisma.restDay.deleteMany();
  await prisma.feeRate.deleteMany(); await prisma.member.deleteMany();
  const users = await Promise.all([
    prisma.member.create({ data: { displayName: "王小芸", department: "人資", role: UserRole.ADMIN, membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-01-01") } }),
    prisma.member.create({ data: { displayName: "陳韋廷", department: "工程", role: UserRole.ADMIN, membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-01-01") } }),
    prisma.member.create({ data: { displayName: "林子晴", department: "設計", membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-03-01") } }),
    prisma.member.create({ data: { displayName: "周昱安", department: "業務", membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-04-01") } }),
    prisma.member.create({ data: { displayName: "許庭維", department: "財務", membershipStatus: MembershipStatus.GUEST } }),
    prisma.member.create({ data: { displayName: "徐佩珊", department: "產品", membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-02-01") } }),
    prisma.member.create({ data: { displayName: "郭明軒", department: "工程", membershipStatus: MembershipStatus.MEMBER, joinedAt: new Date("2026-02-01") } }),
  ]);
  const [xiaoYun, weiTing, ziQing, yuAn, tingWei, peiShan, mingXuan] = users;
  const [first, second, third] = await Promise.all([
    prisma.clubEvent.create({ data: eventAt("04", "公司體育館 A 場") }),
    prisma.clubEvent.create({ data: eventAt("11", "公司體育館 A 場") }),
    prisma.clubEvent.create({ data: eventAt("18", "公司體育館 A、B 場", 20, 8) }),
  ]);
  await prisma.booking.createMany({ data: [
    xiaoYun, weiTing, ziQing, yuAn, peiShan, mingXuan
  ].map((member) => ({ eventId: first.id, memberId: member.id, kindSnapshot: MembershipStatus.MEMBER, status: BookingStatus.REGULAR })) });
  await prisma.booking.create({ data: { eventId: first.id, memberId: tingWei.id, kindSnapshot: MembershipStatus.GUEST, status: BookingStatus.STANDBY } });
  await prisma.booking.createMany({ data: [xiaoYun, weiTing].map((member) => ({ eventId: second.id, memberId: member.id, kindSnapshot: MembershipStatus.MEMBER, status: BookingStatus.REGULAR })) });
  await prisma.announcement.createMany({ data: [
    { title: "九月活動時段與場地", content: "九月固定於週五 19:00 開打；9/18 將使用 A、B 兩場。", pinned: true },
    { title: "第三季社員費預收通知", content: "本季共 12 次活動，社員預收費用為 NT$1,800。請於 9/6 前完成轉帳。" },
  ]});
  await prisma.feeRate.createMany({ data: [
    { kind: FeeKind.MEMBER_VISIT, amount: 150, effectiveFrom: new Date("2026-07-01") },
    { kind: FeeKind.GUEST_VISIT, amount: 180, effectiveFrom: new Date("2026-07-01") },
  ]});
  await prisma.invoice.createMany({ data: [
    { memberId: xiaoYun.id, type: InvoiceType.QUARTERLY_MEMBER, amount: 1800, status: PaymentStatus.CONFIRMED, periodLabel: "2026 Q3", confirmedAt: new Date("2026-07-01") },
    { memberId: ziQing.id, type: InvoiceType.QUARTERLY_MEMBER, amount: 1800, status: PaymentStatus.REPORTED, periodLabel: "2026 Q3", reportedAt: new Date("2026-08-28") },
    { memberId: tingWei.id, eventId: first.id, type: InvoiceType.SINGLE_EVENT, amount: 180, status: PaymentStatus.PENDING, periodLabel: "9/4 活動" },
    { memberId: yuAn.id, type: InvoiceType.QUARTERLY_MEMBER, amount: 1800, status: PaymentStatus.CONFIRMED, periodLabel: "2026 Q3", confirmedAt: new Date("2026-07-02") },
  ]});
  await prisma.restDay.create({ data: { date: new Date("2026-10-09T00:00:00+08:00"), label: "國慶日連假" } });
  console.log(`Seeded ${users.length} users, 3 events; next event is ${first.id}, third is ${third.id}.`);
}

main().finally(() => prisma.$disconnect());
