
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

module.exports = MONITOR_SCRIPT;
