const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { CookieAuditScanner } = require('./scanner');

const PORT = process.env.PORT || 3000;

// Detect if running on Railway or other headless server
const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_SERVICE_NAME;
const IS_HEADLESS_SERVER = IS_RAILWAY || (!process.env.DISPLAY && process.platform === 'linux');

// === FORM TEST LIVE SESSION ===
class FormTestSession {
  constructor(url, sessionId) {
    this.url = url;
    this.sessionId = sessionId;
    this.browser = null;
    this.page = null;
    this.events = [];
    this.sseClients = [];
    this.isRunning = false;
    this.startTime = Date.now();
  }

  async start() {
    // Check if Live Monitor is available on this environment
    if (IS_HEADLESS_SERVER) {
      throw new Error('LIVE_MONITOR_NOT_AVAILABLE: Il Live Monitor richiede un ambiente con display grafico. Questa funzione è disponibile solo in locale.');
    }

    try {
      this.browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });

      this.page = await context.newPage();
      this.isRunning = true;

      // Intercetta TUTTE le richieste di rete (come scanner.js)
      this.page.on('request', (request) => this.handleRequest(request));

      // Monitor dataLayer via CDP
      await this.setupDataLayerMonitor();

      // Naviga alla pagina
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      this.sendEvent({ type: 'session_started', url: this.url });
      console.log(`[FormTest] Sessione ${this.sessionId} avviata per ${this.url}`);

      return true;
    } catch (error) {
      console.error(`[FormTest] Errore avvio sessione:`, error);
      this.sendEvent({ type: 'error', message: error.message });
      return false;
    }
  }

  async setupDataLayerMonitor() {
    // Inietta script per monitorare dataLayer
    await this.page.exposeFunction('__attDataLayerPush', (data) => {
      this.sendEvent({
        type: 'dataLayer',
        data: data,
        timestamp: Date.now()
      });
    });

    await this.page.addInitScript(() => {
      const checkDataLayer = () => {
        if (!window.dataLayer) {
          window.dataLayer = [];
        }
        if (!window.dataLayer.__attMonitored) {
          const original = window.dataLayer.push.bind(window.dataLayer);
          window.dataLayer.push = function(...args) {
            args.forEach(item => {
              if (item && typeof item === 'object' && item.event) {
                window.__attDataLayerPush({ event: item.event, data: item });
              }
            });
            return original(...args);
          };
          window.dataLayer.__attMonitored = true;
          // Processa eventi esistenti
          window.dataLayer.forEach(item => {
            if (item && typeof item === 'object' && item.event) {
              window.__attDataLayerPush({ event: item.event, data: item });
            }
          });
        }
      };
      checkDataLayer();
      setInterval(checkDataLayer, 100);
    });
  }

  handleRequest(request) {
    const url = request.url();
    const tracker = this.identifyTracker(url);

    if (!tracker) return;

    const postData = request.postData();
    const details = this.extractDetails(url, tracker, postData);

    this.sendEvent({
      type: 'network',
      tracker: tracker,
      url: url,
      event: details.event,
      eventCategory: details.eventCategory,
      params: details.params,
      timestamp: Date.now()
    });
  }

  identifyTracker(url) {
    const u = url.toLowerCase();

    // Facebook Pixel
    if (u.includes('facebook.com/tr')) return 'Facebook Pixel';
    if (u.includes('connect.facebook.net') && u.includes('fbevents')) return 'Facebook SDK';

    // Google
    if (u.includes('google-analytics.com/g/collect') || u.includes('analytics.google.com/g/collect')) return 'GA4';
    if (u.includes('google-analytics.com') && !u.includes('/g/collect')) return 'GA4';
    if (u.includes('googletagmanager.com/gtm.js')) return 'GTM';
    if (u.includes('googletagmanager.com/gtag/js')) return 'GTM';
    if (u.includes('googleadservices.com') || u.includes('googlesyndication.com')) return 'Google Ads';
    if (u.includes('doubleclick.net')) return 'Google Ads';

    // Microsoft
    if (u.includes('clarity.ms')) return 'Clarity';
    if (u.includes('bat.bing.com')) return 'Bing Ads';

    // Social
    if (u.includes('linkedin.com/px') || u.includes('snap.licdn.com')) return 'LinkedIn Insight';
    if (u.includes('analytics.tiktok.com')) return 'TikTok Pixel';

    // Altri
    if (u.includes('hotjar.com')) return 'Hotjar';
    if (u.includes('criteo.com') || u.includes('criteo.net')) return 'Criteo';

    // CMP
    if (u.includes('cookiebot.com') || u.includes('consentcdn.cookiebot.com')) return 'Cookiebot';
    if (u.includes('onetrust.com') || u.includes('cookielaw.org')) return 'OneTrust';
    if (u.includes('iubenda.com')) return 'iubenda';

    return null;
  }

  extractDetails(url, tracker, postData) {
    const details = { event: null, eventCategory: 'custom', params: {} };

    try {
      const urlObj = new URL(url);

      // Facebook Pixel
      if (tracker === 'Facebook Pixel') {
        details.event = urlObj.searchParams.get('ev');
        const standardEvents = ['PageView', 'ViewContent', 'AddToCart', 'Purchase', 'Lead', 'CompleteRegistration'];
        details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
      }

      // GA4
      if (tracker === 'GA4') {
        details.event = urlObj.searchParams.get('en');
        if (!details.event && postData) {
          const match = postData.match(/en=([^&]+)/);
          if (match) details.event = decodeURIComponent(match[1]);
        }
        const standardEvents = ['page_view', 'scroll', 'click', 'view_item', 'purchase', 'generate_lead'];
        details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
      }

      // Clarity
      if (tracker === 'Clarity') {
        details.event = 'Recording';
        details.eventCategory = 'session';
      }

    } catch (e) {
      // Ignore parsing errors
    }

    return details;
  }

  sendEvent(event) {
    event.sessionId = this.sessionId;
    event.timestamp = event.timestamp || Date.now();
    this.events.push(event);

    // Invia a tutti i client SSE
    const message = `data: ${JSON.stringify(event)}\n\n`;
    this.sseClients = this.sseClients.filter(client => {
      try {
        client.write(message);
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  addSSEClient(res) {
    this.sseClients.push(res);
    res.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });

    // Invia eventi precedenti
    this.events.forEach(event => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  }

  async stop() {
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.sendEvent({ type: 'session_stopped' });
    console.log(`[FormTest] Sessione ${this.sessionId} terminata`);
  }
}

// === HEADLESS FORM TEST SESSION (per Railway) ===
class HeadlessFormTestSession {
  constructor(url, sessionId) {
    this.url = url;
    this.sessionId = sessionId;
    this.browser = null;
    this.page = null;
    this.events = [];
    this.sseClients = [];
    this.isRunning = false;
    this.startTime = Date.now();
    this.actionsLog = [];
  }

  async start() {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });

      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });

      this.page = await context.newPage();
      this.isRunning = true;

      // Intercetta richieste di rete
      this.page.on('request', (request) => this.handleRequest(request));

      // Monitor dataLayer
      await this.setupDataLayerMonitor();

      // Naviga alla pagina
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Attendi caricamento completo
      await this.page.waitForTimeout(2000);

      this.sendEvent({ type: 'session_started', url: this.url, mode: 'headless' });
      this.logAction('Pagina caricata');
      console.log(`[HeadlessFormTest] Sessione ${this.sessionId} avviata per ${this.url}`);

      return true;
    } catch (error) {
      console.error(`[HeadlessFormTest] Errore avvio:`, error);
      this.sendEvent({ type: 'error', message: error.message });
      return false;
    }
  }

  async setupDataLayerMonitor() {
    await this.page.exposeFunction('__attDataLayerPush', (data) => {
      this.sendEvent({
        type: 'dataLayer',
        data: data,
        timestamp: Date.now()
      });
    });

    await this.page.addInitScript(() => {
      const checkDataLayer = () => {
        if (!window.dataLayer) window.dataLayer = [];
        if (!window.dataLayer.__attMonitored) {
          const original = window.dataLayer.push.bind(window.dataLayer);
          window.dataLayer.push = function(...args) {
            args.forEach(item => {
              if (item && typeof item === 'object' && item.event) {
                window.__attDataLayerPush({ event: item.event, data: item });
              }
            });
            return original(...args);
          };
          window.dataLayer.__attMonitored = true;
          window.dataLayer.forEach(item => {
            if (item && typeof item === 'object' && item.event) {
              window.__attDataLayerPush({ event: item.event, data: item });
            }
          });
        }
      };
      checkDataLayer();
      setInterval(checkDataLayer, 100);
    });
  }

  handleRequest(request) {
    const url = request.url();
    const tracker = this.identifyTracker(url);
    if (!tracker) return;

    const postData = request.postData();
    const details = this.extractDetails(url, tracker, postData);

    this.sendEvent({
      type: 'network',
      tracker: tracker,
      url: url,
      event: details.event,
      eventCategory: details.eventCategory,
      timestamp: Date.now()
    });
  }

  identifyTracker(url) {
    const u = url.toLowerCase();
    if (u.includes('facebook.com/tr')) return 'Facebook Pixel';
    if (u.includes('connect.facebook.net') && u.includes('fbevents')) return 'Facebook SDK';
    if (u.includes('google-analytics.com/g/collect') || u.includes('analytics.google.com/g/collect')) return 'GA4';
    if (u.includes('googletagmanager.com/gtm.js') || u.includes('googletagmanager.com/gtag/js')) return 'GTM';
    if (u.includes('googleadservices.com') || u.includes('doubleclick.net')) return 'Google Ads';
    if (u.includes('clarity.ms')) return 'Clarity';
    if (u.includes('bat.bing.com')) return 'Bing Ads';
    if (u.includes('linkedin.com/px') || u.includes('snap.licdn.com')) return 'LinkedIn Insight';
    if (u.includes('analytics.tiktok.com')) return 'TikTok Pixel';
    if (u.includes('hotjar.com')) return 'Hotjar';
    if (u.includes('cookiebot.com')) return 'Cookiebot';
    if (u.includes('onetrust.com')) return 'OneTrust';
    if (u.includes('iubenda.com')) return 'iubenda';
    return null;
  }

  extractDetails(url, tracker, postData) {
    const details = { event: null, eventCategory: 'custom' };
    try {
      const urlObj = new URL(url);
      if (tracker === 'Facebook Pixel') {
        details.event = urlObj.searchParams.get('ev');
        const standardEvents = ['PageView', 'ViewContent', 'AddToCart', 'Purchase', 'Lead', 'CompleteRegistration'];
        details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
      }
      if (tracker === 'GA4') {
        details.event = urlObj.searchParams.get('en');
        if (!details.event && postData) {
          const match = postData.match(/en=([^&]+)/);
          if (match) details.event = decodeURIComponent(match[1]);
        }
        const standardEvents = ['page_view', 'scroll', 'click', 'view_item', 'purchase', 'generate_lead'];
        details.eventCategory = standardEvents.includes(details.event) ? 'standard' : 'custom';
      }
      if (tracker === 'Clarity') {
        details.event = 'Recording';
        details.eventCategory = 'session';
      }
    } catch (e) {}
    return details;
  }

  sendEvent(event) {
    event.sessionId = this.sessionId;
    event.timestamp = event.timestamp || Date.now();
    this.events.push(event);

    const message = `data: ${JSON.stringify(event)}\n\n`;
    this.sseClients = this.sseClients.filter(client => {
      try {
        client.write(message);
        return true;
      } catch (e) {
        return false;
      }
    });
  }

  logAction(action) {
    const logEntry = { action, timestamp: Date.now() };
    this.actionsLog.push(logEntry);
    this.sendEvent({ type: 'action', action, timestamp: Date.now() });
  }

  addSSEClient(res) {
    this.sseClients.push(res);
    res.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });
    this.events.forEach(event => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  }

  // === AZIONI PREDEFINITE ===
  async executeAction(actionName, params = {}) {
    if (!this.isRunning || !this.page) {
      return { success: false, error: 'Sessione non attiva' };
    }

    try {
      switch (actionName) {
        case 'scroll':
          return await this.actionScroll(params);
        case 'scrollToBottom':
          return await this.actionScrollToBottom();
        case 'acceptCookies':
          return await this.actionAcceptCookies();
        case 'click':
          return await this.actionClick(params);
        case 'fillForm':
          return await this.actionFillForm(params);
        case 'submitForm':
          return await this.actionSubmitForm(params);
        case 'wait':
          return await this.actionWait(params);
        case 'screenshot':
          return await this.actionScreenshot();
        default:
          return { success: false, error: `Azione '${actionName}' non supportata` };
      }
    } catch (error) {
      this.logAction(`Errore: ${actionName} - ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async actionScroll(params) {
    const amount = params.amount || 500;
    await this.page.evaluate((scrollAmount) => {
      window.scrollBy(0, scrollAmount);
    }, amount);
    this.logAction(`Scroll ${amount}px`);
    await this.page.waitForTimeout(500);
    return { success: true, message: `Scrollato di ${amount}px` };
  }

  async actionScrollToBottom() {
    await this.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    this.logAction('Scroll fino in fondo');
    await this.page.waitForTimeout(1000);
    return { success: true, message: 'Scrollato fino in fondo alla pagina' };
  }

  async actionAcceptCookies() {
    const selectors = [
      // Cookiebot
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
      'button[data-cookieconsent="accept"]',
      // OneTrust
      '#onetrust-accept-btn-handler',
      '.onetrust-close-btn-handler',
      // iubenda
      '.iubenda-cs-accept-btn',
      // Generic
      'button[id*="accept"]',
      'button[class*="accept"]',
      'a[id*="accept"]',
      '[data-action="accept"]',
      '.cookie-accept',
      '#cookie-accept',
      'button:has-text("Accetta")',
      'button:has-text("Accept")',
      'button:has-text("Accetto")',
      'button:has-text("OK")',
    ];

    for (const selector of selectors) {
      try {
        const btn = await this.page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          this.logAction(`Cookie accettati (${selector})`);
          await this.page.waitForTimeout(1000);
          return { success: true, message: `Cookie accettati tramite: ${selector}` };
        }
      } catch (e) {}
    }

    this.logAction('Nessun banner cookie trovato');
    return { success: false, error: 'Nessun banner cookie trovato' };
  }

  async actionClick(params) {
    const { selector } = params;
    if (!selector) {
      return { success: false, error: 'Selettore richiesto' };
    }

    const element = await this.page.$(selector);
    if (!element) {
      return { success: false, error: `Elemento non trovato: ${selector}` };
    }

    await element.click();
    this.logAction(`Click su ${selector}`);
    await this.page.waitForTimeout(500);
    return { success: true, message: `Click eseguito su ${selector}` };
  }

  async actionFillForm(params) {
    const { formSelector, fields } = params;
    const formSel = formSelector || 'form';

    const form = await this.page.$(formSel);
    if (!form) {
      return { success: false, error: 'Form non trovato' };
    }

    // Dati di test predefiniti
    const testData = fields || {
      'input[type="email"]': 'test@example.com',
      'input[type="text"][name*="name"]': 'Test User',
      'input[type="text"][name*="nome"]': 'Test User',
      'input[type="tel"]': '+39 123 456 7890',
      'textarea': 'Questo è un messaggio di test generato automaticamente.',
      'input[type="text"]': 'Test input'
    };

    let filledCount = 0;
    for (const [selector, value] of Object.entries(testData)) {
      try {
        const input = await this.page.$(`${formSel} ${selector}`);
        if (input && await input.isVisible()) {
          await input.fill(value);
          filledCount++;
        }
      } catch (e) {}
    }

    this.logAction(`Form compilato (${filledCount} campi)`);
    return { success: true, message: `Compilati ${filledCount} campi` };
  }

  async actionSubmitForm(params) {
    const { formSelector } = params;
    const formSel = formSelector || 'form';

    const submitBtn = await this.page.$(`${formSel} button[type="submit"], ${formSel} input[type="submit"], ${formSel} button:not([type])`);
    if (submitBtn) {
      await submitBtn.click();
      this.logAction('Form inviato (click submit)');
    } else {
      await this.page.$eval(formSel, form => form.submit());
      this.logAction('Form inviato (submit())');
    }

    await this.page.waitForTimeout(2000);
    return { success: true, message: 'Form inviato' };
  }

  async actionWait(params) {
    const ms = params.ms || 2000;
    await this.page.waitForTimeout(ms);
    this.logAction(`Atteso ${ms}ms`);
    return { success: true, message: `Atteso ${ms}ms` };
  }

  async actionScreenshot() {
    const screenshot = await this.page.screenshot({ encoding: 'base64' });
    this.logAction('Screenshot catturato');
    return { success: true, screenshot: `data:image/png;base64,${screenshot}` };
  }

  async stop() {
    this.isRunning = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.sendEvent({ type: 'session_stopped' });
    console.log(`[HeadlessFormTest] Sessione ${this.sessionId} terminata`);
  }
}

// Store per sessioni form-test
const formTestSessions = new Map();
const headlessFormTestSessions = new Map();

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

  function setupFacebookPixelMonitor() {
    // Intercetta le chiamate fbq() per catturare eventi prima che Meta li blocchi
    const processedFbEvents = new Set();

    function interceptFbq() {
      if (!window.fbq) return false;
      if (window.fbq.__attMonitored) return true;

      const originalFbq = window.fbq;
      window.fbq = function() {
        const args = Array.from(arguments);
        const command = args[0]; // 'track', 'trackCustom', 'init', etc.
        const eventName = args[1]; // 'PageView', 'Purchase', etc.

        // Evita duplicati
        const key = command + '|' + eventName + '|' + Math.floor(Date.now() / 1000);
        if (!processedFbEvents.has(key)) {
          processedFbEvents.add(key);
          setTimeout(() => processedFbEvents.delete(key), 2000);

          if (command === 'track' || command === 'trackCustom') {
            console.log('[ATT Monitor] Facebook fbq() call:', command, eventName);
            sendToParent('network', {
              tracker: 'Facebook Pixel',
              url: 'fbq(' + command + ')',
              event: eventName || command,
              params: args[2] || null
            });
          } else if (command === 'init') {
            console.log('[ATT Monitor] Facebook Pixel init:', eventName);
            sendToParent('network', {
              tracker: 'Facebook Pixel',
              url: 'fbq(init)',
              event: 'init',
              params: { pixelId: eventName }
            });
          }
        }

        return originalFbq.apply(this, arguments);
      };
      window.fbq.__attMonitored = true;
      console.log('[ATT Monitor] Facebook fbq() interceptor attivo');
      return true;
    }

    // Prova subito e poi ogni 100ms per 10 secondi
    if (!interceptFbq()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (interceptFbq() || attempts > 100) {
          clearInterval(interval);
        }
      }, 100);
    }
  }

  function setupNetworkMonitor() {
    const processedRequests = new Set();

    function isDuplicate(url) {
      let eventName = '';
      try {
        const urlObj = new URL(url);
        // Supporta sia GA4 (en) che Facebook Pixel (ev)
        eventName = urlObj.searchParams.get('en') || urlObj.searchParams.get('ev') || '';
      } catch(e) {
        const matchEn = url.match(/[&?]en=([^&]+)/);
        const matchEv = url.match(/[&?]ev=([^&]+)/);
        if (matchEn) eventName = matchEn[1];
        else if (matchEv) eventName = matchEv[1];
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

    // Intercetta anche document.createElement('img') per Facebook Pixel
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function(tagName, options) {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'img') {
        const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        Object.defineProperty(element, 'src', {
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
      }
      return element;
    };
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

    // Prima prova con URL object
    try {
      const urlObj = new URL(url);
      const eventParams = ['en', 'ev', 'event', 'e', 'ea', 'ec'];
      for (const param of eventParams) {
        const val = urlObj.searchParams.get(param);
        if (val && !eventNames.includes(val)) {
          eventNames.push(val);
        }
      }
    } catch(e) {
      // Se URL parsing fallisce, usa regex
      console.log('[ATT Monitor] URL parsing fallito, uso regex');
    }

    // Fallback: cerca parametri con regex direttamente nell'URL
    if (eventNames.length === 0) {
      const evMatch = url.match(/[?&]ev=([^&]+)/);
      const enMatch = url.match(/[?&]en=([^&]+)/);
      const eventMatch = url.match(/[?&]event=([^&]+)/);

      if (evMatch) eventNames.push(decodeURIComponent(evMatch[1]));
      if (enMatch) eventNames.push(decodeURIComponent(enMatch[1]));
      if (eventMatch) eventNames.push(decodeURIComponent(eventMatch[1]));
    }

    // Estrai da body se presente
    if (body && typeof body === 'string') {
      const patterns = [/[&?]en=([^&\\r\\n]+)/g, /[&?]ev=([^&\\r\\n]+)/g];
      patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(body)) !== null) {
          const evName = decodeURIComponent(match[1]);
          if (evName && !eventNames.includes(evName)) {
            eventNames.push(evName);
          }
        }
      });
    }

    // Per Facebook: identifica tipo di richiesta
    if (eventNames.length === 0 && tracker === 'Facebook') {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('facebook.com/tr')) {
        eventNames.push('PixelRequest');
      } else if (lowerUrl.includes('fbevents.js')) {
        eventNames.push('SDK Load');
      } else if (lowerUrl.includes('signals/config')) {
        eventNames.push('Config');
      }
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
    setupFacebookPixelMonitor();
    console.log('[ATT Monitor] Network, DataLayer e Facebook monitor attivati');

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
        timeout: timeout || 25000, // Aumentato da 10s a 25s per garantire rilevamento CMP
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
  // === ENVIRONMENT API ===
  else if (url.pathname === '/api/environment' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      isLocal: !IS_HEADLESS_SERVER,
      isRailway: IS_RAILWAY,
      isHeadlessServer: IS_HEADLESS_SERVER,
      features: {
        liveMonitor: !IS_HEADLESS_SERVER,
        headlessMonitor: true
      }
    }));
  }
  // === HEADLESS FORM TEST API (per Railway) ===
  else if (url.pathname === '/api/form-test-headless/start' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const targetUrl = body.url;

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
        return;
      }

      const sessionId = generateId();
      const session = new HeadlessFormTestSession(targetUrl, sessionId);
      headlessFormTestSessions.set(sessionId, session);

      // Avvia sessione
      const started = await session.start();

      if (!started) {
        headlessFormTestSessions.delete(sessionId);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Errore avvio sessione' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessionId, mode: 'headless' }));
    } catch (err) {
      console.error('Errore avvio form-test-headless:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/events$/) && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[3];
    const session = headlessFormTestSessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId, mode: 'headless' })}\n\n`);
    session.addSSEClient(res);
  }
  else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/action$/) && req.method === 'POST') {
    const sessionId = url.pathname.split('/')[3];
    const session = headlessFormTestSessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
      return;
    }

    try {
      const body = await parseBody(req);
      const { action, params } = body;

      if (!action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Azione richiesta' }));
        return;
      }

      const result = await session.executeAction(action, params || {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/form-test-headless\/[^/]+\/stop$/) && req.method === 'POST') {
    const sessionId = url.pathname.split('/')[3];
    const session = headlessFormTestSessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
      return;
    }

    await session.stop();
    headlessFormTestSessions.delete(sessionId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }
  // === FORM TEST LIVE API (locale) ===
  else if (url.pathname === '/api/form-test/start' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const targetUrl = body.url;

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'URL richiesto' }));
        return;
      }

      const sessionId = generateId();
      const session = new FormTestSession(targetUrl, sessionId);
      formTestSessions.set(sessionId, session);

      // Avvia in background
      session.start().catch(err => {
        console.error(`[FormTest] Errore sessione ${sessionId}:`, err);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, sessionId }));
    } catch (err) {
      console.error('Errore avvio form-test:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }
  else if (url.pathname.match(/^\/api\/form-test\/[^/]+\/events$/) && req.method === 'GET') {
    // SSE endpoint per streaming eventi
    const sessionId = url.pathname.split('/')[3];
    const session = formTestSessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
      return;
    }

    // Setup SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
    session.addSSEClient(res);
  }
  else if (url.pathname.match(/^\/api\/form-test\/[^/]+\/stop$/) && req.method === 'POST') {
    const sessionId = url.pathname.split('/')[3];
    const session = formTestSessions.get(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Sessione non trovata' }));
      return;
    }

    await session.stop();
    formTestSessions.delete(sessionId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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

        // Handle missing or invalid timestamp
        let timestamp;
        try {
          timestamp = e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }

        return {
          tracker,
          event: eventName,
          eventCategory,
          timestamp,
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

      const batch = bulkStore.createBatch(limitedUrls);
      const batchId = batch.batchId;

      // Verifica se già in esecuzione
      if (bulkStore.isLocked(batchId)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Batch già in esecuzione' }));
        return;
      }

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
