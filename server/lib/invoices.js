// Invoices: prepared automatically when a client's video is approved, issued
// when the delivery email is sent, and voided (never charged) if the client
// declines. Nothing is ever marked paid automatically.
import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { DATA_DIR, newId } from './store.js';
import { getBusiness, LOGO_FILE, takeNumber } from './business.js';

const FILE = path.join(DATA_DIR, 'invoices.json');
let lock = Promise.resolve();

async function readAll() {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function withInvoices(mutate) {
  const run = lock.then(async () => {
    const list = await readAll();
    const out = await mutate(list);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await fs.rename(tmp, FILE);
    return out;
  });
  lock = run.catch(() => {});
  return run;
}

const round = (n) => Math.round(n * 100) / 100;

/** Subtotal, tax and total from the items and the tax setting. */
export function totals(inv) {
  const sum = round(inv.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0));
  const rate = (Number(inv.taxRate) || 0) / 100;
  if (inv.taxMode === 'exclusive') return { subtotal: sum, tax: round(sum * rate), total: round(sum * (1 + rate)) };
  if (inv.taxMode === 'inclusive') return { subtotal: round(sum / (1 + rate)), tax: round(sum - sum / (1 + rate)), total: sum };
  return { subtotal: sum, tax: 0, total: sum };
}

const fill = (t, vars) => String(t).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export async function listInvoices() {
  return (await readAll()).map((i) => ({ ...i, ...totals(i) })).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getInvoice(id) {
  const inv = (await readAll()).find((i) => i.id === id);
  return inv ? { ...inv, ...totals(inv) } : null;
}

/** A draft invoice for a client project (price from Settings). */
export async function createInvoice({ cpId, cpNumber, businessName, contactName, email, extraFormats = 0 }) {
  const b = await getBusiness();
  const n = await takeNumber('nextInvoice');
  const now = Date.now();
  const items = [{ description: fill(b.serviceDescription, { business_name: businessName }), qty: 1, unitPrice: b.price }];
  if (extraFormats && b.extraFormatPrice) items.push({ description: 'Extra video size (another platform format)', qty: extraFormats, unitPrice: b.extraFormatPrice });
  const inv = {
    id: newId('inv'), number: `${b.invoicePrefix}${String(n).padStart(4, '0')}`, cpId, cpNumber,
    client: { business: businessName, name: contactName || '', email: email || '' },
    from: { name: b.name, contactName: b.contactName, email: b.email, phone: b.phone, website: b.website, address: b.address, abn: b.abn },
    items, currency: b.currency, taxMode: b.taxMode, taxRate: b.taxRate,
    paymentDetails: b.paymentDetails, notes: b.invoiceNotes,
    date: now, dueDate: now + b.paymentTerms * 86400_000, paymentTerms: b.paymentTerms,
    status: 'draft', createdAt: now, history: [{ t: now, text: 'Prepared' }],
  };
  await withInvoices((list) => list.push(inv));
  return { ...inv, ...totals(inv) };
}

function change(id, mutate) {
  return withInvoices((list) => {
    const inv = list.find((i) => i.id === id);
    if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
    mutate(inv);
    return { ...inv, ...totals(inv) };
  });
}

/** Edit while it has not been sent (price, description, client details). */
export function editInvoice(id, b = {}) {
  return change(id, (inv) => {
    if (inv.status !== 'draft') throw Object.assign(new Error('This invoice has already been sent. Void it and prepare a new one to change it.'), { status: 409 });
    if (Array.isArray(b.items) && b.items.length) {
      inv.items = b.items.slice(0, 10).map((it) => ({
        description: String(it.description || '').slice(0, 200) || 'Video',
        qty: Math.max(0, Math.min(1000, Number(it.qty) || 0)),
        unitPrice: Math.max(0, Math.min(100000, round(Number(it.unitPrice) || 0))),
      }));
    }
    if (typeof b.notes === 'string') inv.notes = b.notes.slice(0, 300);
    if (b.client && typeof b.client === 'object') {
      for (const k of ['business', 'name', 'email']) if (typeof b.client[k] === 'string') inv.client[k] = b.client[k].slice(0, 120);
    }
    inv.history.push({ t: Date.now(), text: 'Edited' });
  });
}

/** Refresh the "from" details and payment info from Settings (drafts only). */
export async function refreshDraft(id) {
  const b = await getBusiness();
  return change(id, (inv) => {
    if (inv.status !== 'draft') return;
    inv.from = { name: b.name, contactName: b.contactName, email: b.email, phone: b.phone, website: b.website, address: b.address, abn: b.abn };
    inv.paymentDetails = b.paymentDetails;
    inv.currency = b.currency;
    inv.taxMode = b.taxMode;
    inv.taxRate = b.taxRate;
    if (inv.items.length === 1 && !inv.items[0].unitPrice && b.price) inv.items[0].unitPrice = b.price;
  });
}

export const issueInvoice = (id) => change(id, (inv) => {
  if (inv.status === 'draft') {
    inv.status = 'issued';
    inv.issuedAt = Date.now();
    inv.history.push({ t: Date.now(), text: 'Sent to the client' });
  }
});

export const markPaid = (id) => change(id, (inv) => {
  if (inv.status === 'void') throw Object.assign(new Error('A voided invoice cannot be paid.'), { status: 409 });
  inv.status = 'paid';
  inv.paidAt = Date.now();
  inv.history.push({ t: Date.now(), text: 'Marked as paid' });
});

export const markUnpaid = (id) => change(id, (inv) => {
  if (inv.status !== 'paid') return;
  inv.status = inv.issuedAt ? 'issued' : 'draft';
  inv.paidAt = null;
  inv.history.push({ t: Date.now(), text: 'Marked as not paid' });
});

/** Cancel: the client is not charged. */
export const voidInvoice = (id, reason = '') => change(id, (inv) => {
  if (inv.status === 'void') return;
  if (inv.status === 'paid') throw Object.assign(new Error('This invoice is marked paid. Mark it unpaid (and refund the client) before voiding it.'), { status: 409 });
  inv.status = 'void';
  inv.voidedAt = Date.now();
  inv.voidReason = String(reason).slice(0, 300);
  inv.history.push({ t: Date.now(), text: `Voided${reason ? `: ${reason}` : ''} (no charge)` });
});

/** Restore a voided invoice (e.g. a decline was undone). */
export const unvoidInvoice = (id) => change(id, (inv) => {
  if (inv.status !== 'void') return;
  inv.status = inv.issuedAt ? 'issued' : 'draft';
  inv.voidReason = '';
  inv.history.push({ t: Date.now(), text: 'Restored' });
});

const money = (n, cur) => {
  try {
    return new Intl.NumberFormat('en-AU', { style: 'currency', currency: cur || 'AUD' }).format(n);
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
};
const day = (t) => new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

/** The invoice as a PDF (Buffer). */
export async function invoicePdf(id) {
  const inv = await getInvoice(id);
  if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  const hasLogo = await fs.access(LOGO_FILE).then(() => true, () => false);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.number}`, Author: inv.from.name || 'Cutline' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', r));
  const navy = '#0f1b2d', grey = '#5b6678', blue = '#2563eb', line = '#e4e8ef';
  const W = doc.page.width - 100;

  // Header
  let y = 50;
  if (hasLogo) {
    try {
      doc.image(LOGO_FILE, 50, y, { fit: [120, 60] });
    } catch {}
  }
  const title = inv.taxMode === 'none' ? 'INVOICE' : 'TAX INVOICE';
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(24).text(inv.status === 'void' ? `${title} (VOID)` : title, 50, y, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(grey)
    .text(inv.number, 50, y + 34, { width: W, align: 'right' })
    .text(`Date: ${day(inv.date)}`, { width: W, align: 'right' })
    .text(`Due: ${day(inv.dueDate)}`, { width: W, align: 'right' });
  y = 150;

  // From / To
  const f = inv.from;
  doc.fillColor(blue).font('Helvetica-Bold').fontSize(9).text('FROM', 50, y);
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text(f.name || 'Your business name (set it in Settings)', 50, y + 14, { width: W / 2 - 10 });
  doc.font('Helvetica').fontSize(10).fillColor(grey);
  for (const l of [f.contactName, f.address, f.email, f.phone, f.website, f.abn ? `ABN ${f.abn}` : '']) if (l) doc.text(l, { width: W / 2 - 10 });
  const fromEnd = doc.y;
  doc.fillColor(blue).font('Helvetica-Bold').fontSize(9).text('BILL TO', 50 + W / 2, y);
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text(inv.client.business || 'Client', 50 + W / 2, y + 14, { width: W / 2 });
  doc.font('Helvetica').fontSize(10).fillColor(grey);
  for (const l of [inv.client.name, inv.client.email]) if (l) doc.text(l, { width: W / 2 });
  y = Math.max(fromEnd, doc.y) + 30;

  // Items
  const cols = [50, 330, 390, 470];
  doc.rect(50, y, W, 24).fill('#f3f6fa');
  doc.fillColor(grey).font('Helvetica-Bold').fontSize(9);
  doc.text('DESCRIPTION', cols[0] + 8, y + 8).text('QTY', cols[1], y + 8, { width: 50, align: 'right' }).text('PRICE', cols[2], y + 8, { width: 70, align: 'right' }).text('AMOUNT', cols[3], y + 8, { width: W + 50 - cols[3] - 8, align: 'right' });
  y += 32;
  doc.font('Helvetica').fontSize(10).fillColor(navy);
  for (const it of inv.items) {
    const h = doc.heightOfString(it.description, { width: 260 });
    doc.text(it.description, cols[0] + 8, y, { width: 260 });
    doc.text(String(it.qty), cols[1], y, { width: 50, align: 'right' });
    doc.text(money(it.unitPrice, inv.currency), cols[2], y, { width: 70, align: 'right' });
    doc.text(money(it.qty * it.unitPrice, inv.currency), cols[3], y, { width: W + 50 - cols[3] - 8, align: 'right' });
    y += Math.max(h, 14) + 10;
    doc.moveTo(50, y - 4).lineTo(50 + W, y - 4).strokeColor(line).lineWidth(1).stroke();
  }

  // Totals
  y += 6;
  const row = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? navy : grey);
    doc.text(label, 330, y, { width: 120, align: 'right' }).text(value, 450, y, { width: W + 50 - 450 - 8, align: 'right' });
    y += bold ? 22 : 16;
  };
  if (inv.taxMode !== 'none') {
    row(inv.taxMode === 'inclusive' ? 'Subtotal (excl. GST)' : 'Subtotal', money(inv.subtotal, inv.currency));
    row(`GST (${inv.taxRate}%)`, money(inv.tax, inv.currency));
  }
  doc.rect(330, y - 4, W + 50 - 330, 30).fill('#eaf1fe');
  y += 4;
  row(`Total ${inv.currency}`, money(inv.total, inv.currency), true);
  y += 20;

  if (inv.status === 'void') {
    doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(11).text(`This invoice has been cancelled. No payment is due.${inv.voidReason ? ` (${inv.voidReason})` : ''}`, 50, y, { width: W });
    y = doc.y + 14;
  } else if (inv.status === 'paid') {
    doc.fillColor('#16a34a').font('Helvetica-Bold').fontSize(11).text(`Paid on ${day(inv.paidAt)}. Thank you!`, 50, y, { width: W });
    y = doc.y + 14;
  }
  if (inv.paymentDetails && inv.status !== 'void') {
    doc.fillColor(blue).font('Helvetica-Bold').fontSize(9).text('PAYMENT DETAILS', 50, y);
    doc.fillColor(navy).font('Helvetica').fontSize(10).text(inv.paymentDetails, 50, y + 14, { width: W });
    doc.fillColor(grey).fontSize(9).text(`Please use ${inv.number} as the payment reference. Payment is due within ${inv.paymentTerms} days.`, { width: W });
    y = doc.y + 16;
  }
  if (inv.notes) doc.fillColor(grey).font('Helvetica').fontSize(10).text(inv.notes, 50, y, { width: W });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
