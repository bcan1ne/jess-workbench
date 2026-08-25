# pdf.js — vendored

`pdfjs-dist` 4.10.38, Apache-2.0, Mozilla. Unmodified build output.

Only `pdf.min.mjs` and `pdf.worker.min.mjs` are kept — the sandbox build and the
source maps are not needed to read text out of a résumé.

Vendored rather than loaded from a CDN so the page keeps no third-party runtime
dependency, and **loaded only when someone actually picks a PDF**, so the 1.7MB
never costs anything on a normal visit.

Why a real library rather than a small hand-written parser: résumé PDFs use
TrueType fonts with ToUnicode CMaps, and getting that wrong does not throw — it
silently yields garbled text, which would then be sent to Claude as if it were a
résumé. That failure mode is worse than the bytes.

Verified against a real résumé: 694 words extracted, zero garbled characters,
line breaks preserved.
