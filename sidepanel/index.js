/* CNKI Helper - Side Panel Application */

// ── State ──
let papers = [];
let settings = { useWebVPN: false, fetchLevels: true };
let sortField = "";
let sortDir = "desc";
const downloadState = {};
const logs = [];
const levelCache = new Map();
const levelPending = new Map();
let isBatchDownloading = false;
let manualRecoveryCleanup = null;
let reloginRecoveryCleanup = null;
const MAX_FAIL_RETRIES = 2;
const paperFailRetryCount = new Map();
const retryCapLogged = new Set();
const MAX_CONSECUTIVE_FAIL_STOP = 3;

// ── DOM ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── API Helpers ──
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToContent(msg) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("无活动标签页");
  return chrome.tabs.sendMessage(tab.id, msg);
}

async function sendToBackground(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function ensureContentScript() {
  const tab = await getActiveTab();
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/main.js"],
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Storage ──
async function loadSettings() {
  const data = await chrome.storage.local.get([
    "useWebVPN",
    "fetchLevels",
    "cnkiPapers",
    "cnkiSort",
  ]);
  settings.useWebVPN = data.useWebVPN ?? false;
  settings.fetchLevels = data.fetchLevels ?? true;
  papers = Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
  if (data.cnkiSort) {
    sortField = data.cnkiSort.field || "";
    sortDir = data.cnkiSort.dir || "desc";
  }
}

async function savePapers() {
  await chrome.storage.local.set({ cnkiPapers: papers });
}

async function saveSort() {
  await chrome.storage.local.set({
    cnkiSort: { field: sortField, dir: sortDir },
  });
}

// ── Logging (errors only in UI) ──
function addLog(level, title, detail = "") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.push({ time, level, title, detail });
  if (level === "error") {
    renderLogEntry({ time, level, title, detail });
    updateLogBadge();
    $("#log-panel").hidden = false;
  }
}

function renderLogEntry(entry) {
  const list = $("#log-list");
  if (!list) return;
  const escaped = entry.detail.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const el = document.createElement("div");
  el.className = "log-entry log-error";
  el.innerHTML = `
    <div class="log-entry-header">
      <span class="log-time">${entry.time}</span>
      <span class="log-msg">${entry.title}</span>
      <button class="log-copy-btn" title="复制详情">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
    </div>
    ${escaped ? `<div class="log-detail">${escaped}</div>` : ""}
  `;
  el.querySelector(".log-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(
      `[${entry.time}] ${entry.title}\n${entry.detail}`,
    );
  });
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function renderErrorLogs() {
  const list = $("#log-list");
  if (!list) return;
  list.innerHTML = "";
  logs.filter((l) => l.level === "error").forEach(renderLogEntry);
}

function clearErrorLogsForPaper(paper) {
  const title = String(paper?.title || "").trim();
  const url = String(paper?.pdfLink || "").trim();
  if (!title && !url) return;

  const before = logs.length;
  for (let i = logs.length - 1; i >= 0; i--) {
    const l = logs[i];
    if (l.level !== "error") continue;
    const hitTitle = title && String(l.title || "").includes(title);
    const hitUrl = url && String(l.detail || "").includes(url);
    if (hitTitle || hitUrl) logs.splice(i, 1);
  }

  if (logs.length !== before) {
    renderErrorLogs();
    updateLogBadge();
    if (logs.filter((l) => l.level === "error").length === 0) {
      $("#log-panel").hidden = true;
    }
  }
}

function updateLogBadge() {
  const n = logs.filter((l) => l.level === "error").length;
  $("#log-badge").textContent = n;
  $("#log-badge").hidden = n === 0;
  $("#log-badge-footer").textContent = n;
  $("#log-badge-footer").hidden = n === 0;
}

// ── Utils ──
function createSafeFilename(name, maxLen = 200) {
  let s = name
    .replace(/[\/:*?"<>|\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (s.length > maxLen ? s.substring(0, maxLen) : s) + ".pdf";
}

function extractYearFromDate(dateText) {
  const m = String(dateText || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function getFailRetryCount(id) {
  return paperFailRetryCount.get(id) || 0;
}

function bumpFailRetryCount(id) {
  const next = getFailRetryCount(id) + 1;
  paperFailRetryCount.set(id, next);
  return next;
}

function resetFailRetryCount(id) {
  paperFailRetryCount.delete(id);
  retryCapLogged.delete(id);
}

function hasReachedRetryCap(id) {
  return getFailRetryCount(id) >= MAX_FAIL_RETRIES;
}

function uncheckPaperSelection(id) {
  const cb = document.querySelector(`.paper-check[data-id="${id}"]`);
  if (cb) cb.checked = false;
  updateFooter();
}

function normalizeUrlKey(url) {
  return String(url || "")
    .trim()
    .replace(/#.*$/, "");
}

function extractOrderId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

async function removePaperById(id) {
  papers = papers.filter((p) => p.id !== id);
  delete downloadState[id];
  resetFailRetryCount(id);
  await savePapers();
  renderList();
  restoreChecks();
  updateFooter();
}

function waitManualRecoveryCompletion({ paper, timeoutMs = 15 * 60 * 1000 }) {
  if (!paper?.id || !paper?.pdfLink) {
    return Promise.resolve({ ok: false, reason: "invalid_paper" });
  }

  return new Promise((resolve) => {
    if (manualRecoveryCleanup) {
      manualRecoveryCleanup();
      manualRecoveryCleanup = null;
    }

    const expected = normalizeUrlKey(paper.pdfLink);
    const expectedOrderId = extractOrderId(expected);
    const expectedDetail = normalizeUrlKey(paper.detailUrl || "");
    let matchedId = null;

    const isMatch = (item) => {
      const candidates = [
        normalizeUrlKey(item?.url),
        normalizeUrlKey(item?.finalUrl),
        normalizeUrlKey(item?.referrer),
      ].filter(Boolean);

      for (const c of candidates) {
        if (!c) continue;
        if (
          expected &&
          (c === expected || c.includes(expected) || expected.includes(c))
        ) {
          return true;
        }
        if (expectedDetail && c.includes(expectedDetail)) return true;
        const cid = extractOrderId(c);
        if (expectedOrderId && cid && expectedOrderId === cid) return true;
      }
      return false;
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const onCreate = (item) => {
      if (isMatch(item)) {
        matchedId = item.id;
      }
    };

    const onChange = (delta) => {
      if (matchedId == null || delta.id !== matchedId) return;
      const state = delta.state?.current;
      if (state === "complete") {
        finish({ ok: true });
        return;
      }
      if (state === "interrupted") {
        // Keep waiting for user retry on the same verification page.
        matchedId = null;
      }
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "manual_verify_timeout" });
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreate);
      chrome.downloads.onChanged.removeListener(onChange);
      if (manualRecoveryCleanup === cleanup) manualRecoveryCleanup = null;
    };

    chrome.downloads.onCreated.addListener(onCreate);
    chrome.downloads.onChanged.addListener(onChange);
    manualRecoveryCleanup = cleanup;
  });
}

function resumeFromPaper(paperId, statusText) {
  const paper = papers.find((p) => p.id === paperId);
  if (paper) {
    delete downloadState[paper.id];
    updateCardState(paper.id);
    updateFooter();
  }

  $("#footer-status").textContent = statusText;

  const tryResume = (left = 20) => {
    if (!isBatchDownloading) {
      void downloadSelected(paperId);
      return;
    }
    if (left <= 0) return;
    setTimeout(() => tryResume(left - 1), 300);
  };
  tryResume();
}

async function attemptAutoLogoutAndOpenLogin(tabId) {
  if (!tabId) return;
  await bringTabToFront(tabId);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const textOf = (el) => (el?.innerText || el?.textContent || "").trim();

        const clickByText = (selector, re) => {
          const els = Array.from(document.querySelectorAll(selector));
          const hit = els.find((el) => re.test(textOf(el)));
          if (hit) {
            hit.click();
            return true;
          }
          return false;
        };

        const navByHref = (re) => {
          const links = Array.from(document.querySelectorAll("a[href]"));
          const hit = links.find((a) => re.test(a.getAttribute("href") || ""));
          if (hit) {
            location.assign(hit.href);
            return true;
          }
          return false;
        };

        // 1) Try logout first.
        if (clickByText("a,button", /退出|注销|登出|logout|sign\s*out/i))
          return;
        if (navByHref(/logout|signout|sign-out|exit|\/out\b/i)) return;

        // 2) Then try open login entry.
        if (clickByText("a,button", /登录|登\s*录|login|sign\s*in/i)) return;
        navByHref(/login|signin|sign-in/i);
      },
    });
  } catch {}
}

function startReloginRecoveryWatch({ paper }) {
  if (!paper?.id || !paper?.detailUrl) return;

  if (reloginRecoveryCleanup) {
    reloginRecoveryCleanup();
    reloginRecoveryCleanup = null;
  }

  const startedAt = Date.now();

  const timer = setInterval(async () => {
    // Stop watcher after 30 min.
    if (Date.now() - startedAt > 30 * 60 * 1000) {
      cleanup();
      return;
    }

    try {
      const res = await sendToBackground({
        type: "FETCH_TEXT",
        url: paper.detailUrl,
      });
      const html = String(res?.text || "");
      if (!html) return;

      // Still blocked by relogin/frequent-operation page.
      if (/操作太过频繁|请退出后重新登录|来源应用不正确\(01\)/i.test(html)) {
        return;
      }

      // Login restored if detail page shows PDF download related controls.
      if (
        /id=["']pdfDown["']|btn-download-pdf|btn-dlpdf|PDF下[载載]|download\.aspx/i.test(
          html,
        )
      ) {
        cleanup();
        resumeFromPaper(paper.id, "检测到你已重新登录，从当前论文恢复下载");
      }
    } catch {
      // Ignore transient network errors while waiting for user relogin.
    }
  }, 8000);

  const cleanup = () => {
    clearInterval(timer);
    if (reloginRecoveryCleanup === cleanup) reloginRecoveryCleanup = null;
  };

  reloginRecoveryCleanup = cleanup;
}

async function inspectTabPageType(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const text = (document.body?.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 5000);
        return {
          url: location.href,
          title: document.title || "",
          text,
        };
      },
    });

    const info = result?.result || { url: "", title: "", text: "" };
    const merged = `${info.title} ${info.text}`;

    if (/操作太过频繁|请退出后重新登录|来源应用不正确\(01\)/i.test(merged)) {
      return { pageType: "relogin", ...info };
    }

    if (/滑块|验证码|人机|请完成验证|安全验证|verify|captcha/i.test(merged)) {
      return { pageType: "verify", ...info };
    }

    return { pageType: "unknown", ...info };
  } catch {
    return { pageType: "unknown", url: "", title: "", text: "" };
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(false);
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status !== "complete") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(true);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function bringTabToFront(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id) return;
    await chrome.tabs.update(tab.id, { active: true });
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Ignore focus failures and keep normal flow.
  }
}

async function tryClickPdfButtonInTab(tabId) {
  const [execResult] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const selectors = [
        "a#pdfDown",
        ".btn-download-pdf a",
        "a.btn-dlpdf",
        ".operate-btn a",
        "a[href*='download.aspx']",
        "a[href*='/bar/download/order']",
        "a[href*='pdf']",
      ];

      const isPdfAction = (a) => {
        const text = (a.textContent || "").trim();
        const href = a.getAttribute("href") || a.href || "";
        if (
          /PDF下[载載]|整本下[载載]|Download\s*PDF|下载\s*PDF|PDF/i.test(text)
        )
          return true;
        return /pdfDown|download\.aspx|\/bar\/download\/order|\.pdf(\?|$)/i.test(
          href,
        );
      };

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const pickTarget = () => {
        let target = null;
        let hitSelector = "";

        for (const sel of selectors) {
          const anchors = Array.from(document.querySelectorAll(sel));
          const picked = anchors.find((a) => isPdfAction(a));
          if (picked) {
            target = picked;
            hitSelector = sel;
            break;
          }
        }

        if (!target) {
          const anchors = Array.from(document.querySelectorAll("a[href]"));
          const picked = anchors.find((a) => isPdfAction(a));
          if (picked) {
            target = picked;
            hitSelector = "a[href]";
          }
        }

        return { target, hitSelector };
      };

      let target = null;
      let hitSelector = "";

      // Retry to support pages that render download button asynchronously.
      for (let i = 0; i < 20; i++) {
        const picked = pickTarget();
        target = picked.target;
        hitSelector = picked.hitSelector;
        if (target) break;
        await sleep(500);
      }

      if (!target) {
        return {
          clicked: false,
          reason: "not_found",
          page: location.href,
        };
      }

      const href = target.getAttribute("href") || target.href || "";

      if (!href) {
        return {
          clicked: false,
          reason: "empty_href",
          page: location.href,
        };
      }

      // Prefer same-tab navigation to avoid popup blocking on target=_blank links.
      try {
        if (typeof window.WriteKrsDownLog === "function") {
          window.WriteKrsDownLog();
        }
      } catch {}

      if ((target.getAttribute("target") || "").toLowerCase() === "_blank") {
        window.location.assign(href);
      } else {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        target.click();
      }

      return {
        clicked: true,
        selector: hitSelector,
        text: (target.textContent || "").trim().slice(0, 60),
        href,
        page: location.href,
      };
    },
  });
  return execResult?.result || { clicked: false, reason: "script_failed" };
}

async function openVerificationPage(paper) {
  const url = paper?.detailUrl || paper?.pdfLink || "";
  if (!url) return;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab?.id) return;
    await bringTabToFront(tab.id);

    await waitForTabComplete(tab.id, 20000);
    const clickResult = await tryClickPdfButtonInTab(tab.id);

    if (clickResult.clicked) {
      $("#footer-status").textContent = "已打开详情页并自动点击 PDF 下载按钮";
      return;
    }

    $("#footer-status").textContent = "已打开详情页，请手动点击 PDF 下载按钮";
    addLog(
      "error",
      `自动点击PDF按钮失败: ${paper?.title || "未知论文"}`,
      `详情页: ${url}\n原因: ${clickResult.reason || "未找到按钮"}`,
    );
  } catch (err) {
    addLog("error", "打开验证页失败", `${err.message}\nURL: ${url}`);
  }
}

async function silentRecoverDownload(paper) {
  const url = paper?.detailUrl || paper?.pdfLink || "";
  if (!url) return { ok: false, reason: "no_url" };

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab?.id || null;
    if (!tabId) return { ok: false, reason: "tab_create_failed" };

    await waitForTabComplete(tabId, 20000);
    const clickResult = await tryClickPdfButtonInTab(tabId);
    if (!clickResult?.clicked) {
      await bringTabToFront(tabId);
      const pageInfo = await inspectTabPageType(tabId);
      return {
        ok: false,
        reason: clickResult?.reason || "click_failed",
        tabId,
        pageType: pageInfo.pageType,
        pageUrl: pageInfo.url,
      };
    }

    const recoveryResult = await waitForDownload(paper.pdfLink, 15000);
    if (recoveryResult === "success") {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
      return { ok: true };
    }

    await bringTabToFront(tabId);
    const pageInfo = await inspectTabPageType(tabId);
    return {
      ok: false,
      reason: recoveryResult || "timeout",
      tabId,
      pageType: pageInfo.pageType,
      pageUrl: pageInfo.url,
    };
  } catch (err) {
    if (tabId) {
      await bringTabToFront(tabId);
    }
    let pageType = "unknown";
    let pageUrl = "";
    if (tabId) {
      const info = await inspectTabPageType(tabId);
      pageType = info.pageType;
      pageUrl = info.url;
    }
    return {
      ok: false,
      reason: err?.message || "unknown_error",
      tabId,
      pageType,
      pageUrl,
    };
  }
}

// ── Fetch PDF Links (enriches papers with pdfLink, author, keywords) ──
async function fetchPdfLinks(forceRefresh = false) {
  const pending = forceRefresh
    ? papers.filter((p) => !!p.detailUrl)
    : papers.filter((p) => !p.pdfLink);
  if (pending.length === 0) {
    $("#footer-status").textContent = forceRefresh
      ? "列表中没有可刷新的论文"
      : "所有论文已有下载链接";
    return;
  }

  let done = 0;
  setProgress(
    0,
    `${forceRefresh ? "刷新链接" : "获取链接"} 0/${pending.length}`,
  );

  if (forceRefresh) {
    pending.forEach((paper) => {
      paper.pdfLink = "";
    });
  }

  async function fetchOne(paper) {
    try {
      const res = await sendToBackground({
        type: "FETCH_TEXT",
        url: paper.detailUrl,
      });
      if (res?.text) {
        const doc = new DOMParser().parseFromString(res.text, "text/html");

        // Try multiple strategies to find PDF download link
        let pdfLink = "";

        // Helper: extract href attribute directly (not resolved .href which may mangle relative URLs)
        const getHref = (el) => el?.getAttribute("href") || el?.href || "";

        // Strategy 1: .operate-btn container (domestic CNKI)
        const operateBtn = doc.querySelector(".operate-btn");
        if (operateBtn) {
          const el = Array.from(operateBtn.querySelectorAll("a")).find((a) =>
            /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent),
          );
          if (el) pdfLink = getHref(el);
        }

        // Strategy 2: overseas CNKI (.btn-download-pdf #pdfDown)
        if (!pdfLink) {
          const dlEl = doc.querySelector(
            ".btn-download-pdf a, a#pdfDown, a#cajDown",
          );
          if (dlEl) {
            // Prefer PDF over CAJ
            const pdfEl = doc.querySelector(".btn-download-pdf a, a#pdfDown");
            pdfLink = getHref(pdfEl || dlEl);
          }
        }

        // Strategy 3: common selectors (btn-dlpdf, download.aspx, etc.)
        if (!pdfLink) {
          const dlEl = doc.querySelector(
            "a.btn-dlpdf, a[href*='download.aspx']",
          );
          if (dlEl) pdfLink = getHref(dlEl);
        }

        // Strategy 4: any link containing PDF download text on the page
        if (!pdfLink) {
          const allLinks = Array.from(doc.querySelectorAll("a[href]"));
          const dlLink = allLinks.find((a) =>
            /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent),
          );
          if (dlLink) pdfLink = getHref(dlLink);
        }

        // Resolve relative URL to absolute based on detail page
        if (pdfLink && !pdfLink.startsWith("http")) {
          try {
            pdfLink = new URL(pdfLink, paper.detailUrl).href;
          } catch {}
        }

        if (pdfLink) paper.pdfLink = pdfLink;

        if (!paper.author) {
          paper.author = Array.from(doc.querySelectorAll(".author"))
            .map((a) => a.textContent.trim().replace(/;/g, ""))
            .join("; ");
        }
        if (!paper.keywords) {
          paper.keywords = Array.from(doc.querySelectorAll(".keywords a"))
            .map((k) => k.textContent.replace(/;/g, "").trim())
            .filter(Boolean)
            .join(",");
        }
        if (!paper.abstract) {
          const absEl =
            doc.querySelector("#ChDivSummary") ||
            doc.querySelector(".abstract-text");
          if (absEl) paper.abstract = absEl.textContent.trim();
        }
        const h1 = doc.querySelector(".wx-tit h1");
        if (h1) {
          h1.querySelectorAll("span").forEach((s) => s.remove());
          paper.title = h1.textContent.trim() || paper.title;
        }
      }

      if (!paper.pdfLink) {
        addLog(
          "error",
          `未找到下载链接: ${paper.title}`,
          `详情页: ${paper.detailUrl}`,
        );
      }
    } catch (err) {
      addLog(
        "error",
        `获取链接失败: ${paper.title}`,
        `${err.message}\n详情页: ${paper.detailUrl}`,
      );
    }
    done++;
    setProgress(
      Math.round((done / pending.length) * 100),
      `${forceRefresh ? "刷新链接" : "获取链接"} ${done}/${pending.length}`,
    );
  }

  // Concurrent fetch with limit of 3
  const CONCURRENCY = 3;
  const queue = [...pending];
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const paper = queue.shift();
        await fetchOne(paper);
        await new Promise((r) => setTimeout(r, 300));
      }
    },
  );
  await Promise.all(workers);

  hideProgress();
  await savePapers();
  renderList();
  restoreChecks();
  updateFooter();
  $("#footer-status").textContent = forceRefresh
    ? `已刷新 ${pending.length} 篇链接`
    : "链接获取完成";
  if (settings.fetchLevels) loadAllLevels();
}

// ── Download Logic (via hidden iframe in page context — same as user clicking a link) ──
async function downloadPaper(id) {
  const paper = papers.find((p) => p.id === id);
  if (!paper?.pdfLink) return false;

  if (hasReachedRetryCap(id)) {
    setDownloadState(id, "error", `失败重试已达 ${MAX_FAIL_RETRIES} 次`);
    uncheckPaperSelection(id);
    if (!retryCapLogged.has(id)) {
      retryCapLogged.add(id);
      addLog(
        "error",
        `重试已停止: ${paper.title}`,
        `该论文失败重试已达 ${MAX_FAIL_RETRIES} 次，已停止自动重试。`,
      );
    }
    return "skip";
  }

  setDownloadState(id, "downloading");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("请在知网页面使用");

    const year = extractYearFromDate(paper.date);
    if (year) {
      await sendToBackground({
        type: "REGISTER_DOWNLOAD_META",
        url: paper.pdfLink,
        aliases: [paper.detailUrl],
        year,
        journal: paper.source || "unknown_journal",
      });
    }

    // Trigger download via hidden iframe in page's MAIN world
    // This is a navigation request — sends correct cookies & Referer, no CORS
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (url) => {
        let frame = document.getElementById("__cnki_dl_frame__");
        if (!frame) {
          frame = document.createElement("iframe");
          frame.id = "__cnki_dl_frame__";
          frame.style.cssText =
            "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
          document.body.appendChild(frame);
        }
        frame.src = url;
      },
      args: [paper.pdfLink],
    });

    // Monitor chrome.downloads for the actual download
    const downloadResult = await waitForDownload(paper.pdfLink, 15000);

    if (downloadResult === "success") {
      setDownloadState(id, "success");
      await removePaperById(id);
      clearErrorLogsForPaper(paper);
      return true;
    } else if (downloadResult === "timeout") {
      const failCount = bumpFailRetryCount(id);
      if (failCount >= MAX_FAIL_RETRIES) {
        setDownloadState(id, "error", `失败重试已达 ${MAX_FAIL_RETRIES} 次`);
        uncheckPaperSelection(id);
        if (!retryCapLogged.has(id)) {
          retryCapLogged.add(id);
          addLog(
            "error",
            `重试已停止: ${paper.title}`,
            `该论文失败重试已达 ${MAX_FAIL_RETRIES} 次（最近一次: 下载超时），已停止自动重试。`,
          );
        }
        return "skip";
      }

      // Silent recovery: open detail page in background and auto-click PDF.
      const recovered = await silentRecoverDownload(paper);
      if (recovered.ok) {
        // Silent recovery already completed download, treat it as final success.
        setDownloadState(id, "success");
        await removePaperById(id);
        clearErrorLogsForPaper(paper);
        $("#footer-status").textContent =
          "静默恢复成功，已从列表移除并继续下载下一篇";
        return true;
      }

      setDownloadState(id, "error", "下载未启动，可能需要登录或验证");

      if (recovered.pageType === "verify") {
        addLog(
          "error",
          `下载未启动: ${paper.title}`,
          `URL: ${paper.pdfLink}\n检测结果: 验证页面\n已为你弹出验证页面，请手动验证。当前批量将等待该篇完成后再继续下一篇。`,
        );
        const manualRecovered = await waitManualRecoveryCompletion({ paper });
        if (manualRecovered.ok) {
          setDownloadState(id, "success");
          await removePaperById(id);
          clearErrorLogsForPaper(paper);
          $("#footer-status").textContent =
            "手动验证后已完成该篇下载，继续下一篇";
          return true;
        }

        $("#footer-status").textContent =
          "验证等待超时，已停止批量下载，请手动处理后重启";
        addLog(
          "error",
          `验证等待超时: ${paper.title}`,
          `URL: ${paper.pdfLink}\n长时间未检测到该篇下载完成，已停止本轮批量。`,
        );
        return false;
      }

      if (recovered.pageType === "relogin") {
        if (manualRecoveryCleanup) {
          manualRecoveryCleanup();
          manualRecoveryCleanup = null;
        }
        if (reloginRecoveryCleanup) {
          reloginRecoveryCleanup();
          reloginRecoveryCleanup = null;
        }
        $("#footer-status").textContent =
          "检测到频繁操作需重登，已停止批量下载，请登录后手动重启";

        addLog(
          "error",
          `下载未启动: ${paper.title}`,
          `URL: ${paper.pdfLink}\n检测结果: 频繁操作需重新登录页面\n页面: ${recovered.pageUrl || "(未知)"}\n已停止自动恢复与自动重启，请你手动登录后手动点击批量下载。`,
        );
        return false;
      }

      addLog(
        "error",
        `下载未启动: ${paper.title}`,
        `URL: ${paper.pdfLink}\n原因: ${recovered.reason || "需要登录、验证码或权限不足"}\n页面类型未识别，已弹出页面，请手动处理后重试。`,
      );
      return false;
    } else {
      const failCount = bumpFailRetryCount(id);
      if (failCount >= MAX_FAIL_RETRIES) {
        setDownloadState(id, "error", `失败重试已达 ${MAX_FAIL_RETRIES} 次`);
        uncheckPaperSelection(id);
        if (!retryCapLogged.has(id)) {
          retryCapLogged.add(id);
          addLog(
            "error",
            `重试已停止: ${paper.title}`,
            `该论文失败重试已达 ${MAX_FAIL_RETRIES} 次（最近一次: ${downloadResult}），已停止自动重试。`,
          );
        }
        return "skip";
      }

      setDownloadState(id, "error", downloadResult);
      addLog(
        "error",
        `下载失败: ${paper.title}`,
        `原因: ${downloadResult}\nURL: ${paper.pdfLink}`,
      );
      return false;
    }
  } catch (err) {
    const failCount = bumpFailRetryCount(id);
    if (failCount >= MAX_FAIL_RETRIES) {
      setDownloadState(id, "error", `失败重试已达 ${MAX_FAIL_RETRIES} 次`);
      uncheckPaperSelection(id);
      if (!retryCapLogged.has(id)) {
        retryCapLogged.add(id);
        addLog(
          "error",
          `重试已停止: ${paper.title}`,
          `该论文失败重试已达 ${MAX_FAIL_RETRIES} 次（最近一次: ${err.message || "网络错误"}），已停止自动重试。`,
        );
      }
      return "skip";
    }

    setDownloadState(id, "error", err.message || "网络错误");
    addLog(
      "error",
      `下载失败: ${paper.title}`,
      `${err.message}\nURL: ${paper.pdfLink}`,
    );
    return false;
  }
}

// Wait for a download to appear and complete
function waitForDownload(expectedUrl, timeoutMs) {
  return new Promise((resolve) => {
    let matchedId = null;
    const timeout = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(onCreate);
      chrome.downloads.onChanged.removeListener(onChange);
      resolve("timeout");
    }, timeoutMs);

    const onCreate = (item) => {
      // Match by URL pattern (CNKI direct or WebVPN)
      if (
        item.url.includes("cnki") ||
        item.url.includes("download") ||
        item.finalUrl?.includes("cnki") ||
        item.finalUrl?.includes("download")
      ) {
        matchedId = item.id;
      }
    };

    const onChange = (delta) => {
      if (delta.id !== matchedId) return;
      if (delta.state?.current === "complete") {
        clearTimeout(timeout);
        chrome.downloads.onCreated.removeListener(onCreate);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve("success");
      } else if (delta.state?.current === "interrupted") {
        clearTimeout(timeout);
        chrome.downloads.onCreated.removeListener(onCreate);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve(delta.error?.current || "下载中断");
      }
    };

    chrome.downloads.onCreated.addListener(onCreate);
    chrome.downloads.onChanged.addListener(onChange);
  });
}

async function downloadSelected(startFromId = null) {
  if (isBatchDownloading) return;
  isBatchDownloading = true;
  let selected = getSelectedIds();
  try {
    if (startFromId != null) {
      const idx = selected.indexOf(startFromId);
      if (idx >= 0) {
        selected = selected.slice(idx);
      } else {
        selected = [startFromId, ...selected];
      }
    }

    if (selected.length === 0) return;
    for (const id of selected) {
      if (downloadState[id]?.status === "success") continue;
      const paper = papers.find((p) => p.id === id);
      if (!paper?.pdfLink) continue;
      const ok = await downloadPaper(id);
      if (ok === "restart") {
        break;
      }
      if (ok === "skip") {
        $("#footer-status").textContent =
          `当前论文未下载完成，已停止批量：${paper.title}`;
        addLog(
          "error",
          "批量下载已停止",
          `当前论文未下载完成，不启动下一篇。\n论文: ${paper?.title || id}`,
        );
        break;
      }
      if (!ok) {
        $("#footer-status").textContent =
          `当前论文未下载完成，已停止批量：${paper.title}`;
        addLog(
          "error",
          "批量下载已停止",
          `当前论文未下载完成，不启动下一篇。\n论文: ${paper?.title || id}`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, randomDelay(1000, 2000)));
    }
  } finally {
    isBatchDownloading = false;
  }
}

function setDownloadState(id, status, error = "") {
  downloadState[id] = { status, error };
  updateCardState(id);
  updateFooter();
}

// ── Journal Levels ──
async function fetchLevel(url) {
  if (!url) return "无";
  if (levelCache.has(url)) return levelCache.get(url);
  if (levelPending.has(url)) return levelPending.get(url);
  const promise = (async () => {
    try {
      const res = await sendToBackground({ type: "FETCH_TEXT", url });
      if (!res?.text) return "无";
      const doc = new DOMParser().parseFromString(res.text, "text/html");
      const spans = Array.from(
        doc.querySelectorAll(".journalType.journalType2 > span"),
      );
      return (
        spans
          .map((s) => s.textContent.trim())
          .filter(Boolean)
          .join("/") || "无"
      );
    } catch {
      return "无";
    }
  })();
  levelPending.set(url, promise);
  const result = await promise;
  levelCache.set(url, result);
  levelPending.delete(url);
  return result;
}

async function loadAllLevels() {
  if (!settings.fetchLevels) return;
  for (const paper of papers) {
    if (!paper.sourceUrl || paper.level !== "Wait") continue;
    paper.level = await fetchLevel(paper.sourceUrl);
    updateCardLevel(paper.id, paper.level);
  }
  await savePapers();
}

// ── Rendering ──
function getSortedPapers() {
  if (!sortField) return [...papers];
  return [...papers].sort((a, b) => {
    let va = a[sortField] || "",
      vb = b[sortField] || "";
    if (sortField !== "date") {
      va = parseInt(va) || 0;
      vb = parseInt(vb) || 0;
    }
    return va < vb
      ? sortDir === "asc"
        ? -1
        : 1
      : va > vb
        ? sortDir === "asc"
          ? 1
          : -1
        : 0;
  });
}

function renderList() {
  const list = $("#paper-list");
  const header = $("#list-header");
  list.innerHTML = "";

  if (papers.length === 0) {
    header.hidden = true;
    list.innerHTML = `
      <div class="empty">
        <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <div class="empty-title">暂无收藏</div>
        <div class="empty-desc">在知网搜索结果页点击论文旁的 + 按钮收藏<br>或点击上方「添加本页」一键收藏当前页</div>
      </div>`;
    updateFooter();
    return;
  }

  header.hidden = false;
  getSortedPapers().forEach((paper, idx) =>
    list.appendChild(createPaperCard(paper, idx)),
  );
  updateFooter();
  updateSortPills();
}

function createPaperCard(paper) {
  const card = document.createElement("div");
  card.className = "paper-card";
  card.dataset.id = paper.id;

  const state = downloadState[paper.id];
  if (state) card.dataset.status = state.status;
  const hasPdf = !!paper.pdfLink;
  if (!hasPdf && !state) card.dataset.status = "pending";

  const levelHtml = renderLevel(paper.level);
  const kwHtml = paper.keywords
    ? paper.keywords
        .split(",")
        .map((k) => `<span class="kw-tag">${k}</span>`)
        .join("")
    : "";

  const abstractHtml = paper.abstract
    ? `<div class="paper-abstract" hidden>${paper.abstract}</div>`
    : "";
  const hasAbstract = !!paper.abstract;

  card.innerHTML = `
    <label class="check">
      <input type="checkbox" class="paper-check" data-id="${paper.id}" ${hasPdf ? "" : "disabled"}>
      <span class="check-box"></span>
    </label>
    <div class="paper-body">
      <div class="paper-title-row">
        <div class="paper-title" title="${paper.title.replace(/"/g, "&quot;")}">${paper.title}</div>
        <div class="paper-title-actions">
          ${hasAbstract ? `<button class="icon-btn abstract-toggle-btn" data-id="${paper.id}" title="查看摘要"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></button>` : ""}
          <button class="icon-btn copy-info-btn" data-id="${paper.id}" title="复制文献信息"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <button class="icon-btn delete-paper-btn" data-id="${paper.id}" title="删除该论文"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
        </div>
      </div>
      <div class="paper-meta">
        ${paper.author ? `<span class="author">${paper.author}</span><span class="dot">&middot;</span>` : ""}
        ${paper.source ? `<span>${paper.source}</span><span class="dot">&middot;</span>` : ""}
        <span>${paper.date || "无日期"}</span>
      </div>
      ${abstractHtml}
      <div class="paper-bottom">
        <div class="paper-stats">
          <span>被引 <strong>${paper.quote || 0}</strong></span>
          <span>下载 <strong>${paper.download || 0}</strong></span>
          ${levelHtml}
        </div>
        <div class="paper-action" data-id="${paper.id}">
          ${renderAction(paper.id, paper.pdfLink)}
        </div>
      </div>
      ${kwHtml ? `<div class="keyword-tags">${kwHtml}</div>` : ""}
    </div>
  `;
  return card;
}

function renderLevel(level) {
  if (!settings.fetchLevels || !level || level === "Wait" || level === "无")
    return "";
  return level
    .split("/")
    .map((l) => `<span class="level-tag">${l}</span>`)
    .join(" ");
}

function renderAction(id, pdfLink) {
  const state = downloadState[id];
  if (!state) {
    if (pdfLink) return `<button class="dl-btn" data-id="${id}">PDF</button>`;
    return `<span class="pending-tag">待获取链接</span>`;
  }
  if (state.status === "downloading")
    return `<span class="status status-downloading"><span class="spinner"></span>下载中</span>`;
  if (state.status === "success")
    return `<span class="status status-success">&#10003; 完成</span>`;
  if (state.status === "error")
    return `<span class="status status-error" title="${state.error}">&#10007; 失败</span><button class="retry-btn" data-id="${id}">重试</button>`;
  return "";
}

function updateCardState(id) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  card.dataset.status = downloadState[id]?.status || "";
  const el = card.querySelector(".paper-action");
  if (el)
    el.innerHTML = renderAction(id, papers.find((p) => p.id === id)?.pdfLink);
}

function updateCardLevel(id, level) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  const stats = card.querySelector(".paper-stats");
  if (!stats) return;
  stats.querySelectorAll(".level-tag").forEach((el) => el.remove());
  const html = renderLevel(level);
  if (html) stats.insertAdjacentHTML("beforeend", html);
}

function updateSortPills() {
  $$(".sort-pill").forEach((p) =>
    p.classList.toggle("active", p.dataset.sort === sortField),
  );
}

function getSelectedIds() {
  return Array.from($$(".paper-check:checked")).map((cb) =>
    parseInt(cb.dataset.id),
  );
}

function restoreChecks() {
  $$(".paper-check").forEach((cb) => {
    if (!cb.disabled) cb.checked = true;
  });
}

function updateFooter() {
  const total = papers.length;
  const ready = papers.filter((p) => p.pdfLink).length;
  const selected = $$(".paper-check:checked").length;
  const done = Object.values(downloadState).filter(
    (s) => s.status === "success",
  ).length;
  const parts = [`${total} 篇`];
  if (ready < total) parts.push(`${ready} 可下载`);
  if (selected > 0) parts.push(`已选 ${selected}`);
  if (done > 0) parts.push(`完成 ${done}`);
  $("#footer-status").textContent = parts.join("  ·  ");
  $("#dl-count").textContent = selected > 0 ? `(${selected})` : "";
  $("#list-count").textContent = `${total} 篇`;
}

function setProgress(pct, text) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = pct + "%";
  if (text) $("#progress-text").textContent = text;
}

function hideProgress() {
  $("#progress").hidden = true;
  $("#progress-fill").style.width = "0";
}

// ── Events ──
function bindEvents() {
  // Add all papers from current page
  $("#btn-add-page").addEventListener("click", async () => {
    const ok = await ensureContentScript();
    if (!ok) {
      $("#footer-status").textContent = "请在知网页面使用";
      return;
    }
    try {
      const result = await sendToContent({
        type: "ADD_ALL_PAGE",
        useWebVPN: settings.useWebVPN,
      });
      if (!result?.ok) {
        $("#footer-status").textContent =
          result?.error === "no_links" ? "当前页未找到文献" : "添加失败";
        return;
      }
      // Reset sort to default (insertion order) after adding
      if (result.added > 0 && sortField !== "") {
        sortField = "";
        sortDir = "desc";
        saveSort();
      }
      // Storage change will trigger renderList via onChanged listener
      $("#footer-status").textContent =
        result.added > 0
          ? `已添加 ${result.added} 篇 (本页共 ${result.total} 篇)`
          : `本页 ${result.total} 篇均已在列表中`;
    } catch (err) {
      $("#footer-status").textContent = "添加失败: " + err.message;
    }
  });

  // Fetch PDF links for pending papers
  $("#btn-fetch-links").addEventListener("click", fetchPdfLinks);
  $("#btn-refresh-links").addEventListener("click", () => fetchPdfLinks(true));

  // Batch download
  $("#btn-batch-dl").addEventListener("click", () => downloadSelected());

  // Clear
  $("#btn-clear").addEventListener("click", async () => {
    papers = [];
    Object.keys(downloadState).forEach((k) => delete downloadState[k]);
    await savePapers();
    renderList();
  });

  // Select all
  $("#select-all").addEventListener("change", (e) => {
    $$(".paper-check").forEach((cb) => {
      if (!cb.disabled) cb.checked = e.target.checked;
    });
    updateFooter();
  });

  // Sort
  $$(".sort-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const field = pill.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === "desc" ? "asc" : "desc";
      } else {
        sortField = field;
        sortDir = field === "date" ? "asc" : "desc";
      }
      saveSort();
      renderList();
      restoreChecks();
      updateFooter();
    });
  });

  // Paper list clicks
  $("#paper-list").addEventListener("click", (e) => {
    const dl = e.target.closest(".dl-btn");
    if (dl) {
      downloadPaper(parseInt(dl.dataset.id));
      return;
    }
    const retry = e.target.closest(".retry-btn");
    if (retry) {
      const id = parseInt(retry.dataset.id);
      // Manual retry should clear the automatic retry cap for this paper.
      resetFailRetryCount(id);
      downloadPaper(id);
      return;
    }

    // Abstract toggle
    const absBtn = e.target.closest(".abstract-toggle-btn");
    if (absBtn) {
      const card = absBtn.closest(".paper-card");
      const absEl = card?.querySelector(".paper-abstract");
      if (absEl) {
        absEl.hidden = !absEl.hidden;
        absBtn.classList.toggle("active", !absEl.hidden);
      }
      return;
    }

    // Copy paper info
    const copyBtn = e.target.closest(".copy-info-btn");
    if (copyBtn) {
      const id = parseInt(copyBtn.dataset.id);
      const paper = papers.find((p) => p.id === id);
      if (paper) {
        const parts = [paper.title];
        if (paper.author) parts.push(paper.author);
        if (paper.source) parts.push(paper.source);
        if (paper.date) parts.push(paper.date);
        navigator.clipboard.writeText(parts.join(". ")).then(() => {
          copyBtn.classList.add("copied");
          setTimeout(() => copyBtn.classList.remove("copied"), 1500);
        });
      }
      return;
    }

    // Delete paper
    const delBtn = e.target.closest(".delete-paper-btn");
    if (delBtn) {
      const id = parseInt(delBtn.dataset.id);
      const paper = papers.find((p) => p.id === id);
      removePaperById(id).then(() => {
        if (paper?.title) {
          $("#footer-status").textContent = `已删除：${paper.title}`;
        }
      });
      return;
    }
  });

  // Checkbox changes
  $("#paper-list").addEventListener("change", (e) => {
    if (e.target.classList.contains("paper-check")) updateFooter();
  });

  // Toggles
  $("#toggle-webvpn").addEventListener("change", async (e) => {
    settings.useWebVPN = e.target.checked;
    await chrome.storage.local.set({ useWebVPN: settings.useWebVPN });
  });
  $("#toggle-levels").addEventListener("change", async (e) => {
    settings.fetchLevels = e.target.checked;
    await chrome.storage.local.set({ fetchLevels: settings.fetchLevels });
    renderList();
    restoreChecks();
    updateFooter();
    if (settings.fetchLevels) loadAllLevels();
  });

  // Log panel
  $("#log-toggle").addEventListener("click", () => {
    $("#log-panel").hidden = !$("#log-panel").hidden;
  });
  $("#log-clear").addEventListener("click", () => {
    logs.length = 0;
    $("#log-list").innerHTML = "";
    updateLogBadge();
    $("#log-panel").hidden = true;
  });
  $("#log-copy-all").addEventListener("click", () => {
    const text = logs
      .filter((l) => l.level === "error")
      .map((l) => `[${l.time}] ${l.title}\n  ${l.detail}`)
      .join("\n\n");
    navigator.clipboard.writeText(text);
  });

  // Real-time storage sync (papers added from content script)
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.cnkiPapers) return;
    papers = changes.cnkiPapers.newValue || [];
    renderList();
    restoreChecks();
    updateFooter();
  });
}

// ── Init ──
async function init() {
  await loadSettings();
  $("#toggle-webvpn").checked = settings.useWebVPN;
  $("#toggle-levels").checked = settings.fetchLevels;
  bindEvents();
  renderList();
  if (papers.length > 0) {
    setTimeout(() => {
      restoreChecks();
      updateFooter();
      if (settings.fetchLevels) loadAllLevels();
    }, 50);
  }
}

init();
