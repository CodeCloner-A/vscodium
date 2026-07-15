# Agent-Proxy — Cloud-Run-Türsteher vor Vertex AI (Phase S)

Der Proxy in [`agent-proxy/`](../agent-proxy/) ist das Herzstück des SaaS-Umbaus: Er prüft
Firebase-Auth-ID-Tokens, wendet die Modell-Allowlist mit serverseitigem Standort-Routing an
(`gemini-3.5-flash` → `eu`-Multiregion mit EU-Datenresidenz via `aiplatform.eu.rep.googleapis.com`,
2.5-Familie → `europe-west1`) und leitet
`generateContent`/`streamGenerateContent` (SSE) an Vertex AI durch — Gemini unverändert,
**Anthropic Claude** (seit v0.5.0, Vertex MaaS) mit vollständiger Format-Übersetzung
(siehe unten). Tokenzahlen
aus `usageMetadata` schreibt er pro Nutzer und Monat nach **Firestore** fort und setzt dort
harte, **pro Modell gewichtete Monats-Quoten** durch (zusätzlich strukturierte Logs) — Prompt- und
Code-Inhalte werden nie protokolliert. Seit v0.4.0 synchronisiert er außerdem die
**Chat-Sitzungen** der IDE (pro Nutzer und Projekt) nach Firestore — dort liegen bewusst
Inhalte, das ist der Zweck des Features; die Proxy-Logs bleiben auch hier inhaltsfrei.

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
| GET | `/v1/sessions?workspace={ws}` | Chat-Sitzungen des Nutzers im Workspace (nur Metadaten: `id`, `title`, `createdAt`, `updatedAt`) |
| GET | `/v1/sessions/{id}?workspace={ws}` | Eine Sitzung vollständig (inkl. `items`/`history`) |
| PUT | `/v1/sessions/{id}` | Sitzung anlegen/ersetzen (Body: `workspace`, `title`, `createdAt`, `updatedAt`, `items`, `history`) |
| DELETE | `/v1/sessions/{id}?workspace={ws}` | Sitzung löschen (idempotent) |
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

## Partner-Modelle: Claude via Vertex MaaS (seit v0.5.0)

Der Client spricht ausschließlich das Gemini-Wire-Format — für Claude-Modelle übersetzt
der Proxy in beide Richtungen (`agent-proxy/lib/anthropic.js`):

| Aspekt | Gemini (Client) | Anthropic (Vertex MaaS) |
|---|---|---|
| Endpunkt | `:generateContent` / `:streamGenerateContent` | `publishers/anthropic/models/{id}:rawPredict` / `:streamRawPredict` (nativ SSE, kein `?alt=sse`) |
| Pflichtfelder | — | `anthropic_version: "vertex-2023-10-16"`, `max_tokens` (Default `ANTHROPIC_MAX_TOKENS_DEFAULT`), kein `model`-Feld |
| Tool-Aufrufe | `functionCall`/`functionResponse` ohne IDs | `tool_use`/`tool_result` mit synthetischen IDs (Zuordnung per Name/Reihenfolge) |
| Tool-Schemata | OpenAPI-Subset, Typen GROSS | JSON Schema, Typen klein |
| SSE | Gemini-Chunks mit `usageMetadata` | `message_start`/`content_block_delta`/… → werden in Gemini-Chunks reframed (Metering & Client unverändert) |
| stop_reason | `finishReason` | `end_turn`/`tool_use` → `STOP`, `max_tokens` → `MAX_TOKENS`, `refusal` → `SAFETY` |

Bewusste Entscheidungen: `thinking: {type:"disabled"}` wird immer gesetzt (thinking-Blöcke
wären beim Tool-Roundtrip signaturpflichtig und in der Gemini-Historie nicht verlustfrei
transportierbar); Sampling-Parameter (`temperature` …) werden nie weitergereicht (auf
Opus 4.8/Sonnet 5 entfernt, 400). Angebotene Modelle und Standorte stehen im Katalog
(`lib/catalog.js`): `claude-opus-4-8` und `claude-sonnet-5` über die `eu`-Multiregion,
`claude-opus-4-6` über `europe-west1`.

**Voraussetzung (einmalig, Konsole):** Die Claude-Modelle müssen im **Vertex AI Model
Garden** des Projekts aktiviert werden (EULA akzeptieren) — sonst antwortet Vertex mit
einem Permission-Fehler. Der Service-Account braucht keine neuen Rollen
(`roles/aiplatform.user` deckt rawPredict ab). Abgerechnet wird pay-as-you-go über das
verknüpfte Rechnungskonto.

## Gewichtete Monats-Quote (seit v0.5.0)

Teure Modelle verbrauchen die Quote schneller: Jeder Katalog-Eintrag trägt einen
`quotaFactor {input, output}` relativ zur Basiseinheit **Gemini 2.5 Flash**
(Input $0,30 / Output $2,50 pro Mio. Tokens); das Metering schreibt zusätzlich zu den
Rohzählern ein `weightedTokens`-Feld fort (`weighted = prompt×input + candidates×output`),
und das Quota-Gate prüft `max(weightedTokens, totalTokens)` gegen das Limit (deckt
Monats-Dokumente aus der Zeit vor der Gewichtung ab; Faktoren nie < 1).

| Modell | Faktor Input | Faktor Output | Herleitung (Preisstand 15.07.2026) |
|---|---|---|---|
| gemini-2.5-flash | 1 | 1 | Basiseinheit ($0,30/$2,50) |
| gemini-2.5-flash-lite | 1 | 1 | billiger als Basis → aufgerundet |
| gemini-2.5-pro | 4 | 4 | $1,25/$10 |
| gemini-3.5-flash | 6 | 6 | Input global $1,50 +10 % eu; Output nicht gelistet → wie Input (konservativ) |
| claude-sonnet-5 | 11 | 7 | $3/$15 (Listenpreis) +10 % eu |
| claude-opus-4-8 | 18 | 11 | $5/$25 +10 % eu |
| claude-opus-4-6 | 17 | 10 | $5/$25 (europe-west1, regional ohne Aufschlag) |

Bei Preisänderungen die Faktoren in `lib/catalog.js` nachziehen (Herleitung steht dort
als Kommentar). `GET /v1/usage` liefert zusätzlich `weightedTokens`; die IDE zeigt den
gewichteten Verbrauch an.

## Chat-Sitzungs-Sync (Firestore, seit v0.4.0)

Seit dem BYOK-Rückbau hat die Extension keinen direkten Firebase-Zugang mehr — der Sync
der Chat-Sitzungen läuft deshalb wie das Metering über den Proxy (Service-Account).
Die **Isolation pro Nutzer erzwingt der Proxy**: Die `uid` im Firestore-Pfad stammt immer
aus dem verifizierten ID-Token, die Sitzungs-ID aus dem URL-Pfad — Body-Werte können
beides nicht übersteuern; die Security Rules der Datenbank bleiben zu.

| Dokument | Felder | Bedeutung |
|---|---|---|
| `sessions/{uid}/workspaces/{ws}/items/{sessionId}` | `title`, `createdAt`, `updatedAt` (int, ms), `data` (string) | Eine Chat-Sitzung. `{ws}` ist der Ordnername des Projekts (trennt Projekte, findet dasselbe Repo auf anderen Geräten). `data` trägt `items`/`history` als JSON-String — die Listenansicht liest per Projektion nur die Metadaten. |

Verhalten im Detail:

- **Konfliktauflösung:** last-write-wins pro Sitzung über `updatedAt`; entschieden wird
  clientseitig (`lib/sessionSync.js` der Extension), der Proxy speichert nur.
- **Fail-closed, aber verlustfrei:** Ist Firestore nicht erreichbar, antworten die
  Sitzungs-Endpunkte 502 — der Client behält seinen lokalen Stand (`workspaceState`
  als Offline-Cache) und versucht es beim nächsten Speichern erneut.
- **Guards:** Nutzer-ID, Workspace-Schlüssel (kein `/`, nicht `.`/`..`/`__…__`, max.
  100 Zeichen) und Sitzungs-ID werden validiert, bevor daraus Firestore-Pfade werden.
  Dokumente sind auf ~900 KiB gedeckelt (413; Firestore-Limit ist 1 MiB) — eine zu
  große Sitzung bleibt einfach lokal.
- **Datensparsamkeit:** Die Logs der Sitzungs-Endpunkte tragen nur Pfadform
  (`/v1/sessions`, `/v1/sessions/{id}`), Methode, Status und Dauer — nie Sitzungs-IDs,
  Titel oder Inhalte.
- Der Service-Account braucht keine neuen Rollen (`roles/datastore.user` deckt den
  Sync ab, siehe Schritt 3 im Deploy).

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|---|---|---|
| `FIREBASE_PROJECT_ID` | — (Pflicht) | Firebase-Projekt-ID = Token-Audience (`controlling-man`) |
| `GCP_PROJECT` | = `FIREBASE_PROJECT_ID` | Projekt für die Vertex-AI-Aufrufe |
| `PORT` | `8080` | von Cloud Run gesetzt |
| `RATE_LIMIT_RPM` | `30` | Anfragen pro Nutzer und Minute (pro Instanz) |
| `GLOBAL_RATE_LIMIT_RPM` | `300` | Gesamtdeckel aller Nutzer zusammen (pro Instanz) |
| `REQUEST_TIMEOUT_SEC` | `300` | Upstream-Timeout |
| `FREE_MONTHLY_TOKENS` | `2000000` | Monats-Quote in **gewichteten** Tokens pro Nutzer ohne Entitlement-Dokument; `0` = unbegrenzt (nur zählen) |
| `ANTHROPIC_MAX_TOKENS_DEFAULT` | `32768` | `max_tokens`-Pflichtfeld für Claude-Requests, wenn der Client kein `maxOutputTokens` setzt |
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
- **Claude ohne Extended Thinking (v1)** — `thinking` ist bewusst deaktiviert (siehe
  Partner-Modelle); ebenso kein Prompt-Caching für Claude (`input_tokens` zählt voll).
- **Quota-Gewichte sind Näherungen** aus Listenpreisen — bei Preisänderungen den
  Katalog nachziehen.
- **Rate-Limits pro Instanz**, nicht clusterweit (bei `--max-instances 3` also bis zu 3×);
  die Monats-Quote (Firestore) gilt dagegen instanzübergreifend.
- **Abgebrochene Streams zählen nicht** ins Kontingent (usageMetadata kommt erst am Ende).
- **Standort-Wahl:** `gemini-3.5-flash` läuft bewusst über die `eu`-Multiregion
  (EU-Datenresidenz für die ML-Verarbeitung). `europe-west2` (London) wird vermieden:
  laut Google-Doku dort nur mit Allowlist bzw. Single-Zone Provisioned Throughput,
  und UK zählt nicht zur EU-Residenz. Die 2.5-Familie nutzt `europe-west1`.
