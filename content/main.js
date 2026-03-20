/* Content Script - CNKI search results page collection + extraction */
(function () {
  if (window.__cnkiHelperLoaded) return;
  window.__cnkiHelperLoaded = true;
  let contextInvalid = false;

  function isContextInvalidatedError(err) {
    return /Extension context invalidated/i.test(
      String(err?.message || err || ""),
    );
  }

  function markContextInvalid(err) {
    if (contextInvalid) return;
    contextInvalid = true;
    console.warn("[CNKI助手] 扩展上下文已失效，请刷新当前页面后重试。", err);
  }

  // ── Title link selectors (try specific first, fallback to broad) ──
  const TITLE_SELECTORS = [
    "table.result-table-list .name a.fz14",
    ".result-table-list .fz14",
    "#gridTable .fz14",
    ".fz14",
    // Fallback: any link in result table name column pointing to detail pages
    "table.result-table-list .name a",
    "table.result-table-list td.name a",
    '.result-table-list a[href*="/kcms"]',
    '.result-table-list a[href*="detail"]',
  ];

  function getTitleLinks() {
    for (const sel of TITLE_SELECTORS) {
      const links = document.querySelectorAll(sel);
      if (links.length > 0) return links;
    }
    return [];
  }

  // ── Inject Styles ──
  const css = document.createElement("style");
  css.textContent = `
    .cnki-h-btn {
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      width: 20px; height: 20px;
      border: 1.5px solid #d1d5db;
      border-radius: 50%;
      background: #fff !important;
      color: #9ca3af;
      font-size: 14px;
      cursor: pointer;
      margin-left: 4px;
      vertical-align: middle;
      transition: all .15s;
      line-height: 20px;
      padding: 0;
      text-align: center;
      text-indent: 0;
      font-family: system-ui, sans-serif;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
      position: relative;
      z-index: 10;
      flex-shrink: 0;
      visibility: visible !important;
      opacity: 1 !important;
    }
    .cnki-h-btn:hover { border-color: #4f46e5; color: #4f46e5; background: #eef2ff !important; }
    .cnki-h-btn.collected {
      border-color: #4f46e5; background: #4f46e5 !important; color: #fff;
      box-shadow: 0 1px 4px rgba(79,70,229,.25);
    }
    .cnki-h-btn.collected:hover { background: #4338ca !important; border-color: #4338ca; }
  `;

  // ── Helpers ──
  function urlId(url) {
    let h = 0;
    for (let i = 0; i < url.length; i++)
      h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function extractFromRow(linkEl) {
    const row = linkEl.closest("tr") || linkEl.closest(".list-item");
    const title = linkEl.textContent.trim();
    const detailUrl = linkEl.href;
    let date = "",
      quote = "0",
      download = "0",
      source = "",
      sourceUrl = "";
    if (row) {
      date = row.querySelector(".date")?.textContent?.trim() || "";
      quote = row.querySelector(".quote")?.textContent?.trim() || "0";
      download = row.querySelector(".download")?.textContent?.trim() || "0";
      const src = row.querySelector(".source a");
      if (src) {
        source = src.textContent.trim();
        sourceUrl = src.href;
      }
    }
    return { title, detailUrl, date, quote, download, source, sourceUrl };
  }

  function convertToWebVPNLink(link, useWebVPN) {
    if (!useWebVPN) return link;
    return (
      window.location.origin + link.replace(/^(https?:\/\/)?(www\.)?[^/]+/, "")
    );
  }

  // ── Storage Operations ──
  async function getPapers() {
    if (contextInvalid) return [];
    try {
      const data = await chrome.storage.local.get(["cnkiPapers"]);
      return Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        markContextInvalid(err);
        return [];
      }
      throw err;
    }
  }

  async function setPapers(nextPapers) {
    if (contextInvalid) return false;
    try {
      await chrome.storage.local.set({ cnkiPapers: nextPapers });
      return true;
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        markContextInvalid(err);
        return false;
      }
      throw err;
    }
  }

  const removedCache = new Map(); // temporarily cache removed papers to preserve fetched data

  async function togglePaper(info) {
    if (contextInvalid) return false;
    const papers = await getPapers();
    const idx = papers.findIndex((p) => p.detailUrl === info.detailUrl);
    if (idx >= 0) {
      // Cache the full paper data before removing
      removedCache.set(info.detailUrl, papers[idx]);
      papers.splice(idx, 1);
      await setPapers(papers);
      return false; // removed
    }
    // Restore from cache if previously removed, otherwise create new
    const cached = removedCache.get(info.detailUrl);
    if (cached) {
      removedCache.delete(info.detailUrl);
      papers.push(cached);
    } else {
      papers.push({
        id: urlId(info.detailUrl),
        ...info,
        author: "",
        pdfLink: "",
        keywords: "",
        level: "Wait",
      });
    }
    await setPapers(papers);
    return true; // added
  }

  async function addAllOnPage(useWebVPN) {
    if (contextInvalid) return { ok: false, error: "context_invalid" };
    const links = getTitleLinks();
    if (links.length === 0) return { ok: false, error: "no_links" };

    const papers = await getPapers();
    const existing = new Set(papers.map((p) => p.detailUrl));
    let added = 0;

    // Iterate in DOM order to maintain page sequence
    Array.from(links).forEach((link) => {
      const url = convertToWebVPNLink(link.href, useWebVPN);
      if (existing.has(url)) return;
      const info = extractFromRow(link);
      info.detailUrl = url;
      papers.push({
        id: urlId(url),
        ...info,
        author: "",
        pdfLink: "",
        keywords: "",
        level: "Wait",
      });
      existing.add(url);
      added++;
    });

    await setPapers(papers);
    return { ok: true, added, total: links.length };
  }

  // ── Button Injection ──
  async function injectButtons() {
    if (contextInvalid) return;
    const links = getTitleLinks();
    if (links.length === 0) return;

    const papers = await getPapers();
    const collected = new Set(papers.map((p) => p.detailUrl));

    links.forEach((link) => {
      // Check if button already exists (next sibling or within parent)
      if (link.nextElementSibling?.classList.contains("cnki-h-btn")) return;
      const parent = link.parentNode;
      if (parent?.querySelector(".cnki-h-btn")) return;

      const btn = document.createElement("button");
      btn.className = "cnki-h-btn";
      const isCollected = collected.has(link.href);
      btn.classList.toggle("collected", isCollected);
      btn.textContent = isCollected ? "\u2713" : "+";
      btn.title = isCollected ? "已收藏，点击取消" : "收藏到下载列表";

      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const info = extractFromRow(link);
          const added = await togglePaper(info);
          if (contextInvalid) return;
          btn.classList.toggle("collected", added);
          btn.textContent = added ? "\u2713" : "+";
          btn.title = added ? "已收藏，点击取消" : "收藏到下载列表";
        } catch (err) {
          if (isContextInvalidatedError(err)) {
            markContextInvalid(err);
            return;
          }
          throw err;
        }
      });

      // Insert after the link
      if (link.nextSibling) {
        parent.insertBefore(btn, link.nextSibling);
      } else {
        parent.appendChild(btn);
      }
    });
  }

  function syncButtons(papers) {
    const collected = new Set(papers.map((p) => p.detailUrl));
    document.querySelectorAll(".cnki-h-btn").forEach((btn) => {
      const link = btn.previousElementSibling;
      if (!link?.href) return;
      const is = collected.has(link.href);
      btn.classList.toggle("collected", is);
      btn.textContent = is ? "\u2713" : "+";
    });
  }

  // ── Init ──
  // Detect if this is a CNKI page (direct or via WebVPN)
  function isCnkiPage() {
    return (
      location.hostname.includes("cnki") ||
      getTitleLinks().length > 0 ||
      !!document.querySelector(".result-table-list, #gridTable")
    );
  }

  function activate() {
    if (window.__cnkiHelperActivated) return;
    window.__cnkiHelperActivated = true;
    document.head.appendChild(css);

    let debounce;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(injectButtons, 300);
    }).observe(document.body, { childList: true, subtree: true });

    injectButtons().catch((err) => {
      if (isContextInvalidatedError(err)) markContextInvalid(err);
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (contextInvalid) return;
      if (changes.cnkiPapers) syncButtons(changes.cnkiPapers.newValue || []);
    });
  }

  if (isCnkiPage()) {
    activate();
  } else {
    // For WebVPN: recheck after dynamic content loads
    setTimeout(() => {
      if (isCnkiPage()) activate();
    }, 2000);
  }

  // ── Message Handlers ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (contextInvalid) {
      sendResponse({ ok: false, error: "context_invalid" });
      return;
    }
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "ADD_ALL_PAGE") {
      addAllOnPage(msg.useWebVPN)
        .then(sendResponse)
        .catch((err) => {
          if (isContextInvalidatedError(err)) {
            markContextInvalid(err);
            sendResponse({ ok: false, error: "context_invalid" });
            return;
          }
          sendResponse({ ok: false, error: err?.message || "unknown_error" });
        });
      return true;
    }
  });
})();
