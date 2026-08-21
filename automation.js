// =====================================================
// Mass DM Bot - Hardened Version
// Better cookies • Better selectors • Better success check
// Proxy support • Stronger PIN handling
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
  return String(raw || '').replace(/^@/, '').trim().toLowerCase();
}

// ─────────────────────────────────────────────
// DEBUG
// ─────────────────────────────────────────────
const DEBUG_DIR = path.join(__dirname, 'public', 'debug');
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function shot(page, name) {
  try {
    await page.screenshot({
      path: path.join(DEBUG_DIR, `${name}_${Date.now()}.png`),
      fullPage: false
    });
  } catch {}
}

// ─────────────────────────────────────────────
// PIN / CHALLENGE
// ─────────────────────────────────────────────
function isPinUrl(url = '') {
  return /\/pin\/|\/recovery|\/challenge|\/verification|ocf|\/i\/flow\/|passcode|account\/access|login\/error/i.test(url);
}

function isPinPageContent(text = '') {
  const t = (text || '').toLowerCase();
  return (
    t.includes('passcode is required') ||
    t.includes('enter passcode') ||
    t.includes('enter the code') ||
    t.includes('verification code') ||
    t.includes("confirm it's you") ||
    t.includes('help us protect') ||
    t.includes('authenticate') ||
    t.includes('one-time code') ||
    t.includes('enter your passcode') ||
    t.includes('suspicious login') ||
    t.includes('verify your identity')
  );
}

async function handlePinPage(page, label, passcode) {
  if (!passcode || !String(passcode).trim()) {
    log('warn', `[${label}] Challenge detected but no passcode provided`);
    return false;
  }

  const code = String(passcode).trim();
  log('info', `[${label}] ⚠️ Challenge detected — trying careful unlock`);

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await shot(page, `challenge_${label}_try${attempt}`);

      // Wait a bit for the challenge UI to fully load
      await sleep(1500);

      // Try very specific challenge inputs first
      const challengeSelectors = [
        'input[name="text"]',
        'input[type="text"]',
        'input[inputmode="numeric"]',
        'input[autocomplete="one-time-code"]',
        'input[data-testid*="ocf"]',
        'input[data-testid*="pin"]',
        'input[data-testid*="challenge"]',
        'input[placeholder*="code" i]',
        'input[placeholder*="passcode" i]',
        'input[aria-label*="code" i]',
        'input[aria-label*="passcode" i]',
        'input:not([type="hidden"])'
      ];

      let input = null;

      for (const sel of challengeSelectors) {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) {
          // Make sure it's not the main tweet composer
          const testId = (await el.getAttribute('data-testid').catch(() => '')) || '';
          const aria = (await el.getAttribute('aria-label').catch(() => '')) || '';
          if (
            testId.toLowerCase().includes('tweet') ||
            testId.toLowerCase().includes('composer') ||
            aria.toLowerCase().includes('post') ||
            aria.toLowerCase().includes('tweet')
          ) {
            continue; // skip main post box
          }
          input = el;
          break;
        }
      }

      if (!input) {
        // fallback: any visible input that is not the big composer
        const allInputs = await page.$$('input:not([type="hidden"])');
        for (const el of allInputs) {
          if (await el.isVisible().catch(() => false)) {
            const box = await el.boundingBox().catch(() => null);
            if (box && box.height < 60) { // challenge inputs are usually small
              input = el;
              break;
            }
          }
        }
      }

      if (!input) {
        log('warn', `[${label}] No challenge input found (attempt ${attempt})`);
        await sleep(2000);
        continue;
      }

      // Focus carefully
      await input.click({ clickCount: 3 }).catch(() => {});
      await sleep(300);
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await sleep(200);

      // Type slowly
      for (const char of code) {
        await page.keyboard.type(char, { delay: 120 + Math.random() * 80 });
        await sleep(50 + Math.random() * 40);
      }

      await sleep(800);

      // Try Enter + possible buttons
      await page.keyboard.press('Enter').catch(() => {});
      await sleep(1000);

      const buttons = await page.$$('div[role="button"], button');
      for (const btn of buttons) {
        const txt = ((await btn.textContent().catch(() => '')) || '').toLowerCase();
        if (
          txt.includes('next') ||
          txt.includes('verify') ||
          txt.includes('confirm') ||
          txt.includes('continue') ||
          txt.includes('submit') ||
          txt.includes('unlock')
        ) {
          await btn.click({ force: true }).catch(() => {});
          await sleep(1200);
        }
      }

      // Wait for result
      await sleep(5000);

      const pageText = (await page.textContent('body').catch(() => '')) || '';
      const stillChallenge = isPinUrl(page.url()) || isPinPageContent(pageText);

      if (!stillChallenge) {
        log('info', `[${label}] ✅ Challenge passed`);
        return true;
      }

      log('warn', `[${label}] Challenge still present (attempt ${attempt})`);
    } catch (e) {
      log('warn', `[${label}] Challenge attempt ${attempt} failed: ${e.message.slice(0, 100)}`);
    }

    await sleep(2000);
  }

  log('fail', `[${label}] All challenge attempts failed`);
  return false;
}

async function maybeHandlePin(page, label, passcode) {
  const url = page.url();
  const text = (await page.textContent('body').catch(() => '')) || '';
  if (isPinUrl(url) || isPinPageContent(text)) {
    return await handlePinPage(page, label, passcode);
  }
  return true;
}

// ─────────────────────────────────────────────
// DM LOG
// ─────────────────────────────────────────────
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

function alreadySent(label, username) {
  const logData = getDmLog();
  const today = new Date().toISOString().slice(0, 10);
  return (logData[label]?.[today] || []).includes(username);
}

function markSent(label, username) {
  const logData = getDmLog();
  const today = new Date().toISOString().slice(0, 10);
  if (!logData[label]) logData[label] = {};
  if (!logData[label][today]) logData[label][today] = [];
  if (!logData[label][today].includes(username)) {
    logData[label][today].push(username);
  }
  saveDmLog(logData);
}

// ─────────────────────────────────────────────
// SELECTORS (stronger set)
// ─────────────────────────────────────────────
const SELECTORS = {
  messageButton: [
    '[data-testid="sendDMFromProfile"]',
    'div[data-testid="sendDMFromProfile"]',
    'a[href*="/messages/"]',
    '[aria-label="Message"]',
    'div[role="button"][aria-label*="Message"]',
    'div[role="button"]:has-text("Message")',
    'button:has-text("Message")'
  ],
  composer: [
    '[data-testid="dmComposerTextInput"]',
    'div[data-testid="dmComposerTextInput"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[aria-label*="Message"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]'
  ],
  sendButton: [
    '[data-testid="dmComposerSendButton"]',
    'div[data-testid="dmComposerSendButton"]',
    '[aria-label="Send"]',
    'div[role="button"][aria-label="Send"]',
    'div[role="button"]:has-text("Send")',
    'button:has-text("Send")'
  ],
  searchPeople: [
    '[data-testid="searchPeople"]',
    'input[placeholder*="Search"]',
    'input[aria-label*="Search"]',
    'div[role="combobox"] input'
  ],
  userResult: [
    '[data-testid="TypeaheadUser"]',
    'div[data-testid="TypeaheadUser"]',
    'div[role="option"]',
    'li[role="option"]'
  ]
};

async function findAndClick(page, selectors, timeout = 4500) {
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

async function findVisible(page, selectors, timeout = 4500) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout, state: 'visible' }).catch(() => null);
      if (el && await el.isVisible().catch(() => false)) return el;
    } catch {}
  }
  return null;
}

async function safeGoto(page, url, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000 + Math.random() * 1200);
    return true;
  } catch (e) {
    log('warn', `[${label}] goto failed: ${e.message.slice(0, 90)}`);
    return false;
  }
}

// ─────────────────────────────────────────────
// SUCCESS DETECTION (important)
// ─────────────────────────────────────────────
async function didMessageActuallySend(page) {
  // After sending, composer should clear or send button should disable / message bubble appear
  try {
    const composer = await findVisible(page, SELECTORS.composer, 2000);
    if (composer) {
      const text = (await composer.innerText().catch(() => '')) || '';
      if (text.trim().length === 0) return true;
    }

    // Look for recent outgoing message indicators
    const possible = await page.$$('[data-testid="messageEntry"], div[data-testid*="message"]');
    if (possible.length > 0) return true;

    return false;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// CORE SEND DM
// ─────────────────────────────────────────────
async function sendSingleDM(page, username, message, label, passcode) {
  const user = parseUsername(username);
  log('info', `[${label}] → starting DM to @${user}`);

  // Go to profile
  await safeGoto(page, `https://x.com/${user}`, label);
  if (!(await maybeHandlePin(page, label, passcode))) {
    log('fail', `[${label}] @${user} — blocked by challenge on profile`);
    return false;
  }

  await shot(page, `profile_${user}`);

  // Try Message button on profile
  let opened = await findAndClick(page, SELECTORS.messageButton, 5000);

  if (!opened) {
    log('warn', `[${label}] Message button not found — falling back to compose`);
    await safeGoto(page, 'https://x.com/messages/compose', label);
    if (!(await maybeHandlePin(page, label, passcode))) {
      log('fail', `[${label}] @${user} — blocked on compose`);
      return false;
    }

    const searchBox = await findVisible(page, SELECTORS.searchPeople, 6000);
    if (!searchBox) {
      log('fail', `[${label}] @${user} — search box not found`);
      await shot(page, `compose_fail_${user}`);
      return false;
    }

    await searchBox.click({ clickCount: 2 }).catch(() => {});
    await sleep(250);
    await page.keyboard.type(user, { delay: 45 + Math.random() * 30 });
    await sleep(1800 + Math.random() * 800);

    let picked = await findAndClick(page, SELECTORS.userResult, 4000);
    if (!picked) {
      await page.keyboard.press('Enter');
      await sleep(1200);
    } else {
      await sleep(1500);
    }
  } else {
    log('info', `[${label}] Opened Message from profile`);
    await sleep(2200 + Math.random() * 800);
  }

  if (!(await maybeHandlePin(page, label, passcode))) {
    log('fail', `[${label}] @${user} — challenge after opening chat`);
    return false;
  }

  // Find composer
  let input = await findVisible(page, SELECTORS.composer, 7000);

  if (!input) {
    // Sometimes needs Next
    await findAndClick(page, [
      'div[role="button"]:has-text("Next")',
      'button:has-text("Next")',
      '[data-testid="nextButton"]'
    ], 2500);
    await sleep(1500);
    input = await findVisible(page, SELECTORS.composer, 5000);
  }

  if (!input) {
    log('fail', `[${label}] @${user} — message input not found`);
    await shot(page, `no_input_${user}`);
    log('info', `[${label}] Current URL: ${page.url()}`);
    return false;
  }

  // Type message
  await input.click({ clickCount: 2 }).catch(() => {});
  await sleep(300);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await sleep(200);

  await page.keyboard.type(message, { delay: 22 + Math.random() * 28 });
  await sleep(600 + Math.random() * 400);

  // Send
  let clickedSend = await findAndClick(page, SELECTORS.sendButton, 3000);
  if (!clickedSend) {
    await page.keyboard.press('Enter');
  }

  await sleep(2200 + Math.random() * 1000);

  // REAL success check
  const success = await didMessageActuallySend(page);

  if (success) {
    log('info', `[${label}] ✅ DM confirmed sent to @${user}`);
    await shot(page, `sent_ok_${user}`);
    return true;
  } else {
    log('fail', `[${label}] ❌ DM to @${user} — could not confirm send`);
    await shot(page, `sent_fail_${user}`);
    return false;
  }
}

// ─────────────────────────────────────────────
// LAUNCH BROWSER (with proxy + better fingerprint)
// ─────────────────────────────────────────────
async function launchHardenedBrowser(proxy = null) {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox'
  ];

  const launchOptions = {
    headless: false, // keep false for higher success
    args
  };

  if (proxy) {
    // proxy format: http://user:pass@ip:port  or  http://ip:port
    launchOptions.proxy = { server: proxy };
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  // Light stealth
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

// ─────────────────────────────────────────────
// MASS DM RUNNER
// ─────────────────────────────────────────────
async function startMassDM(accounts, message, dailyLimit = 40, delaySeconds = 55, passcode = '', proxy = null) {
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

  log('start', `Mass DM started | ${accounts.length} account(s) | ${targets.length} targets | delay ${delaySeconds}s | limit ${dailyLimit}/day`);

  multiAccountStopSignals = [];
  multiAccountBrowsers = [];
  global.broadcast && global.broadcast('status', { running: true });

  const tasks = accounts.map(async ({ cookiesPath, label, passcode: accountPasscode }) => {
    if (!fs.existsSync(cookiesPath)) {
      log('error', `[${label}] cookies file missing`);
      return;
    }

    const stopSignal = { stop: false };
    multiAccountStopSignals.push(stopSignal);

    let browser, context, page;

    try {
      ({ browser, context, page } = await launchHardenedBrowser(proxy));
      multiAccountBrowsers.push(browser);

      // Load cookies (now supports full array)
      const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
      const cookies = Array.isArray(raw) ? raw : [];
      if (cookies.length === 0) {
        log('error', `[${label}] no cookies found`);
        return;
      }

      await context.addCookies(cookies);
      log('info', `[${label}] Loaded ${cookies.length} cookies`);

      await safeGoto(page, 'https://x.com/home', label);
      if (!(await maybeHandlePin(page, label, accountPasscode || passcode))) {
        log('fail', `[${label}] Could not pass initial challenge`);
        return;
      }

      let sentCount = 0;

      for (const user of targets) {
        if (stopSignal.stop) break;
        if (sentCount >= dailyLimit) {
          log('info', `[${label}] Daily limit reached (${dailyLimit})`);
          break;
        }
        if (alreadySent(label, user)) {
          log('info', `[${label}] Skipping @${user} (already sent today)`);
          continue;
        }

        const ok = await sendSingleDM(page, user, message, label, accountPasscode || passcode);
        if (ok) {
          markSent(label, user);
          sentCount++;
        }

        const wait = (delaySeconds * 1000) + Math.floor(Math.random() * 8000);
        log('info', `[${label}] Waiting ${(wait / 1000).toFixed(1)}s...`);
        await sleep(wait);
      }

      log('info', `[${label}] Finished. Sent: ${sentCount}`);
    } catch (e) {
      log('error', `[${label}] Fatal: ${e.message}`);
    } finally {
      try { await browser?.close(); } catch {}
    }
  });

  await Promise.all(tasks);
  global.broadcast && global.broadcast('status', { running: false });
  log('info', 'All accounts finished');
}

function stopMassDM() {
  multiAccountStopSignals.forEach(s => (s.stop = true));
  multiAccountBrowsers.forEach(b => {
    try { b.close(); } catch {}
  });
  multiAccountBrowsers = [];
  global.broadcast && global.broadcast('status', { running: false });
  log('info', 'Stop signal sent');
}

module.exports = { startMassDM, stopMassDM };
