/* Meesho Label Crop - runs fully in the browser (pdf.js for reading, pdf-lib for writing). */
const { PDFDocument, StandardFonts, rgb } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);
const files = []; // {id, name, buf, orders[]}
let nextId = 1;

/* ------------------------------------------------------------------ parsing */

const COURIER_CANON = [
  [/^valmo\s*plus/i, 'ValmoPlus'], [/^valmo\s*express/i, 'ValmoExpress'], [/^valmo/i, 'Valmo'],
  [/^delhivery/i, 'Delhivery'], [/^shadowfax/i, 'Shadowfax'], [/^xpress\s*bees/i, 'Xpress Bees'],
  [/^ecom\s*express/i, 'Ecom Express'], [/^ekart/i, 'Ekart'], [/^bluedart|^blue\s*dart/i, 'Blue Dart'],
];
function canonCourier(raw) {
  for (const [re, name] of COURIER_CANON) if (re.test(raw)) return name;
  return raw || 'Unknown';
}

async function parseFile(f) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(f.buf.slice(0)) }).promise;
  const orders = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const view = page.view; // crop box in PDF user space [x0,y0,x1,y1]
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str.trim()).map((i) => ({
      s: i.str.trim(), x: i.transform[4], y: i.transform[5],
      rx: i.transform[4] - view[0], ry: view[3] - i.transform[5],
    }));
    const all = items.map((i) => i.s).join(' ');
    if (!/Customer Address/.test(all) || !/TAX INVOICE/.test(all)) continue; // skips summary pages etc.

    const ci = items.findIndex((i) => i.s === 'Customer Address');
    const customer = items[ci + 1] ? items[ci + 1].s : '';

    const cc = items.filter((i) => i.rx >= 240 && i.ry >= 40 && i.ry <= 110)
      .sort((a, b) => a.ry - b.ry || a.rx - b.rx);
    const known = cc.find((i) => COURIER_CANON.some(([re]) => re.test(i.s)));
    const other = cc.find((i) => !/^(pickup|drop|\d+\/\d+|[A-Z])$/i.test(i.s));
    const courierRaw = known ? known.s : other ? other.s : '';
    const payItem = items.find((i) => i.ry < 40 && /^(prepaid|cod)/i.test(i.s));
    const payment = payItem ? (/^cod/i.test(payItem.s) ? 'COD' : 'Prepaid') : '';

    // product table
    const hSku = items.find((i) => i.s === 'SKU' && i.rx < 40);
    const ti = items.find((i) => i.s === 'TAX INVOICE');
    const products = [];
    if (hSku) {
      const hdr = {};
      for (const i of items) {
        if (Math.abs(i.ry - hSku.ry) > 3) continue;
        if (i.s === 'SKU') hdr.sku = i.rx;
        else if (i.s === 'Size') hdr.size = i.rx;
        else if (i.s === 'Qty') hdr.qty = i.rx;
        else if (i.s === 'Color') hdr.color = i.rx;
        else if (/^Order No/.test(i.s)) hdr.order = i.rx;
      }
      const yEnd = ti ? ti.ry - 5 : hSku.ry + 40;
      const vals = items.filter((i) => i.ry > hSku.ry + 4 && i.ry < yEnd).sort((a, b) => a.ry - b.ry || a.rx - b.rx);
      const rows = [];
      for (const v of vals) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(last.ry - v.ry) < 3) last.items.push(v); else rows.push({ ry: v.ry, items: [v] });
      }
      const colOf = (x) => {
        let best = 'sku', bx = -1e9;
        for (const [k, hx] of Object.entries(hdr)) if (hx <= x + 12 && hx > bx) { best = k; bx = hx; }
        return best;
      };
      for (const r of rows) {
        const rec = { sku: '', size: '', qty: '', color: '', order: '' };
        for (const v of r.items.sort((a, b) => a.rx - b.rx)) {
          const k = colOf(v.rx);
          rec[k] = (rec[k] ? rec[k] + ' ' : '') + v.s;
        }
        if (rec.qty) products.push(rec);
        else if (products.length) { const pr = products[products.length - 1]; pr.sku += rec.sku; pr.size += rec.size ? ' ' + rec.size : ''; }
      }
    }
    if (!products.length) products.push({ sku: '?', size: '', qty: '1', color: '', order: '' });

    // sold by
    let soldBy = '';
    const si = items.findIndex((i) => /^Sold by/i.test(i.s));
    if (si >= 0) {
      soldBy = items[si].s.replace(/^Sold by\s*:?\s*/i, '').trim();
      if (!soldBy && items[si + 1]) soldBy = items[si + 1].s;
    }

    const pd = items.find((i) => i.s === 'Product Details');
    const hasDate = items.some((i) => /\d\d-\d\d-\d{4}\s+\d\d:\d\d\s*[AP]M/i.test(i.s));
    const maxRy = Math.max(...items.map((i) => i.ry));

    orders.push({
      file: f.id, page: p - 1, customer, courierRaw, payment, soldBy, products,
      qty: products.reduce((a, r) => a + (parseInt(r.qty, 10) || 1), 0),
      sku: products[0].sku, size: products[0].size, color: products[0].color, orderNo: products[0].order,
      view, ti: ti ? ti.ry : 360, maxRy, pdRy: pd ? pd.ry : 305, pdRx: pd ? pd.rx : 20, hasDate,
    });
  }
  return orders;
}

/* ------------------------------------------------------------------ helpers */

const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const opt = (id) => $(id).checked;
const latin = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function courierOf(o, valmoSame) {
  let c = canonCourier(o.courierRaw);
  if (valmoSame && (c === 'ValmoPlus' || c === 'ValmoExpress')) c = 'Valmo';
  return c;
}

function nowStamp() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${z(d.getDate())}-${z(d.getMonth() + 1)}-${d.getFullYear()} ${z(h)}:${z(d.getMinutes())} ${ap}`;
}

function sortOrders(orders, o) {
  const list = orders.map((x, i) => ({ x, i }));
  list.sort((a, b) => {
    let r = 0;
    if (o.sortSold) r = natural(a.x.soldBy, b.x.soldBy);
    if (!r && o.sortCourier) r = natural(a.x._courier, b.x._courier);
    if (!r && (o.sortCourier || o.sortSold)) r = natural(a.x.sku, b.x.sku) || natural(a.x.size, b.x.size);
    return r || a.i - b.i;
  });
  let res = list.map((e) => e.x);
  if (o.multiBottom) res = [...res.filter((x) => x.qty <= 1 && x.products.length <= 1), ...res.filter((x) => x.qty > 1 || x.products.length > 1)];
  return res;
}

function groupCount(orders, keyFn, labelFn) {
  const m = new Map();
  for (const o of orders) { const k = keyFn(o); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => natural(a[0], b[0])).map(([k, n]) => [n, labelFn ? labelFn(k) : k]);
}

function skuRows(orders) {
  const m = new Map();
  for (const o of orders) for (const p of o.products) {
    const k = [p.sku, p.size, p.color].join('\u0001');
    const e = m.get(k) || { ord: 0, qty: 0, size: p.size, color: p.color, sku: p.sku };
    e.ord += 1; e.qty += parseInt(p.qty, 10) || 1; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => natural(a.sku, b.sku) || natural(a.size, b.size) || natural(a.color, b.color));
}

/* ------------------------------------------------------------------ PDF output */

function drawTable(ctx, cols, rows, headerRow) {
  const rowH = 14, fs = 8.5;
  const all = headerRow ? [headerRow, ...rows] : rows;
  all.forEach((row, ri) => {
    if (ctx.y - rowH < 40) { ctx.page = ctx.doc.addPage([595, 842]); ctx.y = 802; }
    let x = ctx.x;
    cols.forEach((w, ci) => {
      ctx.page.drawRectangle({ x, y: ctx.y - rowH, width: w, height: rowH, borderColor: rgb(0, 0, 0), borderWidth: 0.6 });
      const bold = headerRow && ri === 0;
      let t = latin(row[ci]);
      const f = bold ? ctx.bold : ctx.font;
      while (t.length > 1 && f.widthOfTextAtSize(t, fs) > w - 6) t = t.slice(0, -1);
      ctx.page.drawText(t, { x: x + 3, y: ctx.y - rowH + 4, size: fs, font: f });
      x += w;
    });
    ctx.y -= rowH;
  });
  ctx.y -= 12;
}

function addSummaryPage(doc, fonts, title, orders, full) {
  const ctx = { doc, font: fonts.font, bold: fonts.bold, page: doc.addPage([595, 842]), x: 40, y: 802 };
  ctx.page.drawText(latin(title), { x: 40, y: ctx.y - 10, size: 10, font: fonts.bold });
  ctx.y -= 20;
  const rows = skuRows(orders).map((r) => [String(r.ord), String(r.qty), r.size, r.color, r.sku]);
  drawTable(ctx, [34, 34, 70, 80, 300], rows, ['ORD', 'QTY', 'Size', 'Color', 'SKU']);
  drawTable(ctx, [518], [[`Total package: ${orders.length}`]]);
  if (full) {
    drawTable(ctx, [60, 458], groupCount(orders, (o) => o._courier).map(([n, k]) => [String(n), k]), ['Package', 'Courier Partner']);
    drawTable(ctx, [60, 458], groupCount(orders, (o) => o.soldBy || '-').map(([n, k]) => [String(n), k]), ['Package', 'Sold By']);
  }
}

function addRepeatCustomerPage(doc, fonts, orders) {
  const m = new Map();
  for (const o of orders) {
    const k = o.customer.toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  const rows = [];
  for (const list of m.values()) if (list.length > 1) for (const o of list) rows.push([o.customer, o.sku, o.size, String(o.qty), o.orderNo]);
  if (!rows.length) return;
  const ctx = { doc, font: fonts.font, bold: fonts.bold, page: doc.addPage([595, 842]), x: 40, y: 802 };
  ctx.page.drawText('Repeat customer orders', { x: 40, y: ctx.y - 10, size: 10, font: fonts.bold });
  ctx.y -= 20;
  drawTable(ctx, [150, 120, 50, 30, 168], rows, ['Customer', 'SKU', 'Size', 'Qty', 'Order No.']);
}

function qrMatrix(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => qr.isDark(r, c) };
}

async function buildPdf(orders, o, srcCache) {
  const doc = await PDFDocument.create();
  const fonts = { font: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const stamp = nowStamp();
  const qr = o.storeQr && o.storeLink ? qrMatrix(o.storeLink) : null;

  const cols = o.a4 ? (o.keepInvoice ? 1 : 2) : 1;
  const perSheet = o.a4 ? (o.keepInvoice ? 2 : 4) : 1;
  let slot = 0, sheet = null, chunkStart = 0;

  for (let idx = 0; idx < orders.length; idx++) {
    const ord = orders[idx];
    const src = await srcCache(ord.file);
    const spage = src.getPage(ord.page);
    const v = ord.view;

    let left = v[0] + 11, right = v[0] + 584.5, top = v[3] - 11;
    let bottom;
    if (o.keepInvoice && !o.cropWs) { left = v[0]; right = v[2]; top = v[3]; bottom = v[1]; }
    else if (o.keepInvoice) bottom = Math.max(v[1], v[3] - (ord.maxRy + 7.5));
    else bottom = v[3] - (ord.ti - 14);
    right = Math.min(right, v[2]);
    const w = right - left, h = top - bottom;
    const emb = await doc.embedPage(spage, { left, bottom, right, top });

    let page, ox = 0, oy = 0, s = 1;
    if (!o.a4) {
      page = doc.addPage([w, h]);
    } else {
      if (slot === 0) {
        sheet = doc.addPage([595, 842]);
        sheet.drawLine({ start: { x: 0, y: 421 }, end: { x: 595, y: 421 }, thickness: 0.4, color: rgb(0.7, 0.7, 0.7), dashArray: [4, 3] });
        if (cols === 2) sheet.drawLine({ start: { x: 297.5, y: 0 }, end: { x: 297.5, y: 842 }, thickness: 0.4, color: rgb(0.7, 0.7, 0.7), dashArray: [4, 3] });
      }
      page = sheet;
      const cw = 595 / cols, ch = 421, m = 12;
      const col = cols === 2 ? slot % 2 : 0, row = cols === 2 ? Math.floor(slot / 2) : slot;
      s = Math.min((cw - 2 * m) / w, (ch - 2 * m) / h);
      ox = col * cw + (cw - w * s) / 2;
      oy = 842 - (row + 1) * ch + (ch - h * s) / 2;
      slot = (slot + 1) % perSheet;
    }
    page.drawPage(emb, { x: ox, y: oy, xScale: s, yScale: s });

    const tx = (rx) => ox + s * (rx - (left - v[0]));
    const ty = (ry) => oy + s * (h - (ry - (v[3] - top)));
    if (o.dateTime && !ord.hasDate) page.drawText(stamp, { x: tx(ord.pdRx + 96), y: ty(ord.pdRy), size: 9 * s, font: fonts.font });
    if (o.pageNo) {
      const t = String(idx + 1), sz = 10 * s;
      page.drawText(t, { x: tx(575) - fonts.bold.widthOfTextAtSize(t, sz), y: ty(ord.pdRy), size: sz, font: fonts.bold });
    }
    if (qr) {
      const size = 36 * s, x0 = tx(212), y0 = ty(284), mod = size / qr.n;
      page.drawRectangle({ x: x0 - 2 * s, y: y0 - 2 * s, width: size + 4 * s, height: size + 4 * s, color: rgb(1, 1, 1) });
      for (let r = 0; r < qr.n; r++) for (let c = 0; c < qr.n; c++) if (qr.dark(r, c))
        page.drawRectangle({ x: x0 + c * mod, y: y0 + size - (r + 1) * mod, width: mod, height: mod, color: rgb(0, 0, 0) });
    }

    if (o.picklist && ((idx + 1) % o.picklistN === 0) && idx + 1 < orders.length) {
      addSummaryPage(doc, fonts, `Picklist - orders ${chunkStart + 1} to ${idx + 1}`, orders.slice(chunkStart, idx + 1), false);
      chunkStart = idx + 1; slot = 0;
    }
  }
  if (o.picklist && chunkStart < orders.length && chunkStart > 0)
    addSummaryPage(doc, fonts, `Picklist - orders ${chunkStart + 1} to ${orders.length}`, orders.slice(chunkStart), false);
  if (o.summaryPage)
    addSummaryPage(doc, fonts, `This Meesho label is cropped by Label Crop on ${stamp.slice(0, 10)}`, orders, true);
  if (o.repeatCust) addRepeatCustomerPage(doc, fonts, orders);
  return doc.save();
}

/* ------------------------------------------------------------------ UI */

function readOptions() {
  return {
    sortCourier: opt('sortCourier'), valmoSame: opt('valmoSame'), sortSold: opt('sortSold'), multiBottom: opt('multiBottom'),
    keepInvoice: opt('keepInvoice'), cropWs: opt('cropWs'), dateTime: opt('dateTime'), pageNo: opt('pageNo'),
    storeQr: opt('storeQr'), storeLink: $('storeLink').value.trim(), merge: opt('merge'), a4: opt('a4'),
    summaryPage: opt('summaryPage'), repeatCust: opt('repeatCust'), picklist: opt('picklist'),
    picklistN: Math.max(1, parseInt($('picklistN').value, 10) || 10),
  };
}

function renderFiles() {
  $('files').innerHTML = '';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${f.name} - <b>${f.orders ? f.orders.length + ' labels' : 'reading...'}</b></span>`;
    const b = document.createElement('button'); b.textContent = '\u2715'; b.title = 'Remove';
    b.onclick = () => { files.splice(files.indexOf(f), 1); renderFiles(); };
    li.appendChild(b); $('files').appendChild(li);
  }
  const orders = files.flatMap((f) => f.orders || []);
  $('go').disabled = !orders.length;
  const sm = $('summary');
  if (!orders.length) { sm.hidden = true; return; }
  sm.hidden = false;
  const o = readOptions();
  orders.forEach((x) => (x._courier = courierOf(x, o.valmoSame)));
  const rows = skuRows(orders).map((r) => `<tr><td>${r.ord}</td><td>${r.qty}</td><td>${r.size}</td><td>${r.color}</td><td>${r.sku}</td></tr>`).join('');
  const cour = groupCount(orders, (x) => x._courier).map(([n, k]) => `<tr><td>${n}</td><td>${k}</td></tr>`).join('');
  sm.innerHTML = `<b>Total labels: ${orders.length}</b><table><tr><th>ORD</th><th>QTY</th><th>Size</th><th>Color</th><th>SKU</th></tr>${rows}</table>
    <table><tr><th>Packages</th><th>Courier</th></tr>${cour}</table>`;
}

async function addFiles(list) {
  for (const file of list) {
    if (!/\.pdf$/i.test(file.name)) continue;
    const f = { id: nextId++, name: file.name, buf: await file.arrayBuffer(), orders: null };
    files.push(f); renderFiles();
    try { f.orders = await parseFile(f); } catch (e) { console.error(e); f.orders = []; $('status').textContent = 'Could not read ' + file.name; $('status').className = 'err'; }
    renderFiles();
  }
}

$('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
$('storeQr').onchange = () => { $('storeLink').hidden = !opt('storeQr'); };
$('valmoSame').onchange = renderFiles;
$('keepInvoice').onchange = () => { $('cropWs').disabled = $('cropNo').disabled = !opt('keepInvoice'); };

$('go').onclick = async () => {
  const o = readOptions();
  const st = $('status'); st.className = ''; st.textContent = 'Working...';
  $('results').innerHTML = ''; $('preview').hidden = true;
  try {
    if (o.storeQr && !o.storeLink) throw new Error('Enter the store link for the QR code.');
    const cache = new Map();
    const srcCache = async (id) => {
      if (!cache.has(id)) cache.set(id, await PDFDocument.load(files.find((f) => f.id === id).buf.slice(0), { ignoreEncryption: true }));
      return cache.get(id);
    };
    const groups = o.merge ? [{ name: 'labels_merged.pdf', orders: files.flatMap((f) => f.orders) }]
      : files.map((f) => ({ name: f.name.replace(/\.pdf$/i, '') + '_cropped.pdf', orders: f.orders }));
    let first = true;
    for (const g of groups) {
      if (!g.orders.length) continue;
      g.orders.forEach((x) => (x._courier = courierOf(x, o.valmoSame)));
      const bytes = await buildPdf(sortOrders(g.orders, o), o, srcCache);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = g.name; a.textContent = 'Download ' + g.name;
      $('results').appendChild(a);
      const o2 = document.createElement('a'); o2.href = url; o2.target = '_blank'; o2.textContent = 'Open ' + g.name; o2.style.background = '#0b6aa6';
      $('results').appendChild(o2);
      // inline preview only on desktop (mobile browsers can't show PDFs in an iframe)
      if (first && !matchMedia('(pointer:coarse)').matches) { $('preview').src = url; $('preview').hidden = false; }
      first = false;
    }
    st.textContent = 'Done.';
  } catch (e) { console.error(e); st.className = 'err'; st.textContent = 'Error: ' + e.message; }
};

renderFiles();
