// The owner's business details, pricing, invoice settings and email templates
// (Settings page). Used by invoices and client emails.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const FILE = path.join(DATA_DIR, 'business.json');
export const LOGO_FILE = path.join(DATA_DIR, 'business-logo.png');

export const DEFAULT_TEMPLATES = {
  deliverySubject: 'Your New Business Video Is Ready!',
  deliveryBody: `Hi {client_name},

We've finished creating your video for {business_name}!

We've put together your video using the information and resources you provided, and we're excited for you to see the result.

You can view your completed video here:

{video_link}

We've also attached your invoice for the completed project.

If there is anything you'd like changed, simply reply to this email and let us know what you'd like adjusted. We're happy to review your feedback and make improvements.

If you decide that the video isn't quite what you're looking for and don't wish to proceed, that's completely fine too. In that situation, there will be no charge.

Thanks again for giving us the opportunity to work with your business!

Kind regards,
{my_business}`,
  revisionSubject: 'Your updated video for {business_name}',
  revisionBody: `Hi {client_name},

Thanks so much for your feedback! We've made the changes you asked for, and your updated video for {business_name} is ready.

You can view the new version here:

{video_link}

We've attached your invoice again for reference. Nothing has changed there.

If you'd like anything else adjusted, just reply to this email and let us know. And as before, if you decide not to go ahead, there's no charge.

Kind regards,
{my_business}`,
};

const DEFAULTS = {
  name: '', contactName: '', email: '', phone: '', website: '', address: '', abn: '',
  currency: 'AUD', price: 0, extraFormatPrice: 0, serviceDescription: 'Custom marketing video for {business_name}',
  taxMode: 'none', taxRate: 10, paymentTerms: 7, paymentDetails: '', invoicePrefix: 'INV-', invoiceNotes: 'Thank you for your business!',
  nextInvoice: 1, nextProject: 1, hasLogo: false,
  templates: DEFAULT_TEMPLATES,
};

let cache = null;
let lock = Promise.resolve();

export async function getBusiness() {
  if (!cache) {
    let saved = {};
    try {
      saved = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch {}
    cache = { ...DEFAULTS, ...saved, templates: { ...DEFAULT_TEMPLATES, ...(saved.templates || {}) } };
  }
  return structuredClone(cache);
}

async function write(b) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(b, null, 2), { mode: 0o600 });
  await fs.rename(tmp, FILE);
  cache = b;
}

function update(mutate) {
  const run = lock.then(async () => {
    const b = await getBusiness();
    const out = await mutate(b);
    await write(b);
    return out ?? b;
  });
  lock = run.catch(() => {});
  return run;
}

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round((Number(v) || 0) * 100) / 100));

export function saveBusiness(b = {}) {
  return update((cur) => {
    for (const [k, n] of [['name', 80], ['contactName', 80], ['email', 120], ['phone', 40], ['website', 120], ['address', 300], ['abn', 40], ['serviceDescription', 200], ['paymentDetails', 600], ['invoiceNotes', 300]]) {
      if (b[k] !== undefined) cur[k] = str(b[k], n);
    }
    if (b.currency !== undefined) cur.currency = /^[A-Z]{3}$/.test(b.currency) ? b.currency : 'AUD';
    if (b.price !== undefined) cur.price = num(b.price, 0, 100000);
    if (b.extraFormatPrice !== undefined) cur.extraFormatPrice = num(b.extraFormatPrice, 0, 100000);
    if (b.taxMode !== undefined) cur.taxMode = ['none', 'inclusive', 'exclusive'].includes(b.taxMode) ? b.taxMode : 'none';
    if (b.taxRate !== undefined) cur.taxRate = num(b.taxRate, 0, 50);
    if (b.paymentTerms !== undefined) cur.paymentTerms = Math.round(num(b.paymentTerms, 0, 120));
    if (b.invoicePrefix !== undefined) cur.invoicePrefix = str(b.invoicePrefix, 12).replace(/[^\w-]/g, '') || 'INV-';
    if (b.nextInvoice !== undefined && Number(b.nextInvoice) >= cur.nextInvoice) cur.nextInvoice = Math.round(num(b.nextInvoice, 1, 999999));
    if (b.templates && typeof b.templates === 'object') {
      for (const k of Object.keys(DEFAULT_TEMPLATES)) {
        if (typeof b.templates[k] === 'string') cur.templates[k] = b.templates[k].slice(0, 6000).trim() || DEFAULT_TEMPLATES[k];
      }
    }
  });
}

export async function setLogo(hasLogo) {
  return update((b) => {
    b.hasLogo = hasLogo;
  });
}

/** Next number in a sequence ('nextInvoice' or 'nextProject'), reserved atomically. */
export function takeNumber(key) {
  return update((b) => {
    const n = b[key] || 1;
    b[key] = n + 1;
    return n;
  });
}

/** Missing details that would make an invoice or email look unfinished. */
export function businessGaps(b) {
  const gaps = [];
  if (!b.name) gaps.push('your business name');
  if (!b.price) gaps.push('your video price');
  if (!b.paymentDetails) gaps.push('how clients pay you (payment details)');
  return gaps;
}
