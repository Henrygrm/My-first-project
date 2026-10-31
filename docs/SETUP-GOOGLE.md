# Connecting your Google Form and Gmail

Cutline talks to Google through a small script that runs inside **your own** Google account. You authorise it with Google's normal sign-in screen, so Cutline never sees your password. Only you have the secret connection code that lets Cutline use it.

It does four things:

1. Reads new answers from your existing Google Form, including uploaded files. It never changes your form.
2. Saves approved videos to your Google Drive, in a folder called **Cutline videos**, as view-only links.
3. Sends client emails from your Gmail, but **only** when you click **Approve & Send** in Cutline.
4. Reads client replies to those emails, so feedback lands in the right project.

## First-time setup (about 5 minutes)

1. In Cutline, go to **Client Onboarding** and click **Copy the Google script**.
2. Open **your form** in Google Forms. Click the **⋮** menu (top right), then **Apps Script**.
3. Delete everything in the editor, paste the script, and click the save icon.
4. At the top, choose **setupCutline** and click **Run**. Sign in with Google and allow access.
   - If Google says *"Google hasn't verified this app"*, click **Advanced**, then **Go to … (unsafe)**. It's your own script, so this is safe.
   - The permissions include Gmail. That's what lets it send your approved emails and read client replies.
5. The **Execution log** at the bottom shows your **connection code** (a long string of letters and numbers). Copy it.
6. Click **Deploy**, then **New deployment**, then the gear icon, then **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**. The code still protects it; without the code it refuses every request.
   - Click **Deploy** and copy the **Web app URL**.
7. Back in Cutline (**Client Onboarding**), paste the URL and the code, then click **Save and connect**.

Cutline then checks for new submissions and replies every 2 minutes while it's open.

## Updating the script later

When Cutline says *"Update your Google script"*:

1. Copy the new script from Cutline.
2. Open your form, then **⋮**, then **Apps Script**. Select all, paste over it, and save.
3. Run **setupCutline** again and allow any new permission. Your connection code stays the same.
4. Click **Deploy**, then **Manage deployments**, then the pencil icon. Set Version to **New version** and click **Deploy**. The URL stays the same.

## Tips for your form

- Cutline understands answers by their question titles. Clear titles work best, for example:
  - "Business name", "Your name", "Email", "What do you sell?"
  - "Suburb", "Who are your customers?", "Main goal", "Where will you post it?"
  - "How long?", "Style", "Brand colours", "Music", "Voiceover"
  - "Anything we must NOT show?"
- Give **File upload** questions titles that say what they hold, like "Logo", "Photos" or "Video clips", so files are sorted correctly.
- Collecting respondents' email addresses (in the form's Settings) gives Cutline the client's address automatically.
- People must sign in to Google to upload files. Google requires this.

## Limits

- Cutline must be **open on your Mac** to check for submissions and replies. Anything sent while it's closed is picked up the next time you open it.
- Personal Gmail accounts can send about **100 emails a day** through a script.
- Uploads larger than **50 MB** stay in your Google Drive and aren't downloaded. The project notes say when this happens.
