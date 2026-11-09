# Meesho Label Crop

Static website (no server code). Upload Meesho label PDFs, get a sorted, cropped, print-ready PDF. All processing happens in the browser.

## Run locally
Double-click `start.bat` (needs Node.js) or open a terminal: `node server.js` -> http://localhost:5173

## Publish free on GitHub Pages (works on mobile too)
1. Create a GitHub repo and push this folder (`samples/` is git-ignored on purpose: it contains customer data).
2. Repo -> Settings -> Pages -> Source: "Deploy from a branch", Branch: `main`, Folder: `/public` is not offered, so choose **/ (root)** and
   either move the contents of `public/` to the repo root, or use the included workflow `.github/workflows/pages.yml` (Source: "GitHub Actions").
3. Your link will be `https://<username>.github.io/<repo>/`.
