// Copies the offline libraries (PDF viewer + PPTX/DOCX reader) into www/lib so the app works without internet.
const fs = require("fs"), path = require("path");
const lib = path.join(__dirname, "..", "www", "lib");
fs.mkdirSync(lib, {recursive: true});
const files = [
  ["jszip/dist/jszip.min.js", "jszip.min.js"],
  ["pdfjs-dist/build/pdf.min.js", "pdf.min.js"],
  ["pdfjs-dist/build/pdf.worker.min.js", "pdf.worker.min.js"],
];
for (const [from, to] of files) {
  fs.copyFileSync(require.resolve(from), path.join(lib, to));
  console.log("copied", to);
}
