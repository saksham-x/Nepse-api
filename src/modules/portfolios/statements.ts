import type { Response } from 'express';
import type { Deposit, Portfolio } from '@prisma/client';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { prisma } from '../../config/prisma.js';
import { kathmanduDate, tradeDateToDb } from '../../common/utils/time.js';
import { kathmanduMidnight, nextMonthStart, ZERO, type Decimal } from './ledger.js';
import { computeState, num, num6 } from './portfolio.service.js';

export interface StatementData {
  portfolio: { id: number; name: string; type: string };
  member: { membershipId: number; name: string; email: string; role: string };
  month: string;
  generatedAt: string;
  nav: number;
  navDate: string;
  openingUnits: number;
  closingUnits: number;
  unitsIssued: number;
  unitsRedeemed: number;
  closingValue: number;
  contributedToDate: number;
  returnsToDate: number;
  ownershipPercent: number;
  deposits: { period: string; amount: number; status: string; method: string; submittedAt: string; receiptNo: string | null; units: number | null; nav: number | null }[];
  activity: { date: string; type: string; asset: string | null; quantity: number | null; price: number | null; amount: number | null; note: string }[];
}

/** Statement months available to a member: from joining up to the current month. */
export function statementMonths(joinedAt: Date, leftAt: Date | null): string[] {
  const first = kathmanduDate(joinedAt).slice(0, 7);
  const last = kathmanduDate(leftAt ?? new Date()).slice(0, 7);
  const out: string[] = [];
  for (let m = last; m >= first; ) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number) as [number, number];
    m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    if (out.length > 600) break;
  }
  return out;
}

export async function buildStatement(portfolio: Portfolio, membershipId: number, month: string): Promise<StatementData> {
  const start = kathmanduMidnight(`${month}-01`);
  const nextStart = nextMonthStart(month);
  const end = kathmanduMidnight(nextStart);
  const membership = await prisma.membership.findFirstOrThrow({ where: { id: membershipId, portfolioId: portfolio.id }, include: { user: true } });

  const [entries, deposits, txs, snapshot, totalUnitsAtEnd] = await Promise.all([
    prisma.unitEntry.findMany({ where: { membershipId, createdAt: { lt: end } } }),
    prisma.deposit.findMany({ where: { membershipId, OR: [{ period: month }, { reviewedAt: { gte: start, lt: end } }] }, orderBy: { submittedAt: 'asc' } }),
    prisma.portfolioTransaction.findMany({
      where: { portfolioId: portfolio.id, status: 'ACTIVE', date: { gte: tradeDateToDb(`${month}-01`), lt: tradeDateToDb(nextStart) }, type: { notIn: ['DEPOSIT', 'EXIT_PAYOUT'] } },
      include: { holding: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    prisma.navSnapshot.findFirst({ where: { portfolioId: portfolio.id, date: { lt: tradeDateToDb(nextStart) } }, orderBy: { date: 'desc' } }),
    prisma.unitEntry.aggregate({ where: { portfolioId: portfolio.id, createdAt: { lt: end } }, _sum: { units: true } }),
  ]);

  const sum = (list: { units: Decimal }[]) => list.reduce((s, e) => s.add(e.units), ZERO);
  const opening = sum(entries.filter((e) => e.createdAt < start));
  const inMonth = entries.filter((e) => e.createdAt >= start);
  const issued = sum(inMonth.filter((e) => e.kind === 'ISSUE'));
  const redeemed = sum(inMonth.filter((e) => e.kind === 'REDEEM')).neg();
  const closing = opening.add(issued).sub(redeemed);

  // The current month is valued at today's NAV; past months at their last snapshot.
  const isCurrent = kathmanduDate().slice(0, 7) <= month;
  let nav: Decimal = snapshot?.navPerUnit ?? portfolio.initialUnitPrice;
  let navDate = snapshot ? snapshot.date.toISOString().slice(0, 10) : `${month}-01`;
  if (isCurrent || !snapshot) {
    const state = await computeState(portfolio.id);
    nav = state.nav;
    navDate = kathmanduDate();
  }

  const contributed = await prisma.deposit.aggregate({ where: { membershipId, status: 'APPROVED', reviewedAt: { lt: end } }, _sum: { amount: true } });
  const paidOut = await prisma.exitRequest.aggregate({ where: { membershipId, status: 'PAID', paidAt: { lt: end } }, _sum: { payoutAmount: true } });
  const contributedToDate = contributed._sum.amount ?? ZERO;
  const closingValue = closing.mul(nav);
  const totalUnits = totalUnitsAtEnd._sum.units ?? ZERO;

  return {
    portfolio: { id: portfolio.id, name: portfolio.name, type: portfolio.type },
    member: { membershipId, name: membership.user.name, email: membership.user.email, role: membership.role },
    month,
    generatedAt: new Date().toISOString(),
    nav: num6(nav),
    navDate,
    openingUnits: num6(opening),
    closingUnits: num6(closing),
    unitsIssued: num6(issued),
    unitsRedeemed: num6(redeemed),
    closingValue: num(closingValue),
    contributedToDate: num(contributedToDate),
    returnsToDate: num(closingValue.add(paidOut._sum.payoutAmount ?? ZERO).sub(contributedToDate)),
    ownershipPercent: totalUnits.gt(0) ? num(closing.div(totalUnits).mul(100)) : 0,
    deposits: deposits.map((d: Deposit) => ({
      period: d.period,
      amount: num(d.amount),
      status: d.status,
      method: d.method,
      submittedAt: d.submittedAt.toISOString().slice(0, 10),
      receiptNo: d.receiptNo,
      units: d.unitsIssued ? num6(d.unitsIssued) : null,
      nav: d.navAtApproval ? num6(d.navAtApproval) : null,
    })),
    activity: txs.map((t) => ({
      date: t.date.toISOString().slice(0, 10),
      type: t.type,
      asset: t.holding?.name ?? null,
      quantity: t.quantity ? num6(t.quantity) : null,
      price: t.price ? num(t.price) : null,
      amount: t.amount ? num(t.amount) : null,
      note: t.note,
    })),
  };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const rs = (v: number) => `Rs ${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const units = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function table(doc: PDFKit.PDFDocument, headers: string[], rows: string[][], widths: number[]) {
  const x0 = doc.page.margins.left;
  const draw = (cells: string[], bold: boolean) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
    const y = doc.y;
    let x = x0;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    let h = 0;
    cells.forEach((c, i) => {
      doc.text(c, x, y, { width: widths[i]! - 6 });
      h = Math.max(h, doc.y - y);
      x += widths[i]!;
    });
    doc.y = y + h + 4;
    doc.x = x0;
  };
  draw(headers, true);
  doc.moveTo(x0, doc.y - 2).lineTo(x0 + widths.reduce((a, b) => a + b, 0), doc.y - 2).strokeColor('#cccccc').stroke();
  rows.forEach((r) => draw(r, false));
  if (rows.length === 0) doc.font('Helvetica-Oblique').fontSize(8.5).text('None', x0).moveDown(0.5);
}

function renderStatement(doc: PDFKit.PDFDocument, s: StatementData) {
  doc.font('Helvetica-Bold').fontSize(16).text(s.portfolio.name);
  doc.font('Helvetica').fontSize(10).fillColor('#555555').text(`Monthly statement: ${monthLabel(s.month)}`);
  doc.text(`${s.member.name} <${s.member.email}> · ${s.member.role.toLowerCase()}`);
  doc.fillColor('#000000').moveDown();

  const kv: [string, string][] = [
    ['NAV per unit', `${units(s.nav)} (as of ${s.navDate})`],
    ['Opening units', units(s.openingUnits)],
    ['Units issued this month', units(s.unitsIssued)],
    ['Units redeemed this month', units(s.unitsRedeemed)],
    ['Closing units', units(s.closingUnits)],
    ['Ownership', `${s.ownershipPercent.toFixed(2)}%`],
    ['Closing value', rs(s.closingValue)],
    ['Contributed to date', rs(s.contributedToDate)],
    ['Returns to date', rs(s.returnsToDate)],
  ];
  for (const [k, v] of kv) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).text(k, doc.page.margins.left, y, { width: 200 });
    doc.font('Helvetica-Bold').text(v, doc.page.margins.left + 210, y);
  }
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(12).text('Your deposits', doc.page.margins.left).moveDown(0.3);
  table(
    doc,
    ['For month', 'Amount', 'Method', 'Status', 'Receipt', 'Units', 'NAV'],
    s.deposits.map((d) => [d.period, rs(d.amount), d.method, d.status, d.receiptNo ?? '-', d.units !== null ? units(d.units) : '-', d.nav !== null ? units(d.nav) : '-']),
    [65, 85, 55, 65, 75, 80, 70],
  );
  doc.moveDown();
  doc.font('Helvetica-Bold').fontSize(12).text('Portfolio activity', doc.page.margins.left).moveDown(0.3);
  table(
    doc,
    ['Date', 'Type', 'Asset', 'Qty', 'Price / amount', 'Note'],
    s.activity.map((a) => [a.date, a.type.replace('_', ' '), a.asset ?? '-', a.quantity !== null ? String(a.quantity) : '-', a.price !== null ? rs(a.price) : a.amount !== null ? rs(a.amount) : '-', a.note]),
    [60, 65, 90, 50, 85, 145],
  );
  doc.moveDown();
  doc.font('Helvetica').fontSize(7.5).fillColor('#777777')
    .text(`Generated ${s.generatedAt.slice(0, 16).replace('T', ' ')} UTC. Values use the NAV shown above and are not audited.`, doc.page.margins.left);
  doc.fillColor('#000000');
}

function pipePdf(res: Response, fileName: string, render: (doc: PDFKit.PDFDocument) => void) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: fileName } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);
  render(doc);
  doc.end();
}

export function sendStatementPdf(res: Response, statements: StatementData[], fileName: string) {
  pipePdf(res, fileName, (doc) => {
    statements.forEach((s, i) => {
      if (i > 0) doc.addPage();
      renderStatement(doc, s);
    });
  });
}

export function sendReceiptPdf(res: Response, portfolio: Portfolio, memberName: string, d: Deposit) {
  pipePdf(res, `receipt-${d.receiptNo}.pdf`, (doc) => {
    doc.font('Helvetica-Bold').fontSize(16).text(portfolio.name);
    doc.font('Helvetica').fontSize(11).fillColor('#555555').text('Deposit receipt').fillColor('#000000').moveDown();
    const rows: [string, string][] = [
      ['Receipt no.', d.receiptNo ?? '-'],
      ['Member', memberName],
      ['Contribution month', d.period],
      ['Amount', rs(num(d.amount))],
      ['Method', d.method],
      ['Reference', d.reference ?? '-'],
      ['Submitted', d.submittedAt.toISOString().slice(0, 10)],
      ['Approved', d.reviewedAt?.toISOString().slice(0, 10) ?? '-'],
      ['NAV at approval', d.navAtApproval ? units(num6(d.navAtApproval)) : '-'],
      ['Units issued', d.unitsIssued ? units(num6(d.unitsIssued)) : '-'],
    ];
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).text(k, 40, y, { width: 160 });
      doc.font('Helvetica-Bold').text(v, 210, y);
    }
  });
}

export async function sendStatementsXlsx(res: Response, statements: StatementData[], fileName: string) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const summary = wb.addWorksheet('Members');
  summary.columns = [
    { header: 'Member', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Role', key: 'role', width: 10 },
    { header: 'Opening units', key: 'openingUnits', width: 14 },
    { header: 'Units issued', key: 'unitsIssued', width: 13 },
    { header: 'Units redeemed', key: 'unitsRedeemed', width: 14 },
    { header: 'Closing units', key: 'closingUnits', width: 14 },
    { header: 'Ownership %', key: 'ownershipPercent', width: 12 },
    { header: 'NAV', key: 'nav', width: 10 },
    { header: 'Closing value (Rs)', key: 'closingValue', width: 18 },
    { header: 'Contributed to date (Rs)', key: 'contributedToDate', width: 22 },
    { header: 'Returns to date (Rs)', key: 'returnsToDate', width: 18 },
    { header: 'Deposits this month (Rs)', key: 'depositsMonth', width: 22 },
  ];
  summary.getRow(1).font = { bold: true };
  for (const s of statements) {
    summary.addRow({
      name: s.member.name,
      email: s.member.email,
      role: s.member.role,
      openingUnits: s.openingUnits,
      unitsIssued: s.unitsIssued,
      unitsRedeemed: s.unitsRedeemed,
      closingUnits: s.closingUnits,
      ownershipPercent: s.ownershipPercent,
      nav: s.nav,
      closingValue: s.closingValue,
      contributedToDate: s.contributedToDate,
      returnsToDate: s.returnsToDate,
      depositsMonth: s.deposits.filter((d) => d.status === 'APPROVED' && d.period === s.month).reduce((a, d) => a + d.amount, 0),
    });
  }
  const activity = wb.addWorksheet('Activity');
  activity.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Asset', key: 'asset', width: 24 },
    { header: 'Quantity', key: 'quantity', width: 12 },
    { header: 'Price', key: 'price', width: 12 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Note', key: 'note', width: 50 },
  ];
  activity.getRow(1).font = { bold: true };
  for (const a of statements[0]?.activity ?? []) activity.addRow(a);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  await wb.xlsx.write(res);
  res.end();
}
