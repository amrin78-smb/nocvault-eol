#!/usr/bin/env bash
#
# Fetch the Sangfor "End of Services" page and POST it to the NocVault ingest
# endpoint. Sangfor is behind Cloudflare bot management that blocks server-side
# (Node/undici) fetches by TLS fingerprint, but curl's TLS stack passes. Run this
# from a developer machine or CI runner (see .github/workflows/scrape-sangfor.yml).
#
# Required environment variables:
#   NV_BASE_URL       e.g. https://nocvault-eol.netlify.app
#   NV_INGEST_SECRET  the value of API_SECRET_KEY on the deployment
#
set -euo pipefail

: "${NV_BASE_URL:?set NV_BASE_URL (e.g. https://nocvault-eol.netlify.app)}"
: "${NV_INGEST_SECRET:?set NV_INGEST_SECRET (= API_SECRET_KEY on the deployment)}"

SANGFOR_URL="https://www.sangfor.com/support/services-policy/support-life-cycle-policy/end-of-sale-service-eos"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

echo "Fetching Sangfor EOS page..."
html="$(curl -fsSL "$SANGFOR_URL" \
  -A "$UA" \
  -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
  -H "Accept-Language: en-US,en;q=0.9" \
  --compressed)"

bytes=${#html}
echo "Fetched ${bytes} bytes. Posting to ingest endpoint..."

printf '%s' "$html" | curl -fsS -X POST "${NV_BASE_URL%/}/api/admin/ingest/sangfor" \
  -H "Authorization: Bearer ${NV_INGEST_SECRET}" \
  -H "Content-Type: text/html" \
  --data-binary @-

echo
echo "Done."
