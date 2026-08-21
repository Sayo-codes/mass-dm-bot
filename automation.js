// =====================================================
// Mass DM Bot - Focused Version (fixed navigation + cookies)
// =====================================================
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

let multiAccountStopSignals = [];
let multiAccountBrowsers = [];

function log(type, msg) {
  const entry = { type, msg, ts: new Date().toISOString() };
  console.log(`[${type.toUpperCase()}] ${msg}`);
  if (global.broadcast) global.broadcast('log', entry);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseUsername(raw) {
  return raw.replace(/^@/, '').trim().toLowerCase();
}

// ─── PIN / Passcode Handler ──────────────────────────
const DEBUG_DIR = path.join(__dirname, 'public', 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

function isPinUrl(url) {
  return /\/pin\/|\/recovery|\/challenge|\/verification|ocf|\/i\/flow\/|passcode|account\/access/i.test(url || '');
}

function isPinPageContent(text = '') {
  const t = (text || '').toLowerCase();
  return t.includes('passcode is required') ||
         t.includes('encryption keys') ||
         t.includes('enter passcode') ||
         t.includes('enter the code') ||
         t.includes('verification code') ||
         t.includes("confirm it's you") ||
         t.includes('help us protect') ||
         t.includes('authenticate') ||
         t.includes('one-time code') ||
         t.includes('enter your passcode');
}

async function handlePinPage(page, label, passcode) {
  if (!passcode || !passcode.trim()) {
    log('warn', `[${label}] PIN page detected but no passcode provided`);
    return false;
  }

  const code = passcode.trim();
  let pageText = await page.textContent('body').catch(() => '') || '';
  if (!isPinUrl(page.url()) && !isPinPageContent(pageText)) return false;

  log('info', `[${label}] ⚠️ PIN page detected — trying to unlock`);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.screenshot({
        path: path.join(DEBUG_DIR, `pin_${label.replace(/\s+/g, '')}_${Date.now()}.png`),
        fullPage: true
      }).catch(() => {});

      const inputs = await page.$$('input:not([type="hidden"]), div[contenteditable="true"]');
      let focused = false;
      for (const el of inputs) {
        if (await el.isVisible().catch(() => false)) {
          await el.click({ clickCount: 3 }).catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          focused = true;
          break;
        }
      }

      if (!focused) {
        await page.mouse.click(640, 400).catch(() => {});
      }

      await sleep(500);

      for (const char of code) {
        await page.keyboard.type(char, { delay: 140 + Math.random() * 90 });
        await sleep(60 + Math.random() * 70);
      }

      await sleep(800);
      await page.keyboard.press('Enter');
      await sleep(1800);

      const btns = await page.$$('div[role="button"], button, [data-testid*="Next"], [data-testid*="Confirm"], [data-testid*="next"]');
      for (const btn of btns) {
        const txt = ((await btn.textContent().catch(() => '')) || '').toLowerCase();
        if (txt.includes('next') || txt.includes('confirm') || txt.includes('verify') || txt.includes('continue') || txt.includes('submit')) {
          await btn.click({ force: true }).catch(() => {});
          await sleep(1200);
        }
      }

      await sleep(6000);

      pageText = await page.textContent('body').catch(() => '') || '';
      if (!isPinUrl(page.url()) && !isPinPageContent(pageText)) {
        log('info', `[${label}] ✅ PIN accepted`);
        return true;
      }

      log('warn', `[${label}] PIN attempt ${attempt} — still on pin screen`);
    } catch (e) {
      log('warn', `[${label}] PIN attempt ${attempt} failed: ${e.message.slice(0, 90)}`);
    }
    await sleep(2000);
  }

  log('fail', `[${label}] All PIN attempts failed`);
  return false;
}

// ─── DM Tracking ─────────────────────────────────────
const DM_LOG_PATH = path.join(__dirname, 'session', 'dm_sent.json');

function getDmLog() {
  try {
    return JSON.parse(fs.readFileSync(DM_LOG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveDmLog(data) {
  fs.mkdirSync(path.dirname(DM_LOG_PATH), { recursive: true });
  fs.writeFileSync(DM_LOG_PATH, JSON.stringify(data, null, 2));
}

function getTodayCount(label) {
  const log = getDmLog();
  const today = new Date().toISOString().slice(0, 10);
  return (log[label]?.[today] || []).length;
}

function markSent(label, username) {
  const log = getDmLog();
  const today = new Date().toISOString().slice(0, 10);
  if (!log[label]) log[label] = {};
  if (!log[label][today]) log[label][today] = [];
  if (!log[label][today].includes(username)) {
    log[label][today].push(username);
  }
  saveDmLog(log);
}

function alreadySent(label, username) {
  const log = getDmLog();
  const today = new Date().toISOString().slice(0, 10);
  return (log[label]?.[today] || []).includes(username);
}

// ─── Helpers ─────────────────────────────────────────
async function safeGoto(page, url, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    return true;
  } catch (e) {
    log('warn', `[${label}] goto failed: ${e.message.slice(0, 80)}`);
    return false;
  }
}

async function maybeHandlePin(page, label, passcode) {
  const url = page.url();
  const text = await page.textContent('body').catch(() => '') || '';
  if (isPinUrl(url) || isPinPageContent(text)) {
    return await handlePinPage(page, label, passcode);
  }
  return true;
}

async function findAndClick(page, selectors, timeout = 4000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout, state: 'visible' }).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    } catch {}
  }
  return false;
}

async function findVisible(page, selectors, timeout = 4000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout, state: 'visible' }).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) {
        return el;
      }
    } catch {}
  }
  return null;
}

// ─── Core Send DM ────────────────────────────────────
async function sendSingleDM(page, username, message, label, passcode) {
  const user = parseUsername(username);
  log('info', `[${label}] → starting DM to @${user}`);

  log('info', `[${label}] Opening profile of @${user}`);
  await safeGoto(page, `https://x.com/${user}`, label);

  if (!(await maybeHandlePin(page, label, passcode))) {
    log('fail', `[${label}] @${user} — could not pass PIN`);
    return false;
  }

  await page.screenshot({
    path: path.join(DEBUG_DIR, `profile_${user}_${Date.now()}.png`),
    fullPage: false
  }).catch(() => {});

  const msgBtnSelectors = [
    '[data-testid="sendDMFromProfile"]',
    'div[data-testid="sendDMFromProfile"]',
    '[aria-label="Message"]',
    'a[href*="/messages/"]',
    'div[role="button"]:has-text("Message")',
    'button:has-text("Message")',
    '[data-testid="dmComposerTextInput"]'
  ];

  let clickedMessage = await findAndClick(page, msgBtnSelectors, 5000);

  if (!clickedMessage) {
    log('warn', `[${label}] Message button not found on profile — trying compose URL`);
    
    await safeGoto(page, 'https://x.com/messages/compose', label);
    if (!(await maybeHandlePin(page, label, passcode))) {
      log('fail', `[${label}] @${user} — PIN blocked compose`);
      return false;
    }

    await sleep(2000);

    const searchSelectors = [
      '[data-testid="searchPeople"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="Search"]',
      'input[type="text"]',
      'div[role="combobox"] input'
    ];

    const searchBox = await findVisible(page, searchSelectors, 5000);
    if (!searchBox) {
      log('fail', `[${label}] @${user} — search box not found on compose`);
      await page.screenshot({
        path: path.join(DEBUG_DIR, `compose_fail_${user}_${Date.now()}.png`),
        fullPage: true
      }).catch(() => {});
      return false;
    }

    await searchBox.click({ clickCount: 2 }).catch(() => {});
    await sleep(300);
    await page.keyboard.type(user, { delay: 55 });
    await sleep(2200);

    const resultSelectors = [
      `[data-testid="TypeaheadUser"]`,
      `div[role="option"]`,
      `div[data-testid="TypeaheadUser"]`,
      `li[role="option"]`
    ];

    let picked = await findAndClick(page, resultSelectors, 4000);
    if (!picked) {
      await page.keyboard.press('Enter');
      await sleep(1500);
    } else {
      await sleep(2000);
    }
  } else {
    log('info', `[${label}] Clicked Message on profile`);
    await sleep(3000);
  }

  if (!(await maybeHandlePin(page, label, passcode))) {
    log('fail', `[${label}] @${user} — PIN appeared after opening chat`);
    return false;
  }

  await sleep(1500);

  const inputSelectors = [
    '[data-testid="dmComposerTextInput"]',
    'div[data-testid="dmComposerTextInput"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Message"]',
    'div[aria-label*="message"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"]'
  ];

  let input = await findVisible(page, inputSelectors, 7000);

  if (!input) {
    const nextBtns = [
      'div[role="button"]:has-text("Next")',
      'button:has-text("Next")',
      '[data-testid="nextButton"]',
      'div[data-testid="nextButton"]'
    ];
    await findAndClick(page, nextBtns, 3000);
    await sleep(2000);
    input = await findVisible(page, inputSelectors, 5000);
  }

  if (!input) {
    log('fail', `[${label}] @${user} — message input not found`);
    await page.screenshot({
      path: path.join(DEBUG_DIR, `no_input_${user}_${Date.now()}.png`),
      fullPage: true
    }).catch(() => {});
    log('info', `[${label}] Current URL: ${page.url()}`);
    return false;
  }

  await input.click({ clickCount: 2 }).catch(() => {});
  await sleep(400);

  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await sleep(200);

  await page.keyboard.type(message, { delay: 28 + Math.random() * 25 });
  await sleep(700);

  const sendSelectors = [
    '[data-testid="dmComposerSendButton"]',
    'div[data-testid="dmComposerSendButton"]',
    '[aria-label="Send"]',
    'div[role="button"][aria-label="Send"]',
    'div[role="button"]:has-text("Send")',
    'button:has-text("Send")'
  ];

  let sent = await findAndClick(page, sendSelectors, 3000);

  if (!sent) {
    await page.keyboard.press('Enter');
    log('info', `[${label}] ✅ DM sent to @${user} (Enter fallback)`);
  } else {
    log('info', `[${label}] ✅ DM sent to @${user}`);
  }

  await sleep(2500);

  await page.screenshot({
    path: path.join(DEBUG_DIR, `after_send_${user}_${Date.now()}.png`),
    fullPage: false
  }).catch(() => {});

  return true;
}

// ─── Mass DM Runner ──────────────────────────────────
async function startMassDM(accounts, message, dailyLimit = 50, delaySeconds = 45, passcode = '') {
  if (!message?.trim()) {
    log('error', 'Message is empty');
    return;
  }

  const targetsFile = path.join(__dirname, 'users_to_dm.txt');
  if (!fs.existsSync(targetsFile)) {
    log('error', 'users_to_dm.txt not found');
    return;
  }

  const targets = fs.readFileSync(targetsFile, 'utf-8')
    .split('\n')
    .map(l => parseUsername(l.replace(/#.*/, '').trim()))
    .filter(u => u.length > 1);

  if (targets.length === 0) {
    log('error', 'No usernames in users_to_dm.txt');
    return;
  }

  log('start', `Mass DM started | ${accounts.length} account(s) | ${targets.length} targets | ${delaySeconds}s delay | limit ${dailyLimit}/day`);

  multiAccountStopSignals = [];
  multiAccountBrowsers = [];
  global.broadcast && global.broadcast('status', { running: true });

  const tasks = accounts.map(async ({ cookiesPath, label, passcode: accountPasscode }) => {
    if (!fs.existsSync(cookiesPath)) {
      log('error', `[${label}] session missing`);
      return;
    }

    const stopSignal = { stopped: false };
    multiAccountStopSignals.push(stopSignal);

    const pinToUse = (accountPasscode && accountPasscode.trim()) ? accountPasscode.trim() : passcode;

    let browser = null;
    try {
      let raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));

      // Accept both correct array format and older/wrong object formats
      let cookies = [];
      if (Array.isArray(raw)) {
        cookies = raw;
      } else if (raw && Array.isArray(raw.cookies)) {
        cookies = raw.cookies;
      } else if (raw && typeof raw === 'object' && raw.name && raw.value) {
        cookies = [raw];
      } else if (raw && typeof raw === 'object') {
        if (raw.auth_token || raw.authToken) {
          cookies.push({
            name: 'auth_token',
            value: String(raw.auth_token || raw.authToken),
            domain: '.x.com',
            path: '/',
            httpOnly: true,
            secure: true
          });
        }
        if (raw.ct0) {
          cookies.push({
            name: 'ct0',
            value: String(raw.ct0),
            domain: '.x.com',
            path: '/',
            secure: true
          });
        }
      }

      cookies = (cookies || []).map(c => ({
        name: c.name,
        value: String(c.value || ''),
        domain: c.domain || '.x.com',
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
        sameSite: c.sameSite || 'Lax'
      })).filter(c => c.name && c.value);

      if (cookies.length === 0) {
        log('error', `[${label}] invalid or empty cookie file`);
        return;
      }

      log('info', `[${label}] loaded ${cookies.length} cookie(s)`);

      browser = await chromium.launch({
        headless: false,
        slowMo: 180,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--window-size=1280,800'
        ]
      });
      multiAccountBrowsers.push(browser);

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        locale: 'en-US'
      });
      await context.addCookies(cookies);

      const page = await context.newPage();

      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      log('info', `[${label}] browser ready`);

      await safeGoto(page, 'https://x.com/home', label);
      await maybeHandlePin(page, label, pinToUse);
      await sleep(2000);

      let sent = 0;

      for (const user of targets) {
        if (stopSignal.stopped) break;

        if (getTodayCount(label) >= dailyLimit) {
          log('warn', `[${label}] daily limit ${dailyLimit} reached`);
          break;
        }

        if (alreadySent(label, user)) {
          log('info', `[${label}] already sent to @${user} today — skip`);
          continue;
        }

        const ok = await sendSingleDM(page, user, message, label, pinToUse);
        if (ok) {
          markSent(label, user);
          sent++;
        }

        if (!stopSignal.stopped) {
          const wait = delaySeconds * 1000 + Math.floor(Math.random() * 7000);
          log('delay', `[${label}] waiting ${Math.round(wait / 1000)}s...`);
          await sleep(wait);
        }
      }

      log('done', `[${label}] finished — ${sent} DMs sent this session`);
    } catch (err) {
      log('error', `[${label}] ${err.message}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  await Promise.all(tasks);
  global.broadcast && global.broadcast('status', { running: false });
  log('done', 'All accounts finished');
}

function stopMassDM() {
  log('info', 'Stop requested');
  multiAccountStopSignals.forEach(s => s.stopped = true);
  multiAccountBrowsers.forEach(b => b.close().catch(() => {}));
  multiAccountStopSignals = [];
  multiAccountBrowsers = [];
  global.broadcast && global.broadcast('status', { running: false });
}

module.exports = { startMassDM, stopMassDM };
