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

  function sendToParent(type, data) {
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

  function setupDataLayerMonitor() {
    let lastLength = 0;
    let lastDataLayer = null;
    let pollCount = 0;

    function checkDataLayer() {
      try {
        pollCount++;
        if (pollCount % 166 === 0) {
          console.log('[ATT Monitor] Polling attivo, count:', pollCount, 'dataLayer length:', window.dataLayer ? window.dataLayer.length : 'N/A');
        }

        if (!window.dataLayer) {
          window.dataLayer = [];
        }

        if (window.dataLayer !== lastDataLayer) {
          lastDataLayer = window.dataLayer;
          lastLength = 0;
          console.log('[ATT Monitor] Nuovo dataLayer rilevato');
        }

        const currentLength = window.dataLayer.length;
        if (currentLength > lastLength) {
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

    setInterval(checkDataLayer, 30);
    checkDataLayer();
    console.log('[ATT Monitor] dataLayer polling attivato');
  }

  function setupNetworkMonitor() {
    const processedRequests = new Set();

    function isDuplicate(url) {
      let eventName = '';
      try {
        const urlObj = new URL(url);
        eventName = urlObj.searchParams.get('en') || '';
      } catch(e) {
        const match = url.match(/[&?]en=([^&]+)/);
        if (match) eventName = match[1];
      }

      const urlBase = url.split('?')[0].substring(0, 100);
      const timeKey = Math.floor(Date.now() / 500);
      const key = urlBase + '|' + eventName + '|' + timeKey;

      if (processedRequests.has(key)) {
        return true;
      }
      processedRequests.add(key);

      setTimeout(() => processedRequests.delete(key), 3000);
      return false;
    }

    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach(entry => {
          if (!isDuplicate(entry.name)) {
            checkTrackingRequest(entry.name, null);
          }
        });
      });
      observer.observe({ entryTypes: ['resource'] });
      performance.getEntriesByType('resource').forEach(entry => {
        if (!isDuplicate(entry.name)) {
          checkTrackingRequest(entry.name, null);
        }
      });
      console.log('[ATT Monitor] PerformanceObserver attivato');
    } catch(e) {
      console.error('[ATT Monitor] PerformanceObserver errore:', e);
    }

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

    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url ? url.url : '');
      if (!isDuplicate(urlStr)) {
        checkTrackingRequest(urlStr, options?.body);
      }
      return originalFetch.apply(this, arguments);
    };

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

  function checkTrackingRequest(url, body) {
    if (!url) return;

    function classifyTracker(url) {
      const u = url.toLowerCase();

      if (u.includes('googletagmanager.com/gtm.js') ||
          u.includes('googletagmanager.com/gtag/js')) {
        return 'GTM';
      }

      if (u.includes('googleadservices.com') ||
          u.includes('googlesyndication.com') ||
          u.includes('doubleclick.net') ||
          u.includes('googleads.') ||
          (u.includes('google.com') && u.includes('/pagead/'))) {
        return 'Google Ads';
      }

      if (u.includes('google-analytics.com') ||
          u.includes('analytics.google.com') ||
          u.includes('/g/collect') ||
          u.includes('stape.net') ||
          u.includes('stape.io') ||
          u.includes('tagging-server') ||
          u.includes('sgtm.')) {
        return 'GA4';
      }

      if (u.includes('facebook.com/tr') ||
          u.includes('facebook.net') ||
          u.includes('fbq') ||
          u.includes('connect.facebook')) {
        return 'Facebook';
      }

      if (u.includes('linkedin.com') ||
          u.includes('licdn.com') ||
          u.includes('snap.licdn')) {
        return 'LinkedIn';
      }

      if (u.includes('tiktok.com') && u.includes('analytics')) {
        return 'TikTok';
      }

      if (u.includes('hotjar.com') || u.includes('hotjar.io')) {
        return 'Hotjar';
      }

      if (u.includes('cookiebot.com') || u.includes('consentcdn')) {
        return 'Cookiebot';
      }

      return null;
    }

    const tracker = classifyTracker(url);
    if (!tracker) return;

    let eventNames = [];
    try {
      const urlObj = new URL(url);

      const eventParams = ['en', 'ev', 'event', 'e', 'ea', 'ec'];
      for (const param of eventParams) {
        const val = urlObj.searchParams.get(param);
        if (val && !eventNames.includes(val)) {
          eventNames.push(val);
        }
      }

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

  function setupNavigationInterceptor() {
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

      if (href.startsWith('#')) {
        e.preventDefault();
        e.stopPropagation();
        console.log('[ATT Monitor] Anchor puro, scroll manuale a:', href);
        const element = document.querySelector(href);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth' });
        }
        sendToParent('anchor_click', { hash: href });
        return;
      }

      let fullUrl;
      try {
        if (href.startsWith('http')) {
          fullUrl = new URL(href);
        } else if (href.startsWith('/')) {
          fullUrl = new URL(originalOrigin + href);
        } else {
          fullUrl = new URL(href, originalUrl);
        }
      } catch(e) {
        console.log('[ATT Monitor] URL non valido:', href);
        return;
      }

      if (fullUrl.origin === originalOrigin) {
        e.preventDefault();
        e.stopPropagation();

        const hash = fullUrl.hash;
        const currentPath = new URL(originalUrl).pathname;
        if (fullUrl.pathname === currentPath && hash) {
          console.log('[ATT Monitor] Stesso path, scroll a:', hash);
          const element = document.querySelector(hash);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
          }
          return;
        }

        const params = new URLSearchParams();
        params.set('url', fullUrl.href);
        const newProxyUrl = '/proxy?' + params.toString();
        console.log('[ATT Monitor] Redirect a proxy:', newProxyUrl);
        window.location.href = newProxyUrl;
      }
    }, true);

    console.log('[ATT Monitor] Navigation interceptor attivo');
  }

  function init() {
    setupDataLayerMonitor();
    setupNetworkMonitor();
    console.log('[ATT Monitor] Network e DataLayer monitor attivati');

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

  const baseTag = `<base href="${baseOrigin}${basePath}">`;
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

// === REPORT STORE CON TTL ===
class ReportStore {
  constructor(ttl = 3600000) { // 1 ora default
    this.reports = new Map();
    this.ttl = ttl;
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup ogni minuto
  }

  set(id, report) {
    this.reports.set(id, { ...report, _timestamp: Date.now() });
  }

  get(id) {
    const item = this.reports.get(id);
    if (!item) return null;
    
    // Verifica TTL
    if (Date.now() - item._timestamp > this.ttl) {
      this.reports.delete(id);
      return null;
    }
    
    return item;
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [id, item] of this.reports) {
      if (now - item._timestamp > this.ttl) {
        this.reports.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[ReportStore] Puliti ${removed} report scaduti`);
    }
  }

  dispose() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// === BULK SCAN STORE CON SSE ===
class BulkScanStore {
  constructor() {
    this.batches = new Map();
    this.batchLocks = new Set(); // Lock per prevenire race conditions
  }

  createBatch(urls) {
    const batchId = generateId();
    const batch = {
      batchId,
      status: 'running',
      total: urls.length,
      completed: 0,
      startTime: Date.now(),
      avgScanTime: null,
      sseClients: [],
      results: urls.map(u => ({
        url: u,
        status: 'pending',
        phase: null,
        phaseLabel: null,
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
    this.batches.set(batchId, batch);
    return batch;
  }

  getBatch(batchId) {
    return this.batches.get(batchId);
  }

  addSSEClient(batchId, client) {
    const batch = this.batches.get(batchId);
    if (!batch) return false;
    
    batch.sseClients.push(client);
    
    // Rimuovi client quando si disconnette
    client.on('close', () => {
      const idx = batch.sseClients.indexOf(client);
      if (idx > -1) batch.sseClients.splice(idx, 1);
    });
    
    return true;
  }

  sendSSE(batchId, eventType, data) {
    const batch = this.batches.get(batchId);
    if (!batch || !batch.sseClients.length) return;

    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    
    batch.sseClients = batch.sseClients.filter(client => {
      try {
        client.write(message);
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  updatePhase(batchId, index, phase, phaseLabel) {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const result = batch.results[index];
    result.phase = phase;
    result.phaseLabel = phaseLabel;

    this.sendSSE(batchId, 'phase', {
      index,
      url: result.url,
      phase,
      phaseLabel,
      completed: batch.completed,
      total: batch.total
    });
  }

  completeScan(batchId, index, resultData) {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const result = batch.results[index];
    Object.assign(result, resultData);
    result.endTime = Date.now();
    batch.completed++;

    // Calcola media tempo
    const scanTime = result.endTime - result.startTime;
    if (!batch.avgScanTime) {
      batch.avgScanTime = scanTime;
    } else {
      batch.avgScanTime = (batch.avgScanTime + scanTime) / 2;
    }

    this.sendSSE(batchId, 'complete', {
      index,
      result,
      completed: batch.completed,
      total: batch.total,
      avgScanTime: Math.round(batch.avgScanTime)
    });

    // Verifica se tutto completato
    if (batch.completed >= batch.total) {
      batch.status = 'completed';
      batch.endTime = Date.now();
      this.sendSSE(batchId, 'done', {
        batchId,
        totalTime: batch.endTime - batch.startTime,
        avgScanTime: Math.round(batch.avgScanTime)
      });
    }
  }

  errorScan(batchId, index, error) {
    const batch = this.batches.get(batchId);
    if (!batch) return;

    const result = batch.results[index];
    result.status = 'error';
    result.error = error;
    result.endTime = Date.now();
    batch.completed++;

    this.sendSSE(batchId, 'error', {
      index,
      url: result.url,
      error,
      completed: batch.completed,
      total: batch.total
    });

    if (batch.completed >= batch.total) {
      batch.status = 'completed';
      batch.endTime = Date.now();
    }
  }

  isLocked(batchId) {
    return this.batchLocks.has(batchId);
  }

  lock(batchId) {
    this.batchLocks.add(batchId);
  }

  unlock(batchId) {
    this.batchLocks.delete(batchId);
  }

  getExport(batchId, format) {
    const batch = this.batches.get(batchId);
    if (!batch) return null;

    if (format === 'csv') {
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

      return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    return batch;
  }
}

// Genera ID univoco
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Parse del body JSON con timeout
async function parseBody(req, maxBytes = 1048576) { // 1MB max
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });

    req.on('error', reject);
    
    // Timeout 10 secondi
    setTimeout(() => {
      req.destroy();
      reject(new Error('Parse timeout'));
    }, 10000);
  });
}

// Esegue bulk scan con concorrenza limitata
async function runBulkScan(batchId, bulkStore, reportStore) {
  const batch = bulkStore.getBatch(batchId);
  if (!batch) return;

  const CONCURRENCY = 3;
  let running = 0;
  let index = 0;

  function next() {
    while (running < CONCURRENCY && index < batch.results.length) {
      const i = index++;
      const result = batch.results[i];

      running++;
      result.status = 'running';
      result.startTime = Date.now();

      console.log(`[Bulk ${batchId}] Scansione ${i + 1}/${batch.total}: ${result.url}`);

      bulkStore.updatePhase(batchId, i, 'starting', 'Avvio...');

      scanSingleUrlWithPhases(batchId, i, result, bulkStore, reportStore)
        .then(() => {
          result.status = 'completed';
          bulkStore.completeScan(batchId, i, {
            reportId: result.reportId,
            cmp: result.cmp,
            violations: result.violations,
            verdict: result.verdict,
            trackers: result.trackers
          });
        })
        .catch(err => {
          bulkStore.errorScan(batchId, i, err.message);
        })
        .finally(() => {
          running--;
          next();
        });
    }

    if (running === 0 && batch.completed >= batch.total) {
      bulkStore.unlock(batchId);
    }
  }

  next();
}

// Scansiona singolo URL con aggiornamento fasi
async function scanSingleUrlWithPhases(batchId, index, result, bulkStore, reportStore) {
  const onPhase = (phase, label) => {
    bulkStore.updatePhase(batchId, index, phase, label);
  };

  onPhase('loading', 'Caricamento pagina...');

  const scanner = new CookieAuditScanner(result.url, {
    headless: true,
    timeout: 10000,
    onPhase: onPhase,
    verbose: false
  });

  const report = await scanner.run();
  const reportId = generateId();
  reportStore.set(reportId, report);

  result.reportId = reportId;
  result.cmp = report.cmp?.type || null;
  result.violations = report.violations?.length || 0;

  if (result.violations > 0) {
    result.verdict = 'NON CONFORME';
  } else if (report.cmp?.detected) {
    result.verdict = 'CONFORME';
  } else {
    result.verdict = 'DA VERIFICARE';
  }

  const trackers = new Set();
  if (report.summary?.events?.byTracker) {
    Object.keys(report.summary.events.byTracker).forEach(t => {
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
async function handleRequest(req, res, reportStore, bulkStore) {
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
        timeout: timeout || 10000,
        fastMode: body.fastMode !== undefined ? body.fastMode : true,
        skipInteractions: body.skipInteractions !== undefined ? body.skipInteractions : true
      });

      const report = await scanner.run();
      const reportId = generateId();
      reportStore.set(reportId, report);

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
    const reportId = url.pathname.split('/')[3];
    const report = reportStore.get(reportId);

    if (!report) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Report non trovato' }));
      return;
    }

    try {
      const body = await parseBody(req);

      if (!report.events.formTest) {
        report.events.formTest = [];
      }

      const formTestEvents = (body.events || []).map(e => {
        let tracker = 'Form Test';
        let eventName = 'unknown';
        let eventCategory = 'custom';

        if (e.type === 'dataLayer' && e.data?.event) {
          tracker = 'DataLayer';
          eventName = e.data.event;
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

      report.events.formTest = formTestEvents;
      report.formTest = {
        timestamp: body.timestamp,
        formEventCounts: body.formEventCounts,
        success: body.success,
        totalEvents: formTestEvents.length
      };

      if (report.summary && report.summary.events) {
        report.summary.events.formTest = formTestEvents.length;
        report.summary.events.total = (report.summary.events.total || 0) + formTestEvents.length;

        formTestEvents.forEach(e => {
          if (!report.summary.events.byTracker[e.tracker]) {
            report.summary.events.byTracker[e.tracker] = {};
          }
          const cat = e.eventCategory || 'custom';
          if (!report.summary.events.byTracker[e.tracker][cat]) {
            report.summary.events.byTracker[e.tracker][cat] = [];
          }
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
    const reportId = url.pathname.split('/').pop();
    const report = reportStore.get(reportId);

    if (report) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, report }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Report non trovato o scaduto' }));
    }
  }
  else if (url.pathname === '/api/bulk-scan' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const { urls } = body;

      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Lista URL richiesta' }));
        return;
      }

      const limitedUrls = urls.slice(0, 50);
      const batchId = generateId();

      // Verifica se già in esecuzione
      if (bulkStore.isLocked(batchId)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Batch già in esecuzione' }));
        return;
      }

      const batch = bulkStore.createBatch(limitedUrls);
      bulkStore.lock(batchId);

      console.log(`Bulk scan avviato: ${batchId} con ${limitedUrls.length} URL`);

      // Avvia in background
      runBulkScan(batchId, bulkStore, reportStore);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, batchId, total: limitedUrls.length }));
    } catch (err) {
      console.error('Errore avvio bulk scan:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/export$/) && req.method === 'GET') {
    const batchId = url.pathname.split('/')[3];
    const format = url.searchParams.get('format') || 'json';
    const data = bulkStore.getExport(batchId, format);

    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
      return;
    }

    const filename = `bulk-scan-${batchId}-${new Date().toISOString().split('T')[0]}`;

    if (format === 'csv') {
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}.csv"`
      });
      res.end(data);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}.json"`
      });
      res.end(JSON.stringify(data, null, 2));
    }
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+\/stream$/) && req.method === 'GET') {
    const batchId = url.pathname.split('/')[3];
    const batch = bulkStore.getBatch(batchId);

    if (!batch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Batch non trovato' }));
      return;
    }

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

    bulkStore.addSSEClient(batchId, res);
  }
  else if (url.pathname.match(/^\/api\/bulk-scan\/[^/]+$/) && req.method === 'GET') {
    const batchId = url.pathname.split('/').pop();
    const batch = bulkStore.getBatch(batchId);

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

// === GRACEFUL SHUTDOWN ===
function setupGracefulShutdown(server, reportStore, bulkStore) {
  const shutdown = async (signal) => {
    console.log(`\n${signal} ricevuto, shutdown in corso...`);

    // Chiudi server
    server.close(() => {
      console.log('Server chiuso');
    });

    // Cleanup stores
    if (reportStore) reportStore.dispose();
    if (bulkStore) {
      // Chiudi tutte le connessioni SSE
      for (const batch of bulkStore.batches.values()) {
        batch.sseClients.forEach(client => {
          try {
            client.end();
          } catch (e) {}
        });
      }
    }

    // Attendi 5 secondi per operazioni in corso
    setTimeout(() => {
      console.log('Shutdown completato');
      process.exit(0);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    shutdown('UNCAUGHT_EXCEPTION');
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    shutdown('UNHANDLED_REJECTION');
  });
}

// Avvia server
async function main() {
  const reportStore = new ReportStore();
  const bulkStore = new BulkScanStore();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, reportStore, bulkStore);
  });

  setupGracefulShutdown(server, reportStore, bulkStore);

  server.listen(PORT, () => {
    console.log(`\n=== AUDIT TRACKING TOOL SERVER ===`);
    console.log(`Server avviato: http://localhost:${PORT}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Report TTL: 1 ora`);
    console.log(`Rate Limit: RIMOSSO (nessun limite)`);
    console.log(`Max Bulk URLs: 50`);
    console.log(`=================================\n`);
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Errore avvio server:', err);
    process.exit(1);
  });
}

module.exports = { ReportStore, BulkScanStore };
