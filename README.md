# AuditTrackingTool

**Strumento di analisi GDPR compliance per siti web**

> **Nota**: Questo strumento è attualmente in fase di sviluppo attivo. Alcune funzionalità potrebbero essere incomplete o soggette a modifiche.

## Descrizione

AuditTrackingTool è uno strumento di audit automatizzato che verifica la conformità GDPR dei siti web, analizzando:

- Rilevamento di tracker e cookie prima e dopo il consenso
- Presenza e funzionamento di Cookie Management Platform (CMP)
- Violazioni di tracking pre-consenso
- Eventi di analytics (GA4, Facebook, LinkedIn, ecc.)

## Funzionalità

### Scansione Singola
Analisi completa di un singolo URL con report dettagliato.

### Bulk Scan
Scansione multipla di URL con:
- Fino a 3 scansioni parallele
- Aggiornamenti in tempo reale (SSE)
- Tabella riassuntiva con stato di salute
- Export risultati in CSV/JSON

### Form Test
Test interattivo per verificare il tracking dei form submission.

## CMP Supportati

Lo strumento rileva automaticamente i seguenti sistemi di gestione cookie:

- Cookiebot
- iubenda
- OneTrust
- Didomi
- Commanders Act (TrustCommander)
- Quantcast Choice
- Axeptio
- Complianz
- Klaro
- Usercentrics
- Osano
- Civic Cookie Control
- Banner generici

## Tracker Rilevati

- Google Analytics 4 (GA4)
- Google Ads
- Facebook/Meta Pixel
- LinkedIn Insight
- TikTok Pixel
- Microsoft Clarity
- Hotjar
- E molti altri...

## Requisiti

- Node.js 18+
- npm

## Installazione

```bash
# Clona il repository
git clone <repository-url>
cd AuditTrackingTool

# Installa dipendenze
npm install

# Installa Playwright browsers
npx playwright install chromium
```

## Utilizzo

### Avvio Server

```bash
node server.js
```

Il server sarà disponibile su `http://localhost:3000`

### Interfacce Web

- **Home** (`/`): Scansione singola
- **Bulk Scan** (`/bulk-scan.html`): Scansione multipla
- **Form Test** (`/form-test.html`): Test tracking form

### API

#### Scansione Singola
```bash
POST /scan
Content-Type: application/json

{
  "url": "https://esempio.com",
  "timeout": 10000
}
```

#### Bulk Scan
```bash
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

# Export
GET /api/bulk-scan/:batchId/export?format=csv
GET /api/bulk-scan/:batchId/export?format=json
```

#### Report
```bash
GET /api/report/:reportId
```

## Verdetti

| Verdetto | Descrizione |
|----------|-------------|
| **CONFORME** | CMP rilevato, nessuna violazione pre-consenso |
| **NON CONFORME** | Violazioni di tracking prima del consenso |
| **DA VERIFICARE** | Nessun CMP rilevato |

## Struttura Progetto

```
AuditTrackingTool/
├── server.js         # Server HTTP e API
├── scanner.js        # Core scanner con Playwright
├── index.html        # UI scansione singola
├── bulk-scan.html    # UI scansione multipla
├── form-test.html    # UI test form
└── report.html       # Visualizzazione report
```

## Limitazioni Note

- Alcuni siti potrebbero bloccare l'accesso automatizzato
- Il rilevamento CMP dipende dalla corretta implementazione lato sito
- I tempi di scansione variano in base alla complessità del sito

## Licenza

Tutti i diritti riservati.

## Autore

Andrea Camolese - [LinkedIn](https://www.linkedin.com/in/andreacamolese/)
