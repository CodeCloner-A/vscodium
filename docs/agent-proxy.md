# Agent-Proxy — Cloud-Run-Türsteher vor Vertex AI (Phase S)

Der Proxy in [`agent-proxy/`](../agent-proxy/) ist das Herzstück des SaaS-Umbaus: Er prüft
Firebase-Auth-ID-Tokens, wendet die Modell-Allowlist mit serverseitigem Standort-Routing an
(`gemini-3.5-flash` → `eu`-Multiregion mit EU-Datenresidenz via `aiplatform.eu.rep.googleapis.com`,
2.5-Familie → `europe-west1`) und leitet
`generateContent`/`streamGenerateContent` (SSE) unverändert an Vertex AI durch. Tokenzahlen
aus `usageMetadata` landen als strukturierte Logs (Metering-Grundlage) — Prompt- und
Code-Inhalte werden nie protokolliert.

**Projektdaten** (Stand 07/2026): GCP-Projekt `controlling-man` (Projektnummer
`476281311476`), Rechnungskonto „Firebase Payment“.

## Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | Liveness (ohne Anmeldung; `/healthz` fängt Googles Frontend auf `*.run.app` selbst ab) |
| GET | `/v1/models` | Modell-Katalog für den Picker |
| POST | `/v1/models/{model}:generateContent` | Gemini-Request, JSON-Antwort |
| POST | `/v1/models/{model}:streamGenerateContent` | Gemini-Request, SSE-Stream |

Alle `/v1`-Endpunkte erwarten `Authorization: Bearer <Firebase-ID-Token>`. Unbekannte
Modelle werden mit 404 abgelehnt (Allowlist = Kostenkontrolle). Pro Nutzer gilt ein
Sliding-Window-Limit (`RATE_LIMIT_RPM`, Default 30/min), zusätzlich ein instanzweiter
Gesamtdeckel (`GLOBAL_RATE_LIMIT_RPM`, Default 300/min) — der schützt die Abrechnung
auch dann, wenn jemand massenhaft frische Firebase-Konten erzeugt.

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|---|---|---|
| `FIREBASE_PROJECT_ID` | — (Pflicht) | Firebase-Projekt-ID = Token-Audience (`controlling-man`) |
| `GCP_PROJECT` | = `FIREBASE_PROJECT_ID` | Projekt für die Vertex-AI-Aufrufe |
| `PORT` | `8080` | von Cloud Run gesetzt |
| `RATE_LIMIT_RPM` | `30` | Anfragen pro Nutzer und Minute (pro Instanz) |
| `GLOBAL_RATE_LIMIT_RPM` | `300` | Gesamtdeckel aller Nutzer zusammen (pro Instanz) |
| `REQUEST_TIMEOUT_SEC` | `300` | Upstream-Timeout |

## Lokal testen

```bash
cd agent-proxy
node test/run.js        # Headless-Tests (ohne GCP)
```

## Deploy (einmalige Einrichtung + jedes Release)

Voraussetzungen: `gcloud` CLI, angemeldet mit einem Konto, das im Projekt
`controlling-man` Owner/Editor ist. Das Rechnungskonto „Firebase Payment“ ist bereits
mit dem Projekt verknüpft (Blaze) — ohne Verknüpfung schlägt `services enable` fehl.

```bash
# 1. Projekt wählen
gcloud config set project controlling-man

# 2. Benötigte APIs aktivieren (einmalig)
gcloud services enable run.googleapis.com aiplatform.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com

# 3. Dedizierten Service-Account anlegen (einmalig) — nur Vertex-Zugriff, nichts weiter
gcloud iam service-accounts create agent-proxy --display-name "VSCodium Agent Proxy"
gcloud projects add-iam-policy-binding controlling-man \
  --member "serviceAccount:agent-proxy@controlling-man.iam.gserviceaccount.com" \
  --role "roles/aiplatform.user"

# 4. Deploy aus dem Quellverzeichnis (Cloud Build baut das Docker-Image)
gcloud run deploy agent-proxy \
  --source agent-proxy/ \
  --region europe-west1 \
  --service-account agent-proxy@controlling-man.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=controlling-man \
  --memory 256Mi \
  --max-instances 3 \
  --timeout 300
```

Die Service-URL aus der Deploy-Ausgabe (Form `https://agent-proxy-…-ew.a.run.app`) wird
später die Einstellung `vscodiumAgent.proxy.url` der Extension.

### Warum `--allow-unauthenticated`?

Die IAM-Ebene von Cloud Run kann nur Google-Cloud-Identitäten prüfen — unsere Nutzer melden
sich aber mit Firebase Auth an. Der Dienst ist deshalb auf HTTP-Ebene öffentlich, die
Zugangskontrolle passiert **in der Anwendung**: Ohne gültiges, signiertes Firebase-ID-Token
(Signatur, Ablauf, Audience `controlling-man`, Issuer) antwortet jeder `/v1`-Endpunkt mit 401.

### Kostenschutz (empfohlen, einmalig)

- `--max-instances 3` begrenzt die Skalierung (oben bereits gesetzt).
- Budget-Alarm auf dem Rechnungskonto „Firebase Payment“ anlegen: Cloud Console →
  Abrechnung → Budgets & Benachrichtigungen → Budget mit E-Mail-Alarm bei 50/90/100 %.
- Das Per-Nutzer-Limit (`RATE_LIMIT_RPM`) gilt pro Instanz; harte projektweite Quoten
  kommen mit dem Firestore-Metering (nächster Phase-S-Punkt).

## Verifikation nach dem Deploy

```bash
# Health (ohne Token):
curl https://agent-proxy-476281311476.europe-west1.run.app/health
# → {"status":"ok"}

# Ohne Token muss 401 kommen:
curl -i https://agent-proxy-476281311476.europe-west1.run.app/v1/models
# → HTTP/2 401 … {"error":"Nicht angemeldet.", …}

# Mit gültigem ID-Token (z. B. aus einem Firebase-Auth-Testnutzer):
curl -H "Authorization: Bearer <ID_TOKEN>" https://agent-proxy-476281311476.europe-west1.run.app/v1/models
# → {"models":[{"id":"gemini-3.5-flash","location":"eu"}, …]}
```

## Bewusste v1-Grenzen (Roadmap Phase S)

- **Kein Firestore-Metering/-Quoten** — nur strukturierte Logs; folgt als eigener Punkt.
- **Keine Entitlements/Tarife** (Stripe) — jeder angemeldete Firebase-Nutzer darf anfragen.
- **Nur Gemini** — Claude via MaaS (anderes Wire-Format) kommt mit Proxy v2.
- **Rate-Limits pro Instanz**, nicht clusterweit (bei `--max-instances 3` also bis zu 3×).
- **Standort-Wahl:** `gemini-3.5-flash` läuft bewusst über die `eu`-Multiregion
  (EU-Datenresidenz für die ML-Verarbeitung). `europe-west2` (London) wird vermieden:
  laut Google-Doku dort nur mit Allowlist bzw. Single-Zone Provisioned Throughput,
  und UK zählt nicht zur EU-Residenz. Die 2.5-Familie nutzt `europe-west1`.
