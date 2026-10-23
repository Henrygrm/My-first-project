#!/bin/bash
# Double-click this file in Finder to start Cutline.
# It stops any old copy, gets the latest version, and opens the site.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo ""
echo "  Stopping any old copy of Cutline…"
lsof -ti tcp:3000 | xargs kill 2>/dev/null
sleep 1

echo "  Getting the latest version…"
git checkout -- package-lock.json 2>/dev/null
if ! git pull --ff-only; then
  echo "  (Couldn't download updates. Starting the version you already have.)"
fi

echo "  Installing anything new…"
npm install --no-audit --no-fund || { echo "  npm install failed. See the message above."; read -r -p "  Press Enter to close."; exit 1; }

(sleep 4; open "http://127.0.0.1:3000") &
echo ""
echo "  Leave this window open while you use Cutline. Close it to stop Cutline."
npm start
