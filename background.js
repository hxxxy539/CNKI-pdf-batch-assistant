/* Service Worker - handles networking, downloads, and side panel setup */

// Open side panel on extension icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

async function handleFetchText({ url, referrer }) {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    referrer: referrer || undefined,
  });
  return {
    ok: res.ok,
    status: res.status,
    text: await res.text(),
    finalUrl: res.url,
  };
}

async function handleSaveDownload({ url, filename }) {
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
  });
  return { ok: true, downloadId };
}

const pendingDownloadMetaMap = new Map();

function normalizeUrl(url) {
  return String(url || "")
    .trim()
    .replace(/#.*$/, "");
}

function normalizeYear(year) {
  const m = String(year || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function extractOrderId(url) {
  try {
    const u = new URL(String(url || ""));
    return u.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function normalizePathSegment(segment, fallback) {
  const cleaned = String(segment || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

function registerDownloadMeta({ url, year, journal, aliases }) {
  const keys = [url, ...(Array.isArray(aliases) ? aliases : [])]
    .map(normalizeUrl)
    .filter(Boolean);
  const uniqKeys = Array.from(new Set(keys));
  const y = normalizeYear(year);
  if (uniqKeys.length === 0 || !y)
    return { ok: false, error: "invalid_params" };

  const orderIds = Array.from(
    new Set(uniqKeys.map(extractOrderId).filter(Boolean)),
  );

  const meta = {
    year: y,
    journal: normalizePathSegment(journal, "unknown_journal"),
    orderIds,
    expiresAt: Date.now() + 30 * 60 * 1000,
    hitCount: 0,
  };

  uniqKeys.forEach((k) => pendingDownloadMetaMap.set(k, meta));
  return {
    ok: true,
    registeredKeys: uniqKeys.length,
    registeredOrderIds: orderIds.length,
  };
}

function findDownloadMeta(item) {
  const now = Date.now();
  for (const [k, v] of pendingDownloadMetaMap.entries()) {
    if (v.expiresAt <= now) pendingDownloadMetaMap.delete(k);
  }

  const consumeMeta = (meta) => {
    if (!meta) return null;
    meta.hitCount = (meta.hitCount || 0) + 1;
    if (meta.hitCount >= 3) {
      for (const [k, v] of pendingDownloadMetaMap.entries()) {
        if (v === meta) pendingDownloadMetaMap.delete(k);
      }
    }
    return meta;
  };

  const candidates = [
    normalizeUrl(item?.finalUrl),
    normalizeUrl(item?.url),
    normalizeUrl(item?.referrer),
  ].filter(Boolean);

  const candidateOrderIds = Array.from(
    new Set(candidates.map(extractOrderId).filter(Boolean)),
  );

  if (candidateOrderIds.length > 0) {
    for (const [, v] of pendingDownloadMetaMap.entries()) {
      if (!Array.isArray(v?.orderIds) || v.orderIds.length === 0) continue;
      if (v.orderIds.some((id) => candidateOrderIds.includes(id))) {
        return consumeMeta(v);
      }
    }
  }

  for (const c of candidates) {
    const hit = pendingDownloadMetaMap.get(c);
    if (hit?.year) {
      return consumeMeta(hit);
    }
  }

  for (const c of candidates) {
    for (const [k, v] of pendingDownloadMetaMap.entries()) {
      if (c.includes(k) || k.includes(c)) {
        return consumeMeta(v);
      }
    }
  }

  return null;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const meta = findDownloadMeta(item);
  if (!meta?.year) {
    suggest();
    return;
  }

  const raw = String(item.filename || "download.pdf");
  const base = raw.split(/[\\/]/).pop() || "download.pdf";
  const journal = normalizePathSegment(meta.journal, "unknown_journal");
  suggest({
    filename: `${journal}/${meta.year}/${base}`,
    conflictAction: "uniquify",
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  const handle = async () => {
    try {
      if (msg.type === "FETCH_TEXT") return await handleFetchText(msg);
      if (msg.type === "SAVE_DOWNLOAD") return await handleSaveDownload(msg);
      if (msg.type === "REGISTER_DOWNLOAD_META")
        return registerDownloadMeta(msg);
      return { ok: false, error: "unknown_type" };
    } catch (err) {
      return { ok: false, error: err?.message || "unknown_error" };
    }
  };

  handle().then(sendResponse);
  return true;
});
