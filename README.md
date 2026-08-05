# CDP Compliance Dashboard (Netlify)

Live, read-only port of the Pulse `CdpComplianceController` Executive UI.
Static HTML + a Netlify Function that queries the Bonito Postgres **read replica**.
Same stack as dm-review-dashboard.netlify.app.

## What ported and what didn't

All 7 compliance checks port as pure SELECTs:
  RGM/DCM notes, RGM recording, CDP notes, CDP recording, CDD form,
  CDP PDF present, DM review (CDP_COMPLIANCE form filled with DM scores).

Dropped (need binaries a Netlify Function can't run):
  - S3 presigned PDF URL -> PDF cell links out to the Pulse project page instead
  - BOQ / page-count OCR (tesseract + poppler) -> was on-demand only, not in the verdict

## Deploy

1. New repo, push these files.
2. Netlify -> New site from Git. Build settings come from netlify.toml
   (publish = public, functions = netlify/functions). No build command needed.
3. Set env vars (Site settings -> Environment variables):
     PGHOST      bonitoapp-read-replica.cnxne33fjape.ap-south-1.rds.amazonaws.com
     PGPORT      5432
     PGUSER      postgres_read
     PGPASSWORD  <the read replica password>
     PGDATABASE  <db name, e.g. bonito>
   (Host/port/user/db have sane defaults in code; PGPASSWORD is required.)
4. Deploy. The page auto-loads the last 30 days on open.

## Notes

- The function forces read-only transactions; the replica rejects writes anyway.
- To change the Pulse project link base, edit `PURL` at the top of the
  <script> in public/index.html and, if you like, in the README.
- CSV export is client-side (exports whatever rows are in view).
