/**
 * Builds the Cutline client video form in your Google account, with every
 * question worded the way Cutline understands.
 *
 * How to use:
 *  1. Go to script.google.com → New project. Delete what's there, paste this.
 *  2. Click save, then Run (function: buildCutlineForm). Allow access.
 *  3. Open the link printed in the Execution log and add the 3 File upload
 *     questions it lists (Google doesn't let scripts create upload questions).
 * Run it once: each run adds the questions again.
 */

// Already made a form? Paste its EDIT link between the quotes (the address
// you see while editing it, ending in /edit) and the questions are added to
// that form. Leave it empty to make a brand-new form called "Client Video Brief".
const ADD_TO_FORM_URL = '';

function buildCutlineForm() {
  const existing = Boolean(ADD_TO_FORM_URL);
  const form = existing ? FormApp.openByUrl(ADD_TO_FORM_URL) : FormApp.create('Client Video Brief');
  if (!existing) form.setDescription("Thanks for choosing us! Please fill this in for each video you'd like. It takes about 5 minutes. The more detail and the better your photos and clips, the better your video will be.");
  try { form.setCollectEmail(true); } catch (err) {}
  form.setProgressBar(true);
  const notSure = 'Not sure, you decide';
  const text = (t, help, req) => { const q = form.addTextItem().setTitle(t).setRequired(Boolean(req)); if (help) q.setHelpText(help); return q; };
  const para = (t, help, req) => { const q = form.addParagraphTextItem().setTitle(t).setRequired(Boolean(req)); if (help) q.setHelpText(help); return q; };
  const choice = (t, options, req, other) => { const q = form.addMultipleChoiceItem().setTitle(t).setChoiceValues(options).setRequired(Boolean(req)); if (other) q.showOtherOption(true); return q; };

  // 1. About your business
  if (existing) form.addPageBreakItem().setTitle('About your business');
  else form.addSectionHeaderItem().setTitle('About your business');
  text('Business name', '', true);
  text('Your name', '', true);
  text('Phone number, website or social handle', 'e.g. 0400 000 000, yourbusiness.com.au or @yourbusiness');
  choice('What type of business are you?', ['Restaurant / takeaway', 'Café & coffee', 'Car detailing', 'Trades (plumber, electrician, builder)', 'Barber & hair salon', 'Gym & personal training'], true, true);
  text('Suburb / city', '', true);
  para('What do you sell or offer?', 'List your main products or services.', true);
  para('Tell us about your business', 'Your story, what makes you different, and your menu or price list (paste it here as text).');
  text('Who are your ideal customers?', 'e.g. local families, tradies, busy professionals');

  // 2. This video
  form.addPageBreakItem().setTitle('This video');
  choice("What's the main goal of this video?", ['Get more bookings / orders', 'Promote a special offer', 'Show off our work / products', 'Build trust (quality, reviews)', 'Bring in local customers', notSure], true);
  text('Which product or service should this video focus on?');
  text('Do you have an offer or deal to promote?', 'e.g. "20% off this week", "Free coffee with any breakfast"');
  choice('What should viewers do at the end?', ['Call us', 'Book online', 'Visit us', 'Order now', 'Follow us'], false, true);
  para('Any must-say details?', 'e.g. "Open 7 days", "Family owned since 1998", "Mobile service"');
  para('Is there anything we must NOT show or say?');
  para('Paste a real customer review we can feature', "Include the customer's first name if you can.");

  // 3. Where and how long
  form.addPageBreakItem().setTitle('Where and how long');
  form.addCheckboxItem().setTitle('Where will you post this video?').setRequired(true)
    .setChoiceValues(['TikTok', 'Instagram Reels / Stories', 'Instagram / Facebook feed', 'YouTube Shorts', 'YouTube / website', 'Not sure']);
  choice('How long should the video be?', ['10 seconds', '15 seconds (most popular)', '20 seconds', '30 seconds', notSure], true);
  choice('How many versions would you like to choose from?', ['1', '2', '3']);

  // 4. Look and sound
  form.addPageBreakItem().setTitle('Look and sound');
  choice('What style suits your brand best?', ['Cinematic: dramatic, movie-like', 'Luxury: elegant, high-end', 'Minimalist: clean and simple', 'Modern: bold and futuristic', 'Energetic: fast and exciting', 'Editorial: magazine style', 'Commercial: polished and professional', 'Playful: fun and colourful', 'Premium: sleek and classy', 'Industrial: tough and rugged', notSure]);
  text('What are your brand colours?', 'Names or colour codes are fine, e.g. "Navy and gold" or "#1A2B3C"');
  para('Any videos or brands whose style you love?', 'Paste links.');
  choice('What kind of music do you want?', ['Upbeat / energetic', 'Chill / relaxed', 'Cinematic / dramatic', 'Elegant / classy', 'You decide']);
  choice('Would you like a voiceover?', ['Yes, a deep voice', 'Yes, a warm, friendly voice', 'Yes, an energetic voice', 'No, music only']);

  // 5. Files (upload questions are added by hand; see the log)
  form.addPageBreakItem().setTitle('Your logo, photos and clips')
    .setHelpText('Clear, well-lit photos and real clips of your products or work make the biggest difference. Please avoid screenshots or blurry pictures.');

  // 6. Final details
  form.addPageBreakItem().setTitle('Final details');
  form.addDateItem().setTitle('When do you need the video by?');
  para('Anything else we should know?');

  Logger.log([
    '',
    existing ? '===== QUESTIONS ADDED TO YOUR FORM =====' : '===== YOUR FORM IS READY =====',
    'Edit it here: ' + form.getEditUrl(),
    '',
    'Last step: open that link, go to the section "Your logo, photos and clips",',
    'click + (Add question) and choose "File upload" for each of these 3 questions:',
    '  1. Upload your logo                          (1 file, Image)',
    '  2. Upload photos of your products, food, work or shop   (up to 10 files, Image, 10 MB)',
    '  3. Upload video clips (e.g. cooking, before-and-after, work in progress)   (up to 5 files, Video, 100 MB)',
    'Use those titles exactly so Cutline sorts the files correctly.',
    '',
    'Then connect it to Cutline: in the form, ⋮ menu → Apps Script → paste the',
    'Cutline script (Client Onboarding → Copy the Google script) → run setupCutline.',
    '==============================',
  ].join('\n'));
}
