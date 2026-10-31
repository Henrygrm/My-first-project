/**
 * Cutline ← Google Form connector.
 *
 * What it does:
 *  - setupCutline() makes the "Video request" form with every question Cutline
 *    understands (or uses your own form), and creates a secret connection code.
 *  - Once deployed as a web app, Cutline (on your Mac) asks this script for new
 *    form answers every couple of minutes, using that code. Nobody without the
 *    code can read anything.
 *
 * Setup (Cutline's Requests page walks you through it):
 *  1. script.google.com → New project → delete what's there → paste this file.
 *  2. Pick "setupCutline" in the bar at the top → Run → allow access.
 *  3. Follow the steps printed in the Execution log.
 */

// Already made your own form? Paste its edit link between the quotes before
// running setupCutline. Leave it empty and a new form is made for you.
const EXISTING_FORM_URL = '';

const CHUNK = 5 * 1024 * 1024; // bytes per download piece
const MAX_FILE = 50 * 1024 * 1024; // bigger uploads stay in Google Drive
const MAX_RESPONSES = 20; // per check; Cutline asks again for the rest

function setupCutline() {
  const props = PropertiesService.getScriptProperties();
  let form;
  let made = false;
  if (EXISTING_FORM_URL) form = FormApp.openByUrl(EXISTING_FORM_URL);
  else if (props.getProperty('FORM_ID')) form = FormApp.openById(props.getProperty('FORM_ID'));
  else {
    form = buildForm_();
    made = true;
  }
  props.setProperty('FORM_ID', form.getId());
  let key = props.getProperty('CUTLINE_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('CUTLINE_KEY', key);
  }
  const lines = [
    '',
    '===== CUTLINE SETUP =====',
    made ? 'Your new form is ready. Edit it here: ' + form.getEditUrl() : 'Using your form: ' + form.getEditUrl(),
    'Link to send to clients: ' + form.getPublishedUrl(),
    '',
    'YOUR CONNECTION CODE (paste into Cutline): ' + key,
    '',
    'Next:',
    made ? '1. Open the form link above. In the section "Your photos and logo", click + and add 3 "File upload" questions:\n' +
      '     "Upload your logo" (1 file, images)\n' +
      '     "Upload photos of your products, food, work or shop" (up to 10 files, images)\n' +
      '     "Got any video clips you\'d like included?" (videos)\n' +
      '   (Google can\'t add upload questions automatically.)' : '1. Make sure your form has its questions (see the list in Cutline).',
    '2. Here in Apps Script: Deploy → New deployment → gear icon → Web app.',
    '   Execute as: Me.   Who has access: Anyone.   Click Deploy and copy the Web app URL.',
    '3. In Cutline → Requests: paste the Web app URL and the connection code, then click Save and Check now.',
    '=========================',
  ];
  Logger.log(lines.join('\n'));
}

/** Called by Cutline. Every request must carry the connection code. */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const key = PropertiesService.getScriptProperties().getProperty('CUTLINE_KEY');
    if (!key || p.key !== key) return out_({ error: 'The connection code is wrong. Copy it again from the Apps Script log (run setupCutline).' });
    const form = form_();
    if (p.file) return out_(filePiece_(form, p.response, p.file, Number(p.offset) || 0));
    const since = Number(p.since) || 0;
    const all = since ? form.getResponses(new Date(since)) : form.getResponses();
    all.sort(function (a, b) { return a.getTimestamp().getTime() - b.getTimestamp().getTime(); });
    return out_({
      ok: true,
      version: 1,
      form: { title: form.getTitle(), url: form.getPublishedUrl() },
      responses: all.slice(0, MAX_RESPONSES).map(response_),
      more: all.length > MAX_RESPONSES,
    });
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

function form_() {
  const id = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (id) return FormApp.openById(id);
  let active = null;
  try { active = FormApp.getActiveForm(); } catch (err) {}
  if (active) return active;
  throw new Error('No form is linked yet. Run setupCutline in Apps Script first.');
}

function response_(r) {
  let email = '';
  try { email = r.getRespondentEmail() || ''; } catch (err) {}
  return {
    id: r.getId(),
    time: r.getTimestamp().getTime(),
    email: email,
    answers: r.getItemResponses().map(function (ir) {
      const item = ir.getItem();
      const type = String(item.getType());
      let answer = ir.getResponse();
      if (type === 'FILE_UPLOAD') answer = (answer || []).map(fileInfo_);
      return { title: item.getTitle(), type: type, answer: answer };
    }),
  };
}

function fileInfo_(id) {
  try {
    const f = DriveApp.getFileById(id);
    return { id: id, name: f.getName(), size: f.getSize(), type: f.getMimeType() };
  } catch (err) {
    return { id: id, name: '', size: 0, type: '', error: String((err && err.message) || err) };
  }
}

/** One piece of an uploaded file, only if it belongs to that form answer. */
function filePiece_(form, responseId, fileId, offset) {
  const r = form.getResponse(String(responseId || ''));
  const ids = [];
  r.getItemResponses().forEach(function (ir) {
    if (String(ir.getItem().getType()) === 'FILE_UPLOAD') (ir.getResponse() || []).forEach(function (x) { ids.push(x); });
  });
  if (ids.indexOf(fileId) < 0) return { error: 'That file is not part of this form answer.' };
  const f = DriveApp.getFileById(fileId);
  const size = f.getSize();
  if (size > MAX_FILE) return { error: 'File is too big to fetch automatically.', size: size };
  const bytes = f.getBlob().getBytes();
  const piece = bytes.slice(offset, offset + CHUNK);
  return {
    ok: true, name: f.getName(), type: f.getMimeType(), size: size, offset: offset,
    data: Utilities.base64Encode(piece), done: offset + piece.length >= size,
  };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** The "Video request" form. Cutline matches answers by these question titles. */
function buildForm_() {
  const form = FormApp.create('Video request');
  form.setDescription('Thanks for choosing us! Please fill this in for each video you\'d like. It takes about 5 minutes. The more detail and photos you give, the better your video will be.');
  try { form.setCollectEmail(true); } catch (err) {}
  const notSure = 'Not sure, you decide';

  form.addSectionHeaderItem().setTitle('About your business');
  form.addTextItem().setTitle('Business name').setRequired(true);
  form.addMultipleChoiceItem().setTitle('What type of business are you?').setRequired(true)
    .setChoiceValues(['Restaurant', 'Café & coffee', 'Car detailing', 'Trades (plumber, electrician, builder)', 'Barber & hair salon', 'Gym & personal training'])
    .showOtherOption(true);
  form.addParagraphTextItem().setTitle('What do you sell or offer?').setHelpText('List your main products or services, e.g. "Flat whites, smashed avo, house-made banana bread"').setRequired(true);
  form.addTextItem().setTitle('Suburb / city').setRequired(true);
  form.addTextItem().setTitle('What should customers use to contact you?').setHelpText('Phone, website or social handle');

  form.addPageBreakItem().setTitle('This video');
  form.addMultipleChoiceItem().setTitle('What\'s the main goal of this video?').setRequired(true)
    .setChoiceValues(['Get more bookings / orders', 'Promote a special offer', 'Show off our work / products', 'Build trust (quality, reviews)', 'Bring in local customers', notSure]);
  form.addTextItem().setTitle('Do you have an offer or deal to promote?').setHelpText('e.g. "20% off this week", "Free coffee with any breakfast"');
  form.addTextItem().setTitle('Which product or service should this video focus on?');
  form.addMultipleChoiceItem().setTitle('What should viewers do at the end?')
    .setChoiceValues(['Call us', 'Book online', 'Visit us', 'Order now', 'Follow us']).showOtherOption(true);

  form.addPageBreakItem().setTitle('Where it will be posted');
  form.addCheckboxItem().setTitle('Where will you post this video?').setRequired(true)
    .setChoiceValues(['TikTok', 'Instagram Reels / Stories', 'Instagram / Facebook feed', 'YouTube Shorts', 'YouTube / website', 'Not sure']);
  form.addMultipleChoiceItem().setTitle('How long should the video be?').setRequired(true)
    .setChoiceValues(['10 seconds', '15 seconds (most popular)', '20 seconds', '30 seconds', notSure]);

  form.addPageBreakItem().setTitle('Look and feel');
  form.addMultipleChoiceItem().setTitle('What style suits your brand best?')
    .setChoiceValues(['Cinematic: dramatic, movie-like', 'Luxury: elegant, high-end', 'Minimalist: clean and simple', 'Modern: bold and futuristic', 'Energetic: fast and exciting', 'Editorial: magazine style', 'Commercial: polished and professional', 'Playful: fun and colourful', 'Premium: sleek and classy', 'Industrial: tough and rugged', notSure]);
  form.addTextItem().setTitle('What are your brand colours?').setHelpText('Names or colour codes are fine, e.g. "Navy and gold" or "#1A2B3C"');
  form.addParagraphTextItem().setTitle('Any videos or brands whose style you love?').setHelpText('Paste links');

  form.addPageBreakItem().setTitle('Sound');
  form.addMultipleChoiceItem().setTitle('What kind of music do you want?')
    .setChoiceValues(['Upbeat / energetic', 'Chill / relaxed', 'Cinematic / dramatic', 'Elegant / classy', 'You decide']);
  form.addMultipleChoiceItem().setTitle('Would you like a voiceover?').setHelpText('A voice reading out the key message')
    .setChoiceValues(['Yes, a deep voice', 'Yes, a warm, friendly voice', 'Yes, an energetic voice', 'No, music only']);

  form.addPageBreakItem().setTitle('Your photos and logo')
    .setHelpText('Clear, well-lit, high-quality photos work best. Please avoid screenshots or blurry pictures.');

  form.addPageBreakItem().setTitle('Words and trust');
  form.addParagraphTextItem().setTitle('Paste a real customer review we can feature').setHelpText('Include the customer\'s first name if you can');
  form.addParagraphTextItem().setTitle('Any must-say details?').setHelpText('e.g. "Open 7 days", "Family owned since 1998", "Mobile service"');
  form.addParagraphTextItem().setTitle('Is there anything we must NOT show or say?');

  form.addPageBreakItem().setTitle('Final details');
  form.addDateItem().setTitle('When do you need the video by?');
  form.addMultipleChoiceItem().setTitle('How many versions would you like to choose from?').setChoiceValues(['1', '2', '3']);
  form.addParagraphTextItem().setTitle('Anything else we should know?');
  return form;
}
