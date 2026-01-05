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

  // Verifica se è una richiesta di tracking - approccio ampio
  function checkTrackingRequest(url, body) {
    if (!url) return;

    // Classifica per dominio in modo ampio
    // ORDINE IMPORTANTE: più specifici prima dei generici
    function classifyTracker(url) {
      const u = url.toLowerCase();

      // GTM (solo il loader) - prima di tutto
      if (u.includes('googletagmanager.com/gtm.js') ||
          u.includes('googletagmanager.com/gtag/js')) {
        return 'GTM';
      }

      // Google Ads - PRIMA di GA4 perché googlesyndication può avere /collect
      if (u.includes('googleadservices.com') ||
          u.includes('googlesyndication.com') ||
          u.includes('doubleclick.net') ||
          u.includes('googleads.') ||
          (u.includes('google.com') && u.includes('/pagead/'))) {
        return 'Google Ads';
      }

      // GA4 - tutti gli endpoint possibili (incluso server-side)
      if (u.includes('google-analytics.com') ||
          u.includes('analytics.google.com') ||
          u.includes('/g/collect') ||
          u.includes('stape.net') ||
          u.includes('stape.io') ||
          u.includes('tagging-server') ||
          u.includes('sgtm.')) {
        return 'GA4';
      }

      // Facebook/Meta
      if (u.includes('facebook.com/tr') ||
          u.includes('facebook.net') ||
          u.includes('fbq') ||
          u.includes('connect.facebook')) {
        return 'Facebook';
      }

      // LinkedIn
      if (u.includes('linkedin.com') ||
          u.includes('licdn.com') ||
          u.includes('snap.licdn')) {
        return 'LinkedIn';
      }

      // TikTok
      if (u.includes('tiktok.com') && u.includes('analytics')) {
        return 'TikTok';
      }

      // Hotjar
      if (u.includes('hotjar.com') || u.includes('hotjar.io')) {
        return 'Hotjar';
      }

      // Cookiebot/CMP
      if (u.includes('cookiebot.com') || u.includes('consentcdn')) {
        return 'Cookiebot';
      }

      return null;
    }

    const tracker = classifyTracker(url);
    if (!tracker) return;

    // Estrai eventi dal URL e body
    let eventNames = [];
    try {
      const urlObj = new URL(url);

      // Parametri comuni per eventi
      const eventParams = ['en', 'ev', 'event', 'e', 'ea', 'ec'];
      for (const param of eventParams) {
        const val = urlObj.searchParams.get(param);
        if (val && !eventNames.includes(val)) {
          eventNames.push(val);
        }
      }

      // Cerca nel body (GA4 usa POST con eventi multipli)
      if (body && typeof body === 'string') {
        const matches = body.match(/en=([^&\\r\\n]+)/g);
        if (matches) {
          matches.forEach(m => {
            const evName = decodeURIComponent(m.replace('en=', ''));
            if (!eventNames.includes(evName)) {
              eventNames.push(evName);
            }
          });
        }
      }
    } catch(e) {
      console.log('[ATT Monitor] Errore parsing URL:', e);
    }

    // Invia un evento separato per ogni nome evento trovato
    if (eventNames.length === 0) {
      sendToParent('network', {
        tracker,
        url: url.substring(0, 300),
        event: null
      });
    } else {
      eventNames.forEach(eventName => {
        sendToParent('network', {
          tracker,
          url: url.substring(0, 300),
          event: eventName
        });
      });
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

// Store per bulk scans
const bulkScans = new Map();

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

// Esegue bulk scan con concorrenza limitata
async function runBulkScan(batchId) {
  const batch = bulkScans.get(batchId);
  if (!batch) return;

  const CONCURRENCY = 3; // Max scansioni parallele
  let running = 0;
  let index = 0;
  const scanTimes = []; // Per calcolare media

  function next() {
    // Avvia nuove scansioni se possibile
    while (running < CONCURRENCY && index < batch.results.length) {
      const i = index++;
      const result = batch.results[i];

      running++;
      result.status = 'running';
      result.startTime = Date.now();

      console.log(`[Bulk ${batchId}] Scansione ${i + 1}/${batch.total}: ${result.url}`);

      // Notifica inizio via SSE
      updateScanPhase(batch, i, 'starting', 'Avvio...');

      scanSingleUrlWithPhases(batch, i, result)
        .then(() => {
          result.status = 'completed';
          result.endTime = Date.now();
          batch.completed++;

          // Calcola tempo e aggiorna media
          const scanTime = result.endTime - result.startTime;
          scanTimes.push(scanTime);
          batch.avgScanTime = Math.round(scanTimes.reduce((a, b) => a + b, 0) / scanTimes.length);

          console.log(`[Bulk ${batchId}] Completata ${batch.completed}/${batch.total}: ${result.url} -> ${result.verdict} (${Math.round(scanTime/1000)}s)`);

          // Notifica completamento via SSE
          sendSSE(batch, 'complete', {
            index: i,
            result: result,
            completed: batch.completed,
            total: batch.total,
            avgScanTime: batch.avgScanTime
          });
        })
        .catch(err => {
          result.status = 'error';
          result.error = err.message;
          result.endTime = Date.now();
          batch.completed++;
          console.error(`[Bulk ${batchId}] Errore ${batch.completed}/${batch.total}: ${result.url} -> ${err.message}`);

          // Notifica errore via SSE
          sendSSE(batch, 'error', {
            index: i,
            url: result.url,
            error: err.message,
            completed: batch.completed,
            total: batch.total
          });
        })
        .finally(() => {
          running--;
          next();
        });
    }

    // Controlla se tutto è completato
    if (running === 0 && batch.completed >= batch.total) {
      batch.status = 'completed';
      batch.endTime = Date.now();
      console.log(`[Bulk ${batchId}] Batch completato in ${(batch.endTime - batch.startTime) / 1000}s`);

      // Notifica fine batch via SSE
      sendSSE(batch, 'done', {
        batchId: batch.batchId,
        totalTime: batch.endTime - batch.startTime,
        avgScanTime: batch.avgScanTime
      });
    }
  }

  // Inizia
  next();
}

// Scansiona singolo URL con aggiornamento fasi via SSE
async function scanSingleUrlWithPhases(batch, index, result) {
  // Callback per aggiornamento fasi
  const onPhase = (phase, label) => {
    updateScanPhase(batch, index, phase, label);
  };

  onPhase('loading', 'Caricamento pagina...');

  const scanner = new CookieAuditScanner(result.url, {
    headless: true,
    timeout: 10000,
    onPhase: onPhase // Passa callback al scanner
  });

  const report = await scanner.run();
  const reportId = generateId();
  reports.set(reportId, report);

  // Estrai dati riassuntivi dal report
  result.reportId = reportId;
  result.cmp = report.cmp?.type || null;
  result.violations = report.violations?.length || 0;

  // Calcola verdetto basato su violazioni
  if (result.violations > 0) {
    result.verdict = 'NON CONFORME';
  } else if (report.cmp?.detected) {
    result.verdict = 'CONFORME';
  } else {
    result.verdict = 'DA VERIFICARE';
  }

  // Estrai lista tracker unici (da events.byTracker)
  const trackers = new Set();
  if (report.summary?.events?.byTracker) {
    Object.keys(report.summary.events.byTracker).forEach(t => {
      // Semplifica nomi tracker
      if (t.includes('GA4') || t.includes('Google Analytics')) trackers.add('GA4');
      else if (t.includes('Facebook') || t.includes('Meta')) trackers.add('Facebook');
      else if (t.includes('LinkedIn')) trackers.add('LinkedIn');
      else if (t.includes('TikTok')) trackers.add('TikTok');
      else if (t.includes('Hotjar')) trackers.add('Hotjar');
      else if (t.includes('Google Ads')) trackers.add('Google Ads');
      else if (!t.includes('GTM') && !t.includes('Cookiebot') && !t.includes('OneTrust') && !t.includes('iubenda')) {
        trackers.add(t);
      }
    });
  }
  result.trackers = Array.from(trackers);

  onPhase('done', 'Completato');
}

// Invia evento SSE a tutti i client connessi per un batch
function sendSSE(batch, eventType, data) {
  if (!batch.sseClients || batch.sseClients.length === 0) return;

  const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

  batch.sseClients = batch.sseClients.filter(client => {
    try {
      client.write(message);
      return true;
    } catch (e) {
      return false; // Rimuovi client disconnessi
    }
  });
}

// Aggiorna fase di una scansione e notifica via SSE
function updateScanPhase(batch, index, phase, phaseLabel) {
  const result = batch.results[index];
  result.phase = phase;
  result.phaseLabel = phaseLabel;

  sendSSE(batch, 'phase', {
    index,
    url: result.url,
    phase,
    phaseLabel,
    completed: batch.completed,
    total: batch.total
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
  else if (url.pathname === '/bulk-scan.html') {
    serveStatic(res, path.join(__dirname, 'bulk-scan.html'));
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
  // === BULK SCAN API ===
  else if (url.pathname === '/api/bulk-scan' && req.method === 'POST') {
    // Avvia bulk scan
    try {
      const body = await parseBody(req);
      const { urls } = body;

      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Lista URL richiesta' }));
        return;
      }

      // Limita a 50 URL per batch
      const limitedUrls = urls.slice(0, 50);

      const batchId = generateId();
      const batch = {
        batchId,
        status: 'running',
        total: limitedUrls.length,
        completed: 0,
        startTime: Date.now(),
        avgScanTime: null, // Media tempo scansione per stima
        sseClients: [], // Client SSE connessi
        results: limitedUrls.map(u => ({
          url: u,
          status: 'pending',
          phase: null, // Fase corrente: 'loading', 'pre_consent', 'consent', 'post_consent', 'interactions'
          phaseLabel: null, // Label leggibile
          startTime: null,
          endTime: null,
          reportId: null,
          verdict: null,
          cmp: null,
          violations: null,
          trackers: [],
          error: null
        }))
      };

      bulkScans.set(batchId, batch);

      console.log(`Bulk scan avviato: ${batchId} con ${limitedUrls.length} URL`);

      // Avvia scansioni in background
      runBulkScan(batchId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, batchId, total: limitedUrls.length }));
    } catch (err) {
      console.error('Errore avvio bulk scan:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/export$/) && req.method === 'GET') {
    // Export risultati bulk scan
    const batchId = url.pathname.split('/')[3];
    const format = url.searchParams.get('format') || 'json';
    const batch = bulkScans.get(batchId);

    if (!batch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
      return;
    }

    const filename = `bulk-scan-${batchId}-${new Date().toISOString().split('T')[0]}`;

    if (format === 'csv') {
      // Export CSV
      const headers = ['#', 'URL', 'Status', 'Verdetto', 'CMP', 'Violazioni', 'Tracker'];
      const rows = batch.results.map((r, i) => [
        i + 1,
        `"${r.url}"`,
        r.status,
        r.verdict || '',
        r.cmp || '',
        r.violations !== null ? r.violations : '',
        `"${(r.trackers || []).join(', ')}"`
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}.csv"`
      });
      res.end(csv);
    } else {
      // Export JSON
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}.json"`
      });
      res.end(JSON.stringify(batch, null, 2));
    }
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/stream$/) && req.method === 'GET') {
    // SSE stream per aggiornamenti real-time
    const batchId = url.pathname.split('/')[3];
    const batch = bulkScans.get(batchId);

    if (!batch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
      return;
    }

    // Setup SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Invia stato iniziale
    res.write(`event: init\ndata: ${JSON.stringify({
      batchId: batch.batchId,
      status: batch.status,
      total: batch.total,
      completed: batch.completed,
      avgScanTime: batch.avgScanTime,
      results: batch.results
    })}\n\n`);

    // Aggiungi client alla lista
    batch.sseClients.push(res);

    // Rimuovi client quando si disconnette
    req.on('close', () => {
      const idx = batch.sseClients.indexOf(res);
      if (idx > -1) batch.sseClients.splice(idx, 1);
    });
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+$/) && req.method === 'GET') {
    // Stato bulk scan
    const batchId = url.pathname.split('/').pop();
    const batch = bulkScans.get(batchId);

    if (!batch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      batchId: batch.batchId,
      status: batch.status,
      total: batch.total,
      completed: batch.completed,
      avgScanTime: batch.avgScanTime,
      results: batch.results
    }));
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
