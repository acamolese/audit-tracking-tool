# AuditTrackingTool

**Motore di Scansione Avanzato per Audit Tecnici e Tracking Analysis**

Copyright (c) 2024-2026 Andrea Camolese. Tutti i diritti riservati.

---

## Descrizione

AuditTrackingTool è uno strumento di audit automatizzato per la mappatura dei tracker e l'analisi tecnica delle property digitali. Analizza in modo approfondito il comportamento di cookie, script e flussi dati, fornendo insight tecnici dettagliati oltre alla semplice verifica della compliance.

### Cosa fa

- Mappatura completa dei sistemi di gestione cookie (CMP)
- Monitoraggio granulare delle richieste verso tracker e analytics
- Identificazione di tracciamenti non autorizzati o anomali
- Analisi tecnica di GA4, Facebook Pixel, LinkedIn e altri tracker
- Verifica del funzionamento del Google Consent Mode v2
- Generazione di report tecnici IA con suggerimenti di ottimizzazione

---

## Funzionalità Principali

### Scansione Singola
Analisi completa di un singolo URL con due modalità:
- **Fast Mode**: scansione rapida (~15 secondi) per verifiche veloci
- **Full Mode**: scansione completa con interazioni simulate

### Bulk Scan
Scansione multipla di URL (fino a 50) con:
- Esecuzione parallela (3 scansioni simultanee)
- Aggiornamenti in tempo reale via Server-Sent Events
- Tabella riassuntiva con indicatori di salute
- Export risultati in CSV e JSON
- Filtri per stato e verdetto

### Live Monitor
Monitoraggio in tempo reale degli eventi di tracking con due modalità:
- **Modalità Visuale** (locale): apre un browser interattivo per testare manualmente
- **Modalità Headless** (server/Railway): pannello comandi con azioni predefinite:
  - Accetta Cookie
  - Scroll pagina
  - Compila e invia form
  - Click personalizzati (selettori CSS)
  - Screenshot della pagina

### Report Dettagliato
- Stato CMP e consent mode
- Potenziali violazioni con dettaglio eventi per tracker
- Cookie pre e post consenso
- Eventi rilevati raggruppati per tracker
- Pulsanti: Stampa, Scarica JSON, Live Monitor, Nuova Scansione

---

## CMP Supportati

Lo strumento rileva automaticamente i seguenti sistemi di gestione cookie:

| CMP | Rilevamento |
|-----|-------------|
| Cookiebot | Script + API JavaScript |
| iubenda | Script + oggetto `_iub` |
| OneTrust | Script + API `OneTrust` |
| Didomi | API `Didomi` |
| Commanders Act | TrustCommander |
| Quantcast Choice | TCF API |
| Axeptio | Script + callback |
| Complianz | Plugin WordPress |
| Klaro | Configurazione klaro |
| Usercentrics | UC_UI |
| Osano | API Osano |
| Civic Cookie Control | CookieControl |
| Banner generici | Selettori comuni |

---

## Tracker Rilevati

### Analytics
- Google Analytics 4 (GA4)
- Google Tag Manager (GTM)
- Google Ads / Conversion Tracking

### Social & Advertising
- Facebook/Meta Pixel
- LinkedIn Insight Tag
- TikTok Pixel
- Twitter/X Pixel

### Session Recording
- Microsoft Clarity
- Hotjar
- FullStory

### Altri
- Bing Ads
- Pinterest Tag
- Criteo
- E molti altri...

---

## Requisiti di Sistema

- **Node.js** 18.0 o superiore
- **npm** 8.0 o superiore
- **Sistema operativo**: Windows, macOS, Linux
- **RAM**: minimo 2GB consigliati
- **Connessione internet** stabile

---

## Installazione

```bash
# Clona il repository
git clone https://github.com/acamolese/audit-tracking-tool.git
cd audit-tracking-tool

# Installa dipendenze
npm install

# Installa browser Playwright
npx playwright install chromium
```

---

## Utilizzo

### Avvio Server Locale

```bash
node server.js
```

Il server sarà disponibile su `http://localhost:3000`

### Deploy su Railway

Il progetto è configurato per il deploy su Railway. Le variabili d'ambiente vengono rilevate automaticamente per abilitare la modalità headless.

### Interfacce Web

| Pagina | URL | Descrizione |
|--------|-----|-------------|
| Home | `/` | Scansione singola con Fast/Full mode |
| Bulk Scan | `/bulk-scan.html` | Scansione multipla URL |
| Live Monitor | `/form-test.html` | Monitoraggio eventi real-time |
| Report | `/report.html?id=xxx` | Visualizzazione report |

---

## Autenticazione API

Le API sono protette tramite API key. Per abilitare l'autenticazione, imposta la variabile d'ambiente `API_KEY`:

```bash
# Avvia con autenticazione
API_KEY=la-tua-chiave-segreta node server.js

# Su Railway/produzione: configura API_KEY nelle variabili d'ambiente
```

### Header richiesto

Tutte le chiamate agli endpoint `/api/*`, `/scan` e `/proxy` richiedono l'header:

```
X-API-Key: la-tua-chiave-segreta
```

### Esempio con curl

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -H "X-API-Key: la-tua-chiave-segreta" \
  -d '{"url":"https://esempio.com","fastMode":true}'
```

### Risposta senza API key valida

```json
{
  "error": "Unauthorized",
  "message": "Valid API key required in X-API-Key header"
}
```

> **Nota**: Se la variabile `API_KEY` non è configurata, le API sono accessibili senza autenticazione (utile per sviluppo locale).

---

## API Reference

### Scansione Singola

```http
POST /scan
Content-Type: application/json

{
  "url": "https://esempio.com",
  "timeout": 25000,
  "fastMode": true,
  "skipInteractions": true
}
```

**Risposta:**
```json
{
  "success": true,
  "reportId": "abc123xyz"
}
```

### Bulk Scan

```http
# Avvia batch
POST /api/bulk-scan
Content-Type: application/json

{
  "urls": ["https://sito1.com", "https://sito2.com"]
}

# Stato batch
GET /api/bulk-scan/:batchId

# Stream real-time (SSE)
GET /api/bulk-scan/:batchId/stream

# Export CSV
GET /api/bulk-scan/:batchId/export?format=csv

# Export JSON
GET /api/bulk-scan/:batchId/export?format=json
```

### Report

```http
# Ottieni report
GET /api/report/:reportId

# Aggiungi eventi Live Monitor
POST /api/report/:reportId/form-test
Content-Type: application/json

{
  "events": [...],
  "url": "https://esempio.com"
}
```

### Live Monitor (Headless)

```http
# Verifica ambiente
GET /api/environment

# Avvia sessione headless
POST /api/form-test-headless/start
Content-Type: application/json

{
  "url": "https://esempio.com"
}

# Stream eventi (SSE)
GET /api/form-test-headless/:sessionId/events

# Esegui azione
POST /api/form-test-headless/:sessionId/action
Content-Type: application/json

{
  "action": "acceptCookies" | "scroll" | "scrollToBottom" | "click" | "fillForm" | "submitForm" | "screenshot" | "wait",
  "params": {}
}

# Termina sessione
POST /api/form-test-headless/:sessionId/stop
```

---

## Verdetti di Conformità

| Verdetto | Colore | Descrizione |
|----------|--------|-------------|
| **CONFORME** | Verde | CMP rilevato e funzionante, nessun tracker attivo prima del consenso |
| **NON CONFORME** | Rosso | Rilevati tracker attivi prima dell'accettazione dei cookie |
| **DA VERIFICARE** | Giallo | Nessun CMP rilevato o situazione ambigua |

### Nota su GA4 e Consent Mode

Gli eventi GA4 con consent mode "denied" **non sono considerati violazioni** poiché rispettano le impostazioni di consenso dell'utente e non raccolgono dati personali.

---

## Struttura del Progetto

```
AuditTrackingTool/
├── server.js              # Server bootstrapper
├── report.html            # UI Report (Single Page App)
├── bulk-scan.html         # UI Scansione Multipla
├── deep-scan-report.html  # UI Report Aggregato (Deep Scan)
├── index.html             # UI Home (Scansione Singola)
├── form-test.html         # UI Live Monitor
├── src/
│   ├── api/               # Router e controller HTTP
│   ├── core/
│   │   ├── scanner/       # Motore di scansione Playwright
│   │   ├── events/        # Logica deduplicazione e analisi
│   │   └── storage/       # Gestione memoria report e batch
│   └── utils/             # Helper comuni
└── package.json           # Dipendenze npm
```

---

## Changelog

### v1.2.0 (Gennaio 2026) - Deep Scan & Technical Insights
- **Aggregated Technical Report**: Nuova dashboard per domini con inventario cookie, distribuzione tracker e analisi form.
- **Tracker Distribution**: Visualizzazione dell'incidenza dei tracker su tutto il parco pagine scansionato.
- **Form Inventory**: Rilevamento e categorizzazione automatica dei form (Login, Checkout, Leads) a livello di dominio.
- **Site-Wide AI Audit**: Export prompt ottimizzato per l'analisi strategica dell'intera property digitale.
- **Enhanced Data Aggregation**: Motore di storage potenziato per la persistenza di metriche tecniche avanzate.

### v1.1.0 (Gennaio 2026) - Matrix Mode & AI Evolution
- **Deep Scan Mode**: Supporto iniziale per analisi aggregata di interi domini.
- **Log Engine "Matrix Mode"**: Terminale live durante la scansione per feedback tecnico istantaneo.
- **AI Prompt Export**: Template avanzato per analisi con ChatGPT/Gemini (Specialista Tracking & GDPR).
- **Event Enrichment**: Decodifica automatica dei parametri Google Consent Mode (GCS/GCD).
- **Deduplicazione Throttled**: Riduzione del rumore per tracker ad alta frequenza (Clarity/Hotjar).

### v1.0.0 (Gennaio 2026)
- Rilascio iniziale: Scansione singola e Bulk, Live Monitor.

---

## Licenza

**Copyright (c) 2024-2026 Andrea Camolese. Tutti i diritti riservati.**

Questo software è proprietario e confidenziale. È vietata la riproduzione, distribuzione, modifica o utilizzo non autorizzato di questo software, in tutto o in parte, senza il previo consenso scritto del titolare dei diritti.

L'utilizzo di questo software è concesso esclusivamente per scopi personali e non commerciali, salvo diverso accordo scritto con il titolare.

Per richieste di licenza commerciale o partnership, contattare l'autore.

---

## Autore

**Andrea Camolese**

- LinkedIn: [linkedin.com/in/andreacamolese](https://www.linkedin.com/in/andreacamolese/)
- GitHub: [github.com/acamolese](https://github.com/acamolese)

---

## Supporto

Per segnalazioni bug, richieste di funzionalità o supporto tecnico:
- Aprire una issue su GitHub
- Contattare l'autore via LinkedIn

---

*Realizzato con Node.js e Playwright*
