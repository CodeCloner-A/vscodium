# Agent-Proxy — Cloud-Run-Türsteher vor Vertex AI (Phase S)

Der Proxy in [`agent-proxy/`](../agent-proxy/) ist das Herzstück des SaaS-Umbaus: Er prüft
Firebase-Auth-ID-Tokens, wendet die Modell-Allowlist mit serverseitigem Standort-Routing an
(`gemini-3.5-flash` → `eu`-Multiregion mit EU-Datenresidenz via `aiplatform.eu.rep.googleapis.com`,
2.5-Familie → `europe-west1`) und leitet
`generateContent`/`streamGenerateContent` (SSE) unverändert an Vertex AI durch. Tokenzahlen
aus `usageMetadata` schreibt er pro Nutzer und Monat nach **Firestore** fort und setzt dort
harte **Monats-Quoten** durch (zusätzlich strukturierte Logs) — Prompt- und
Code-Inhalte werden nie protokolliert oder gespeichert.

**Projektdaten** (Stand 07/2026): GCP-Projekt `controlling-man` (Projektnummer
`476281311476`), Rechnungskonto „Firebase Payment“.

## Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | Liveness (ohne Anmeldung; `/healthz` fängt Googles Frontend auf `*.run.app` selbst ab) |
| POST | `/v1/auth/exchange` | Anmeldung: OAuth-Code (+ PKCE-Verifier) → Firebase-Tokens (Auth-Relay, ohne Bearer) |
| POST | `/v1/auth/refresh` | Firebase-ID-Token erneuern (Auth-Relay, ohne Bearer) |
| GET | `/v1/models` | Modell-Katalog für den Picker |
| GET | `/v1/usage` | Monatsverbrauch + Limit des angemeldeten Nutzers (IDE: „Agent: Verbrauch anzeigen") |
| POST | `/v1/models/{model}:generateContent` | Gemini-Request, JSON-Antwort |
| POST | `/v1/models/{model}:streamGenerateContent` | Gemini-Request, SSE-Stream |

Alle `/v1`-Endpunkte außer dem Auth-Relay erwarten `Authorization: Bearer <Firebase-ID-Token>`.
Unbekannte Modelle werden mit 404 abgelehnt (Allowlist = Kostenkontrolle). Pro Nutzer gilt ein
Sliding-Window-Limit (`RATE_LIMIT_RPM`, Default 30/min), zusätzlich ein instanzweiter
Gesamtdeckel (`GLOBAL_RATE_LIMIT_RPM`, Default 300/min) — der schützt die Abrechnung
auch dann, wenn jemand massenhaft frische Firebase-Konten erzeugt.

## Auth-Relay (seit v0.3.0 — BYOK-Rückbau)

Seit Extension v0.9.0 trägt der Client **keinerlei Geheimnisse** mehr: OAuth-Client-Secret
und Firebase-Web-API-Key leben ausschließlich hier, als Secret-Manager-gestützte Env-Vars.
Das Relay übernimmt die beiden Aufrufe, die der Client früher selbst machte
(`agent-proxy/lib/authRelay.js`):

- `POST /v1/auth/exchange` `{code, codeVerifier, redirectUri}` → Code-Tausch bei Google
  (Client-Secret serverseitig) → `accounts:signInWithIdp` (Web-API-Key serverseitig) →
  `{idToken, refreshToken, expiresInSec, email}`. `redirectUri` muss der Loopback der
  Extension sein (`http://127.0.0.1:<Port>/callback`) — das Relay ist kein offener
  Token-Tauscher.
- `POST /v1/auth/refresh` `{refreshToken}` → `securetoken.googleapis.com` →
  `{idToken, refreshToken, expiresInSec}` (Rotation wird durchgereicht).

Beide Endpunkte laufen **vor** der Token-Prüfung (sie sind der Auth-Bootstrap) und sind
deshalb eigens gedeckelt: per-IP-Rate-Limit (`AUTH_RATE_LIMIT_RPM`, Default 10/min;
Cloud Run hängt die echte Client-IP als letzten `X-Forwarded-For`-Eintrag an) und ein
**eigener** Auth-Gesamtdeckel (`AUTH_GLOBAL_RATE_LIMIT_RPM`, Default 100/min) — bewusst
getrennt vom globalen Eimer der Modell-Endpunkte, damit ein unauthentifizierter
Anmelde-Flood den bezahlten Verkehr nicht aussperren kann; das per-IP-Limit wird zuerst
geprüft, ehe ein Gesamt-Token gebucht wird. Dazu Body-Limit 64 KiB, Logs nur mit
Pfad/Status/Dauer — nie Codes oder Tokens. Sind die drei Env-Vars nicht gesetzt,
antworten die Endpunkte 501 und der Rest des Proxys läuft unverändert.

**Ehrliche Einordnung:** Der Firebase-Web-API-Key ist per Design ein öffentlicher
Client-Identifikator — ihn zu verstecken ist Defense-in-Depth, keine Sicherheitsgrenze.
Die Grenze bleiben ID-Token-Prüfung, Quoten und Rate-Limits. Zusätzlich empfohlen:
den Key in der GCP-Konsole (APIs & Dienste → Anmeldedaten) auf die **Identity Toolkit
API** beschränken, dann ist er außerhalb des Anmelde-Flows wertlos.

## Metering & Quoten (Firestore)

Vor jedem Modell-Aufruf prüft der Proxy das Monatskontingent des Nutzers, nach jeder
Antwort schreibt er die Tokenzahlen per atomarem Increment fort. Datenmodell (nur Zähler
und Tarif, nie Inhalte):

| Dokument | Felder | Bedeutung |
|---|---|---|
| `entitlements/{uid}` | `monthlyTokenLimit` (int), `plan` (string), `disabled` (bool) | Optional — fehlt es, gilt `FREE_MONTHLY_TOKENS`. `monthlyTokenLimit: 0` = unbegrenzt; `disabled: true` sperrt das Konto (403). Grundlage für spätere Stripe-Tarife. |
| `usage/{uid}/months/{JJJJ-MM}` | `promptTokens`, `candidateTokens`, `totalTokens`, `requests`, `updatedAt` | Wird vom Proxy angelegt und fortgeschrieben (UTC-Monat). |

Verhalten im Detail:

- **Kontingent erschöpft** → `429` mit `reason: "quota"`; die Extension erkennt das und
  wiederholt **nicht** (anders als beim Rate-Limit-429). Der Zählerstand wird pro Nutzer
  60 s gecacht; eigene Antworten zählen sofort in den Cache, das Gate greift also ohne
  Verzögerung.
- **Fail-open:** Ist Firestore nicht erreichbar (oder noch nicht eingerichtet), bleibt der
  Dienst nutzbar — es wird nur eine WARNING geloggt; Missbrauch deckeln weiterhin die
  Rate-Limits. Ein Lesefehler wird 30 s gemerkt (Negativ-Cache), damit ein hängendes
  Firestore nicht jede Anfrage um den Timeout verzögert. Ein fehlgeschlagener Zähl-Commit
  kostet die Zählung, nie die Antwort; bei ambigen Fehlern (Timeout/Netz) wird bewusst
  nicht wiederholt — ein Replay könnte die Tokens doppelt zählen.
- **Abgebrochene Streams** zählen als Anfrage; Tokenzahlen nur, wenn die `usageMetadata`
  (am Stream-Ende) noch ankam — Prompt-Tokens abgebrochener Läufe bleiben also ungezählt.
- Der Zähl-Commit läuft **vor** dem Antwort-Ende (begrenzt auf 1,5 s), weil Cloud Run
  nach dem Antwort-Ende die CPU drosselt und Hintergrundarbeit sonst verloren ginge.

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|---|---|---|
| `FIREBASE_PROJECT_ID` | — (Pflicht) | Firebase-Projekt-ID = Token-Audience (`controlling-man`) |
| `GCP_PROJECT` | = `FIREBASE_PROJECT_ID` | Projekt für die Vertex-AI-Aufrufe |
| `PORT` | `8080` | von Cloud Run gesetzt |
| `RATE_LIMIT_RPM` | `30` | Anfragen pro Nutzer und Minute (pro Instanz) |
| `GLOBAL_RATE_LIMIT_RPM` | `300` | Gesamtdeckel aller Nutzer zusammen (pro Instanz) |
| `REQUEST_TIMEOUT_SEC` | `300` | Upstream-Timeout |
| `FREE_MONTHLY_TOKENS` | `2000000` | Monats-Quote in Tokens pro Nutzer ohne Entitlement-Dokument; `0` = unbegrenzt (nur zählen) |
| `AUTH_RATE_LIMIT_RPM` | `10` | Anmeldeversuche pro IP und Minute (Auth-Relay) |
| `AUTH_GLOBAL_RATE_LIMIT_RPM` | `100` | Gesamtdeckel der Auth-Endpunkte (eigener Eimer, damit ein Anmelde-Flood den Modell-Verkehr nicht aussperrt) |
| `GOOGLE_OAUTH_CLIENT_ID` | — | OAuth-Client (Desktop-App) für das Auth-Relay; ohne alle drei Werte → `/v1/auth/*` antwortet 501 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | — | **Secret Manager!** OAuth-Client-Secret, nur serverseitig |
| `FIREBASE_WEB_API_KEY` | — | **Secret Manager!** Web-API-Key für `signInWithIdp`/`securetoken`, nur serverseitig |

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

# 3. Dedizierten Service-Account anlegen (einmalig) — Vertex + Firestore, nichts weiter
gcloud iam service-accounts create agent-proxy --display-name "VSCodium Agent Proxy"
gcloud projects add-iam-policy-binding controlling-man \
  --member "serviceAccount:agent-proxy@controlling-man.iam.gserviceaccount.com" \
  --role "roles/aiplatform.user"
# Für das Metering (seit Proxy v0.2.0) zusätzlich:
gcloud projects add-iam-policy-binding controlling-man \
  --member "serviceAccount:agent-proxy@controlling-man.iam.gserviceaccount.com" \
  --role "roles/datastore.user"

# 3b. Firestore-Datenbank anlegen (einmalig; falls im Projekt noch keine existiert).
#     Native Mode, EU-Region — passend zur Leitplanke Datenresidenz:
gcloud services enable firestore.googleapis.com
gcloud firestore databases create --location=eur3
# Ohne Datenbank läuft der Proxy trotzdem (fail-open, WARNING im Log) — nur ohne
# Zählung und ohne Quoten.

# 3c. Secrets für das Auth-Relay anlegen (einmalig; seit Proxy v0.3.0).
#     Werte: GCP Console → APIs & Dienste → Anmeldedaten (Desktop-App-Client) bzw.
#     Firebase Console → Projekteinstellungen → Allgemein → Web-App → apiKey.
gcloud services enable secretmanager.googleapis.com
printf '%s' '<CLIENT_SECRET>'  | gcloud secrets create oauth-client-secret   --data-file=-
printf '%s' '<WEB_API_KEY>'    | gcloud secrets create firebase-web-api-key  --data-file=-
gcloud secrets add-iam-policy-binding oauth-client-secret \
  --member "serviceAccount:agent-proxy@controlling-man.iam.gserviceaccount.com" \
  --role "roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding firebase-web-api-key \
  --member "serviceAccount:agent-proxy@controlling-man.iam.gserviceaccount.com" \
  --role "roles/secretmanager.secretAccessor"

# 4. Deploy aus dem Quellverzeichnis (Cloud Build baut das Docker-Image)
gcloud run deploy agent-proxy \
  --source agent-proxy/ \
  --region europe-west1 \
  --service-account agent-proxy@controlling-man.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_PROJECT_ID=controlling-man,GOOGLE_OAUTH_CLIENT_ID=<CLIENT_ID> \
  --set-secrets GOOGLE_OAUTH_CLIENT_SECRET=oauth-client-secret:latest,FIREBASE_WEB_API_KEY=firebase-web-api-key:latest \
  --memory 256Mi \
  --max-instances 3 \
  --timeout 300
```

**Reihenfolge bei Releases:** Den Proxy immer VOR der Extension ausrollen — die
Auth-Relay-Endpunkte sind additiv (alte Extension-Versionen laufen weiter), aber die
Extension ab v0.9.0 kann sich ohne sie nicht anmelden bzw. keine Tokens erneuern.

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
- Die Monats-Quote pro Nutzer setzt das Firestore-Metering durch (`FREE_MONTHLY_TOKENS`,
  Entitlements siehe oben); die Rate-Limits (`RATE_LIMIT_RPM`, pro Instanz) deckeln
  zusätzlich Lastspitzen und greifen auch, wenn Firestore ausfällt.

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

## Bewusste Grenzen (Roadmap Phase S)

- **Keine Tarife/Abrechnung** (Stripe) — die Entitlement-Dokumente sind vorbereitet
  (`monthlyTokenLimit`, `plan`), werden aber noch von Hand gepflegt.
- **Nur Gemini** — Claude via MaaS (anderes Wire-Format) kommt mit Proxy v2.
- **Rate-Limits pro Instanz**, nicht clusterweit (bei `--max-instances 3` also bis zu 3×);
  die Monats-Quote (Firestore) gilt dagegen instanzübergreifend.
- **Abgebrochene Streams zählen nicht** ins Kontingent (usageMetadata kommt erst am Ende).
- **Standort-Wahl:** `gemini-3.5-flash` läuft bewusst über die `eu`-Multiregion
  (EU-Datenresidenz für die ML-Verarbeitung). `europe-west2` (London) wird vermieden:
  laut Google-Doku dort nur mit Allowlist bzw. Single-Zone Provisioned Throughput,
  und UK zählt nicht zur EU-Residenz. Die 2.5-Familie nutzt `europe-west1`.
