// src/export.js — CSV + Excel (.xlsx) export of access requests.
import ExcelJS from 'exceljs';

const COLUMNS = [
  { header: 'ID', key: 'id', width: 6 },
  { header: 'Full Name', key: 'fullName', width: 22 },
  { header: 'Company', key: 'companyName', width: 22 },
  { header: 'Email', key: 'email', width: 28 },
  { header: 'Phone', key: 'phone', width: 16 },
  { header: 'Message', key: 'message', width: 40 },
  { header: 'Status', key: 'status', width: 12 },
  { header: 'IP', key: 'ip', width: 16 },
  { header: 'Country', key: 'country', width: 10 },
  { header: 'Created At', key: 'createdAt', width: 22 },
  { header: 'Approved At', key: 'approvedAt', width: 22 },
];

export function toCSV(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = COLUMNS.map((c) => c.header).join(',');
  const body = rows
    .map((r) => COLUMNS.map((c) => esc(r[c.key])).join(','))
    .join('\n');
  return head + '\n' + body;
}

export async function toXLSX(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Access Requests');
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}
