const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { CookieAuditScanner } = require('./scanner');

const PORT = process.env.PORT || 3000;

// Script da iniettare per monitorare dataLayer e richieste
const MONITOR_SCRIPT = `
<script>
(function() {
  const PARENT_ORIGIN = '*';
  const events = [];

  // Funzione per inviare eventi al parent
  function sendToParent(type, data) {
    window.parent.postMessage({ type, data, timestamp: Date.now() }, PARENT_ORIGIN);
  }

  // Monitora dataLayer
  function setupDataLayerMonitor() {
    window.dataLayer = window.dataLayer || [];
    const originalPush = window.dataLayer.push.bind(window.dataLayer);

    window.dataLayer.push = function(...args) {
      args.forEach(item => {
        if (item && typeof item === 'object') {
          const eventName = item.event || item[0];
          if (eventName) {
            sendToParent('dataLayer', { event: eventName, data: item });
          }
        }
      });
      return originalPush(...args);
    };

    // Processa eventi già presenti
    window.dataLayer.forEach(item => {
      if (item && item.event) {
        sendToParent('dataLayer', { event: item.event, data: item });
      }
    });
  }

  // Monitora richieste di rete (fetch e XHR)
  function setupNetworkMonitor() {
    // Intercetta fetch
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : url.url;
      checkTrackingRequest(urlStr, options?.body);
      return originalFetch.apply(this, arguments);
    };

    // Intercetta XHR
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this._url = url;
      return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
      checkTrackingRequest(this._url, body);
      return originalXHRSend.apply(this, arguments);
    };

    // Monitora anche sendBeacon
    const originalBeacon = navigator.sendBeacon;
    if (originalBeacon) {
      navigator.sendBeacon = function(url, data) {
        checkTrackingRequest(url, data);
        return originalBeacon.apply(this, arguments);
      };
    }
  }

  // Verifica se è una richiesta di tracking
  function checkTrackingRequest(url, body) {
    if (!url) return;

    const trackingPatterns = {
      'GA4': /google-analytics\\.com\\/g\\/collect|analytics\\.google\\.com/i,
      'GTM': /googletagmanager\\.com/i,
      'Facebook': /facebook\\.com\\/tr/i,
      'LinkedIn': /snap\\.licdn\\.com|linkedin\\.com\\/px/i,
      'TikTok': /analytics\\.tiktok\\.com/i
    };

    for (const [tracker, pattern] of Object.entries(trackingPatterns)) {
      if (pattern.test(url)) {
        // Estrai evento
        let eventName = null;
        try {
          const urlObj = new URL(url);
          eventName = urlObj.searchParams.get('en') || urlObj.searchParams.get('ev');

          // Cerca nel body per GA4
          if (!eventName && body && tracker === 'GA4') {
            const matches = body.match(/en=([^&\\r\\n]+)/g);
            if (matches) {
              eventName = matches.map(m => m.replace('en=', '')).join(', ');
            }
          }
        } catch(e) {}

        sendToParent('network', {
          tracker,
          url: url.substring(0, 200),
          event: eventName
        });
        break;
      }
    }
  }

  // Monitora submit dei form
  function setupFormMonitor() {
    document.addEventListener('submit', function(e) {
      const form = e.target;
      sendToParent('form_submit', {
        formId: form.id || null,
        formAction: form.action || null,
        formMethod: form.method || 'GET'
      });
    }, true);
  }

  // Notifica che il monitor è pronto
  function init() {
    setupDataLayerMonitor();
    setupNetworkMonitor();
    setupFormMonitor();
    sendToParent('monitor_ready', { url: window.location.href });
  }

  // Avvia quando il DOM è pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
`;

// Fetch di una pagina esterna
async function fetchPage(targetUrl) {
  return new Promise((resolve, reject) => {
    const protocol = targetUrl.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8'
      }
    };

    const request = protocol.get(targetUrl, options, (response) => {
      // Segui redirect
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const baseUrl = new URL(targetUrl);
          redirectUrl = baseUrl.origin + redirectUrl;
        }
        return fetchPage(redirectUrl).then(resolve).catch(reject);
      }

      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ html: data, finalUrl: targetUrl }));
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// Modifica HTML per il proxy
function processHtmlForProxy(html, baseUrl) {
  const baseUrlObj = new URL(baseUrl);
  const baseOrigin = baseUrlObj.origin;
  const basePath = baseUrlObj.pathname.replace(/[^/]*$/, '');

  // Aggiungi tag base per risolvere URL relativi
  const baseTag = `<base href="${baseOrigin}${basePath}">`;

  // Inietta script monitor dopo <head> o all'inizio
  let modifiedHtml = html;

  if (modifiedHtml.includes('<head>')) {
    modifiedHtml = modifiedHtml.replace('<head>', '<head>' + baseTag + MONITOR_SCRIPT);
  } else if (modifiedHtml.includes('<html>')) {
    modifiedHtml = modifiedHtml.replace('<html>', '<html><head>' + baseTag + MONITOR_SCRIPT + '</head>');
  } else {
    modifiedHtml = baseTag + MONITOR_SCRIPT + modifiedHtml;
  }

  return modifiedHtml;
}

// Store dei report in memoria (in produzione usare database)
const reports = new Map();

// Genera ID univoco
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Parse del body JSON
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// Serve file statici
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
}

// Handler principale
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Routes
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, path.join(__dirname, 'index.html'));
  }
  else if (url.pathname === '/report.html') {
    serveStatic(res, path.join(__dirname, 'report.html'));
  }
  else if (url.pathname === '/form-test.html') {
    serveStatic(res, path.join(__dirname, 'form-test.html'));
  }
  else if (url.pathname === '/proxy') {
    // Proxy per iframe con script injection
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('URL richiesto');
      return;
    }

    try {
      console.log(`Proxy request: ${targetUrl}`);
      const { html, finalUrl } = await fetchPage(targetUrl);
      const modifiedHtml = processHtmlForProxy(html, finalUrl);

      // Rimuovi header che bloccano iframe
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'ALLOWALL',
        'Content-Security-Policy': ''
      });
      res.end(modifiedHtml);
    } catch (err) {
      console.error('Proxy error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Errore proxy: ' + err.message);
    }
  }
  else if (url.pathname === '/scan' && req.method === 'POST') {
    // Avvia scansione
    try {
      const body = await parseBody(req);
      const { url: targetUrl, timeout, visible } = body;

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
        return;
      }

      console.log(`Avvio scansione: ${targetUrl}`);

      const scanner = new CookieAuditScanner(targetUrl, {
        headless: !visible,
        timeout: timeout || 10000
      });

      const report = await scanner.run();
      const reportId = generateId();
      reports.set(reportId, report);

      console.log(`Scansione completata: ${reportId}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reportId }));
    } catch (err) {
      console.error('Errore scansione:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/report\/[^/]+\/form-test$/) && req.method === 'POST') {
    // Salva risultati test form nel report e unisce gli eventi
    const reportId = url.pathname.split('/')[3];
    const report = reports.get(reportId);

    if (!report) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Report non trovato' }));
      return;
    }

    try {
      const body = await parseBody(req);

      // Inizializza array formTest se non esiste
      if (!report.events.formTest) {
        report.events.formTest = [];
      }

      // Converti eventi dal form test nel formato del report
      const formTestEvents = (body.events || []).map(e => {
        let tracker = 'Form Test';
        let eventName = 'unknown';
        let eventCategory = 'custom';

        if (e.type === 'dataLayer' && e.data?.event) {
          tracker = 'DataLayer';
          eventName = e.data.event;
          // Categorizza
          if (['form_submit', 'form_start', 'generate_lead', 'purchase'].includes(eventName.toLowerCase())) {
            eventCategory = 'conversion';
          }
        } else if (e.type === 'network' && e.data) {
          tracker = e.data.tracker || 'Network';
          eventName = e.data.event || 'request';
          if (['form_submit', 'generate_lead', 'Lead', 'Purchase'].includes(eventName)) {
            eventCategory = 'conversion';
          }
        } else if (e.type === 'form_submit') {
          tracker = 'DOM';
          eventName = 'form_submit';
          eventCategory = 'conversion';
        }

        return {
          tracker,
          event: eventName,
          eventCategory,
          timestamp: new Date(e.timestamp).toISOString(),
          phase: 'FORM_TEST',
          source: 'form_test',
          rawData: e.data
        };
      });

      // Aggiungi eventi al report
      report.events.formTest = formTestEvents;

      // Salva anche i metadata del test
      report.formTest = {
        timestamp: body.timestamp,
        formEventCounts: body.formEventCounts,
        success: body.success,
        totalEvents: formTestEvents.length
      };

      // Aggiorna summary
      if (report.summary && report.summary.events) {
        report.summary.events.formTest = formTestEvents.length;
        report.summary.events.total = (report.summary.events.total || 0) + formTestEvents.length;

        // Aggiorna byTracker
        formTestEvents.forEach(e => {
          if (!report.summary.events.byTracker[e.tracker]) {
            report.summary.events.byTracker[e.tracker] = {};
          }
          const cat = e.eventCategory || 'custom';
          if (!report.summary.events.byTracker[e.tracker][cat]) {
            report.summary.events.byTracker[e.tracker][cat] = [];
          }
          // Evita duplicati
          const exists = report.summary.events.byTracker[e.tracker][cat].some(ev => ev.name === e.event);
          if (!exists) {
            report.summary.events.byTracker[e.tracker][cat].push({ name: e.event });
          }
        });
      }

      console.log(`Form test salvato per report ${reportId}: ${formTestEvents.length} eventi`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, eventsAdded: formTestEvents.length }));
    } catch (err) {
      console.error('Errore salvataggio form test:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.startsWith('/api/report/')) {
    // Recupera report
    const reportId = url.pathname.split('/').pop();
    const report = reports.get(reportId);

    if (report) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, report }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Report non trovato' }));
    }
  }
  else {
    res.writeHead(404);
    res.end('Not found');
  }
}

// Avvia server
const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Server avviato: http://localhost:${PORT}`);
});
