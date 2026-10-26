#!/usr/bin/env bash
# One-time setup for a Codespace: writes the app's settings files with fresh
# random secrets and the Codespace's own public addresses. Safe to re-run: it
# never overwrites a settings file that already exists.
#
# TEST ENVIRONMENT ONLY. Sign-in confirmation is switched off, telemetry is
# off, and the bundled Supabase keys are public demo keys. Use made-up data.
set -euo pipefail
cd "$(dirname "$0")/.."

# Replace the value of KEY= in FILE, or append it.
set_var() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file"; then
    # | is the delimiter; values here never contain it. -i.bak works with both
    # GNU and BSD sed.
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file" && rm -f "${file}.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    base="https://${CODESPACE_NAME}"
    domain="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
    set_var .env FRONTEND_URL "${base}-3000.${domain}"
    set_var .env API_PUBLIC_URL "${base}-3000.${domain}/api"
    set_var .env SUPABASE_PUBLIC_URL "${base}-54321.${domain}"
    set_var .env R2_PUBLIC_ENDPOINT_URL "${base}-9000.${domain}"
  fi
  # The storage service only accepts browser uploads from listed origins.
  origin="${base:-http://localhost}-3000.${domain:-}"
  [ -n "${CODESPACE_NAME:-}" ] || origin="http://localhost:3000"
  cat > .devcontainer/storage-cors.generated.json <<JSON
{
  "CORSRules": [
    {
      "AllowedOrigins": ["${origin}", "http://localhost:3000"],
      "AllowedMethods": ["PUT", "HEAD"],
      "AllowedHeaders": ["Content-Type", "x-amz-*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON
  # Test accounts work at once, with no confirmation email.
  set_var .env GOTRUE_MAILER_AUTOCONFIRM true
  set_var .env SENTRY_DISABLED true
  set_var .env AUTH_HANDOFF_ENCRYPTION_SECRET "$(openssl rand -hex 32)"
fi

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  set_var backend/.env DOWNLOAD_SIGNING_SECRET "$(openssl rand -hex 32)"
  set_var backend/.env USER_API_KEYS_ENCRYPTION_SECRET "$(openssl rand -hex 32)"
  set_var backend/.env SENTRY_DISABLED true
fi

# Model and search keys come from Codespaces secrets, never from the repo.
for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY BRAVE_SEARCH_API_KEY; do
  if [ -n "${!key:-}" ]; then
    set_var backend/.env "$key" "${!key}"
  fi
done

echo "Settings files are ready."
