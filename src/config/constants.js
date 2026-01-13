// === CONFIGURAZIONE TRACKER ===
const TRACKER_PATTERNS = {
  'GTM Container': /googletagmanager\.com\/gtm\.js/i,
  'GTM Collect': /googletagmanager\.com\/gtag\/js/i,
  'Google Ads': /googleadservices\.com|googlesyndication\.com|doubleclick\.net|googleads\./i,
  'GA4': /google-analytics\.com|analytics\.google\.com|\/g\/collect|stape\.net|stape\.io|sgtm\./i,
  'Facebook Pixel': /facebook\.com\/tr/i,
  'Facebook SDK': /connect\.facebook\.net|facebook\.net/i,
  'Clarity': /clarity\.ms/i,
  'Bing Ads': /bat\.bing\.com/i,
  'LinkedIn Insight': /snap\.licdn\.com|linkedin\.com\/px|licdn\.com|px\.ads\.linkedin/i,
  'TikTok Pixel': /analytics\.tiktok\.com|tiktok\.com\/i18n\/pixel/i,
  'Hotjar': /hotjar\.com|static\.hotjar\.com/i,
  'Criteo': /criteo\.com|criteo\.net/i,
  'Taboola': /taboola\.com|trc\.taboola\.com/i,
  'Outbrain': /outbrain\.com/i,
  'Yahoo/Verizon': /analytics\.yahoo\.com|ads\.yahoo\.com/i,
  'Adobe Analytics': /omtrdc\.net|demdex\.net|2o7\.net/i,
  'Cookiebot': /cookiebot\.com|consentcdn\.cookiebot\.com/i,
  'OneTrust': /onetrust\.com|cdn\.cookielaw\.org/i,
  'iubenda': /iubenda\.com/i,
  'Commanders Act': /tagcommander\.com|commander1\.com|tC\.cmp/i,
  'Didomi': /didomi\.io|sdk\.privacy-center\.org/i,
  'Axeptio': /axeptio\.eu|client\.axept\.io/i,
  'Usercentrics': /usercentrics\.eu|app\.usercentrics\.eu/i,
  'Quantcast': /quantcast\.com|quantserve\.com/i,
};

// Pattern per Google Consent Mode
const GOOGLE_CONSENT_PATTERNS = {
  'gcs': {
    'G100': 'denied',
    'G110': 'analytics_only',
    'G101': 'ads_only',
    'G111': 'granted',
    'G1--': 'not_set'
  }
};

// Eventi GA4 standard
const GA4_STANDARD_EVENTS = [
  'page_view', 'scroll', 'click', 'form_start', 'form_submit',
  'generate_lead', 'view_item', 'view_item_list', 'add_to_cart',
  'remove_from_cart', 'begin_checkout', 'purchase', 'user_engagement',
  'session_start', 'first_visit'
];

// Eventi GA4 che potrebbero essere equivalenti a click_phone
const GA4_PHONE_EVENTS = [
  'click_phone', 'phone_click', 'call_click', 'tel_click',
  'click_to_call', 'phone_interaction', 'call_interaction'
];

module.exports = {
  TRACKER_PATTERNS,
  GOOGLE_CONSENT_PATTERNS,
  GA4_STANDARD_EVENTS,
  GA4_PHONE_EVENTS
};
