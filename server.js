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

  // Funzione per inviare eventi al parent
  function sendToParent(type, data) {
    // Sanitizza i dati rimuovendo elementi DOM e oggetti non serializzabili
    function sanitize(obj, depth = 0) {
      if (depth > 5) return '[max depth]';
      if (obj === null || obj === undefined) return obj;
      if (typeof obj !== 'object') return obj;
      if (obj instanceof Element || obj instanceof Node) return '[DOM Element]';
      if (obj instanceof Event) return '[Event]';
      if (typeof obj.tagName === 'string') return '[DOM Element]';

      if (Array.isArray(obj)) {
        return obj.map(item => sanitize(item, depth + 1));
      }

      const sanitized = {};
      for (const key in obj) {
        try {
          const val = obj[key];
          if (typeof val === 'function') continue;
          sanitized[key] = sanitize(val, depth + 1);
        } catch(e) {
          sanitized[key] = '[unserializable]';
        }
      }
      return sanitized;
    }

    try {
      const safeData = sanitize(data);
      console.log('[ATT Monitor] sendToParent:', type, safeData);
      window.parent.postMessage({ type, data: safeData, timestamp: Date.now() }, PARENT_ORIGIN);
    } catch(e) {
      console.error('[ATT Monitor] postMessage error:', e);
    }
  }

  // Monitora dataLayer con polling diretto sull'array
  function setupDataLayerMonitor() {
    let lastLength = 0;
    let lastDataLayer = null;
    let pollCount = 0;

    function checkDataLayer() {
      try {
        pollCount++;

        // Log ogni 5 secondi (circa 166 poll a 30ms)
        if (pollCount % 166 === 0) {
          console.log('[ATT Monitor] Polling attivo, count:', pollCount, 'dataLayer length:', window.dataLayer ? window.dataLayer.length : 'N/A');
        }

        // Assicurati che dataLayer esista
        if (!window.dataLayer) {
          window.dataLayer = [];
        }

        // Se dataLayer è cambiato (nuovo array)
        if (window.dataLayer !== lastDataLayer) {
          lastDataLayer = window.dataLayer;
          lastLength = 0;
          console.log('[ATT Monitor] Nuovo dataLayer rilevato');
        }

        // Controlla se ci sono nuovi elementi
        const currentLength = window.dataLayer.length;
        if (currentLength > lastLength) {
          // Processa i nuovi elementi
          for (let i = lastLength; i < currentLength; i++) {
            const item = window.dataLayer[i];
            if (item && typeof item === 'object') {
              const eventName = item.event || item[0];
              if (eventName) {
                console.log('[ATT Monitor] Nuovo evento dataLayer:', eventName);
                sendToParent('dataLayer', { event: eventName, data: item });
              }
            }
          }
          lastLength = currentLength;
        }
      } catch(e) {
        console.error('[ATT Monitor] Errore in checkDataLayer:', e);
      }
    }

    // Polling molto frequente (ogni 30ms)
    setInterval(checkDataLayer, 30);

    // Controlla subito
    checkDataLayer();
    console.log('[ATT Monitor] dataLayer polling attivato');
  }

  // Monitora richieste di rete con tutti i metodi possibili
  function setupNetworkMonitor() {
    // Set per deduplicazione (URL + timestamp arrotondato)
    const processedRequests = new Set();

    function isDuplicate(url) {
      // Estrai il nome evento (en=...) per includerlo nella chiave
      let eventName = '';
      try {
        const urlObj = new URL(url);
        eventName = urlObj.searchParams.get('en') || '';
      } catch(e) {
        const match = url.match(/[&?]en=([^&]+)/);
        if (match) eventName = match[1];
      }

      // Crea chiave basata su dominio + path + evento + timestamp
      const urlBase = url.split('?')[0].substring(0, 100);
      const timeKey = Math.floor(Date.now() / 500); // 500ms window
      const key = urlBase + '|' + eventName + '|' + timeKey;

      if (processedRequests.has(key)) {
        return true;
      }
      processedRequests.add(key);

      // Pulisci vecchie entry dopo 3 secondi
      setTimeout(() => processedRequests.delete(key), 3000);
      return false;
    }

    // 1. PerformanceObserver per catturare tutte le richieste completate
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach(entry => {
          if (!isDuplicate(entry.name)) {
            checkTrackingRequest(entry.name, null);
          }
        });
      });
      observer.observe({ entryTypes: ['resource'] });
      // Cattura anche le richieste già fatte
      performance.getEntriesByType('resource').forEach(entry => {
        if (!isDuplicate(entry.name)) {
          checkTrackingRequest(entry.name, null);
        }
      });
      console.log('[ATT Monitor] PerformanceObserver attivato');
    } catch(e) {
      console.error('[ATT Monitor] PerformanceObserver errore:', e);
    }

    // 2. Intercetta sendBeacon (usato da GA4)
    const originalBeacon = navigator.sendBeacon;
    if (originalBeacon) {
      navigator.sendBeacon = function(url, data) {
        if (!isDuplicate(url)) {
          let body = data;
          if (typeof data === 'string') {
            body = data;
          }
          checkTrackingRequest(url, body);
        }
        return originalBeacon.apply(this, arguments);
      };
    }

    // 3. Intercetta fetch (POST requests)
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url ? url.url : '');
      if (!isDuplicate(urlStr)) {
        checkTrackingRequest(urlStr, options?.body);
      }
      return originalFetch.apply(this, arguments);
    };

    // 4. Intercetta XHR
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._url = url;
      return originalXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      if (!isDuplicate(this._url)) {
        checkTrackingRequest(this._url, body);
      }
      return originalXHRSend.apply(this, arguments);
    };

    // 5. Intercetta Image (pixel tracking)
    const OriginalImage = window.Image;
    window.Image = function(w, h) {
      const img = new OriginalImage(w, h);
      const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(img, 'src', {
        set: function(val) {
          if (!isDuplicate(val)) {
            checkTrackingRequest(val, null);
          }
          return originalSrcDescriptor.set.call(this, val);
        },
        get: function() {
          return originalSrcDescriptor.get.call(this);
        }
      });
      return img;
    };
    window.Image.prototype = OriginalImage.prototype;
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
        // Estrai evento/i
        let eventNames = [];
        try {
          const urlObj = new URL(url);
          const urlEvent = urlObj.searchParams.get('en') || urlObj.searchParams.get('ev');
          if (urlEvent) {
            eventNames.push(urlEvent);
          }

          // Cerca nel body per GA4 (batch di eventi)
          if (body && tracker === 'GA4') {
            const matches = body.match(/en=([^&\\r\\n]+)/g);
            if (matches) {
              matches.forEach(m => {
                const evName = m.replace('en=', '');
                if (!eventNames.includes(evName)) {
                  eventNames.push(evName);
                }
              });
            }
          }
        } catch(e) {}

        // Invia un evento separato per ogni nome evento
        if (eventNames.length === 0) {
          sendToParent('network', {
            tracker,
            url: url.substring(0, 200),
            event: null
          });
        } else {
          eventNames.forEach(eventName => {
            sendToParent('network', {
              tracker,
              url: url.substring(0, 200),
              event: eventName
            });
          });
        }
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

  // Intercetta navigazioni per mantenerle nel proxy
  function setupNavigationInterceptor() {
    // Ottieni l'URL base del sito originale dal proxy
    const proxyUrl = new URL(window.location.href);
    const originalUrl = proxyUrl.searchParams.get('url');
    let originalOrigin = '';
    try {
      originalOrigin = new URL(originalUrl).origin;
    } catch(e) {}

    document.addEventListener('click', function(e) {
      const link = e.target.closest('a');
      if (!link) return;

      const href = link.getAttribute('href');
      if (!href) return;

      console.log('[ATT Monitor] Click su link:', href);

      // Link anchor puro (#something) - gestisci manualmente lo scroll
      // (necessario perché il tag <base> causa navigazione completa)
      if (href.startsWith('#')) {
        e.preventDefault();
        e.stopPropagation();
        console.log('[ATT Monitor] Anchor puro, scroll manuale a:', href);
        const element = document.querySelector(href);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth' });
        }
        // Notifica l'evento di click al parent (per tracking)
        sendToParent('anchor_click', { hash: href });
        return;
      }

      // Costruisci URL completo
      let fullUrl;
      try {
        if (href.startsWith('http')) {
          fullUrl = new URL(href);
        } else if (href.startsWith('/')) {
          fullUrl = new URL(originalOrigin + href);
        } else {
          // URL relativo
          fullUrl = new URL(href, originalUrl);
        }
      } catch(e) {
        console.log('[ATT Monitor] URL non valido:', href);
        return;
      }

      // Se è lo stesso dominio, reindirizza attraverso il proxy
      if (fullUrl.origin === originalOrigin) {
        e.preventDefault();
        e.stopPropagation();

        // Se ha un hash, gestiamo lo scroll dopo il caricamento
        const hash = fullUrl.hash;

        // Controlla se è solo un cambio di hash sulla stessa pagina
        const currentPath = new URL(originalUrl).pathname;
        if (fullUrl.pathname === currentPath && hash) {
          // Stesso path, solo hash diverso - fai scroll senza ricaricare
          console.log('[ATT Monitor] Stesso path, scroll a:', hash);
          const element = document.querySelector(hash);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
          }
          return;
        }

        // Pagina diversa - ricarica attraverso proxy
        const newProxyUrl = '/proxy?url=' + encodeURIComponent(fullUrl.href);
        console.log('[ATT Monitor] Redirect a proxy:', newProxyUrl);
        window.location.href = newProxyUrl;
      }
      // Link esterni (altro dominio) - lascia passare normalmente
    }, true);

    console.log('[ATT Monitor] Navigation interceptor attivo');
  }

  // Notifica che il monitor è pronto
  function init() {
    // DataLayer e Network monitoring devono partire SUBITO
    // prima che GTM possa catturare i riferimenti originali
    setupDataLayerMonitor();
    setupNetworkMonitor();
    console.log('[ATT Monitor] Network e DataLayer monitor attivati');

    // DEBUG: Monitora eventi di navigazione
    window.addEventListener('beforeunload', function(e) {
      console.log('[ATT Monitor] !!! BEFOREUNLOAD - pagina sta per uscire');
    });
    window.addEventListener('unload', function(e) {
      console.log('[ATT Monitor] !!! UNLOAD - pagina uscita');
    });
    window.addEventListener('hashchange', function(e) {
      console.log('[ATT Monitor] HASHCHANGE:', e.oldURL, '->', e.newURL);
      sendToParent('navigation', { type: 'hashchange', from: e.oldURL, to: e.newURL });
    });
    window.addEventListener('popstate', function(e) {
      console.log('[ATT Monitor] POPSTATE:', e.state);
      sendToParent('navigation', { type: 'popstate', state: e.state });
    });

    // Form monitor e navigation interceptor hanno bisogno del DOM
    function setupFormWhenReady() {
      setupFormMonitor();
      setupNavigationInterceptor();
      sendToParent('monitor_ready', { url: window.location.href });
      console.log('[ATT Monitor] Form monitor attivato');
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupFormWhenReady);
    } else {
      setupFormWhenReady();
    }
  }

  // ESEGUI SUBITO - non aspettare
  init();
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
