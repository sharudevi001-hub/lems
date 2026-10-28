// Copy to secrets.h locally; never commit your real values.
#pragma once
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define API_BASE_URL "https://YOUR-LEMS-DOMAIN"
#define KIOSK_API_KEY "SET_A_LONG_RANDOM_SECRET"

// Paste the PEM root/intermediate CA certificate that validates your API TLS certificate.
// The placeholder deliberately does not validate any server; replace before use.
static const char *ROOT_CA_CERT = R"LEMSCA(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_REAL_CA_CERTIFICATE_PEM
-----END CERTIFICATE-----
)LEMSCA";
