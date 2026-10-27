const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { INITIAL_PRODUCTS, INITIAL_PAGES } = require("./seed");

const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "store.db");
const db = new DatabaseSync(dbPath);

async function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  const res = stmt.run(...params);
  return {
    lastID: Number(res.lastInsertRowid || 0),
    changes: Number(res.changes || 0)
  };
}

async function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  const row = stmt.get(...params);
  return row ? { ...row } : null;
}

async function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  return (rows || []).map((r) => ({ ...r }));
}

function hashPassword(password, salt = "DLUZ_STORE_SALT_2026") {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

async function initDatabase() {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      sku TEXT DEFAULT '',
      category TEXT DEFAULT 'mobilador',
      badge TEXT DEFAULT '',
      theme_color TEXT DEFAULT '#39FF14',
      icon TEXT DEFAULT 'gamepad',
      regular_price REAL NOT NULL DEFAULT 29.90,
      sale_price REAL NOT NULL DEFAULT 19.90,
      price REAL NOT NULL DEFAULT 19.90,
      status TEXT DEFAULT 'publish',
      featured INTEGER DEFAULT 0,
      license_type TEXT DEFAULT 'licensed',
      short_description TEXT DEFAULT '',
      description TEXT DEFAULT '',
      features_json TEXT DEFAULT '[]',
      downloads_json TEXT DEFAULT '[]',
      image_url TEXT DEFAULT '',
      sales_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_key TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      currency TEXT DEFAULT 'BRL',
      total REAL NOT NULL DEFAULT 0,
      discount_total REAL DEFAULT 0,
      coupon_code TEXT DEFAULT '',
      first_name TEXT NOT NULL,
      last_name TEXT DEFAULT '',
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      cpf TEXT DEFAULT '',
      payment_method TEXT DEFAULT 'mercadopago_pix',
      payment_method_title TEXT DEFAULT 'Pix Mercado Pago',
      mp_payment_id TEXT DEFAULT '',
      mp_preference_id TEXT DEFAULT '',
      pix_qr_code TEXT DEFAULT '',
      pix_qr_base64 TEXT DEFAULT '',
      checkout_url TEXT DEFAULT '',
      license_key TEXT DEFAULT '',
      whatsapp_sent INTEGER DEFAULT 0,
      email_sent INTEGER DEFAULT 0,
      items_json TEXT NOT NULL DEFAULT '[]',
      customer_ip TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS order_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      note TEXT NOT NULL,
      customer_note INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      discount_percent REAL DEFAULT 10,
      discount_fixed REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      usage_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      alt_slug TEXT DEFAULT '',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Garantir que os IDs de pedidos comecem em #3000 (após os pedidos #2901 da antiga loja)
  const seqRow = await dbGet("SELECT seq FROM sqlite_sequence WHERE name = 'orders'");
  if (!seqRow) {
    await dbRun("INSERT INTO sqlite_sequence (name, seq) VALUES ('orders', 2999)");
  }

  // Remover produtos descontinuados da loja solicitados pelo usuário
  const discontinuedSlugs = [
    "dluzstacks",
    "clube-dos-melhores-vip-passe-mensal",
    "toys-app-dluz-v4",
    "dluz-manager-abd",
    "dluz-macro-correr-automatico-v5"
  ];
  for (const slug of discontinuedSlugs) {
    await dbRun("DELETE FROM products WHERE slug = ?", [slug]);
  }

  // Popular os produtos oficiais se ainda não existirem ou atualizar image_url
  for (const p of INITIAL_PRODUCTS) {
    const existing = await dbGet("SELECT id, image_url FROM products WHERE id = ?", [p.id]);
    if (!existing) {
      await dbRun(
        `INSERT INTO products (
          id, name, slug, sku, category, badge, theme_color, icon,
          regular_price, sale_price, price, status, featured, license_type,
          short_description, description, features_json, downloads_json, image_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.id,
          p.name,
          p.slug,
          p.sku || "",
          p.category || "mobilador",
          p.badge || "",
          p.theme_color || "#39FF14",
          p.icon || "gamepad",
          p.regular_price,
          p.sale_price,
          p.price,
          p.status || "publish",
          p.featured ? 1 : 0,
          p.license_type || "licensed",
          p.short_description || "",
          p.description || "",
          JSON.stringify(p.features || []),
          JSON.stringify(p.downloads || []),
          p.image_url || ""
        ]
      );
    } else {
      // Sempre manter dados essenciais sincronizados com o catalogo
      await dbRun(
        `UPDATE products SET 
          name = ?,
          short_description = ?,
          description = ?,
          image_url = ?,
          badge = ?,
          theme_color = ?,
          features_json = ?,
          downloads_json = ?
        WHERE id = ?`,
        [
          p.name,
          p.short_description || "",
          p.description || "",
          p.image_url || existing.image_url || "",
          p.badge || "",
          p.theme_color || "#39FF14",
          JSON.stringify(p.features || []),
          JSON.stringify(p.downloads || []),
          p.id
        ]
      );
    }
  }

  // Popular páginas institucionais
  for (const page of INITIAL_PAGES) {
    const existingPage = await dbGet("SELECT id FROM pages WHERE id = ?", [page.id]);
    if (!existingPage) {
      await dbRun(
        "INSERT INTO pages (id, slug, alt_slug, title, content) VALUES (?, ?, ?, ?, ?)",
        [page.id, page.slug, page.alt_slug || "", page.title, page.content]
      );
    }
  }

  // Cupons iniciais (Removido MELHOR10 a pedido do usuário)
  await dbRun("DELETE FROM coupons WHERE code = 'MELHOR10'");
  const defaultCoupons = [
    { code: "DLUZ10", percent: 10, fixed: 0 },
    { code: "VIP15", percent: 15, fixed: 0 }
  ];
  for (const c of defaultCoupons) {
    await dbRun(
      "INSERT OR IGNORE INTO coupons (code, discount_percent, discount_fixed, active) VALUES (?, ?, ?, 1)",
      [c.code, c.percent, c.fixed]
    );
  }

  // Configurações padrão
  const defaultSettings = {
    store_name: "Loja Oficial DLuz Games",
    store_subtitle: "Softwares Gamer PRO, Emuladores 120 FPS & Ferramentas com IA",
    mp_access_token: process.env.MP_ACCESS_TOKEN || "APP_USR-2399224026397919-032909-b3b728ac46eb4efa82acf05b732b60eb-147323035",
    mp_public_key: process.env.MP_PUBLIC_KEY || "APP_USR-52168119-160d-4d6c-9dd8-5e2cbfb392f4",
    mp_webhook_secret: process.env.MP_WEBHOOK_SECRET || "12b75ae19eda99e3cb06c78eff0da7e7d7c99d1a8cf6387884302a818ef76f2c",
    pix_fallback_key: process.env.PIX_FALLBACK_KEY || "duilioluzefo@gmail.com",
    pix_fallback_name: "MANOEL DUILIO DA LUZ SOUSA",
    pix_fallback_city: "PARAISO DO TOCANTINS",
    license_server_url: "https://lf7k749dplzo1qaa2au0izl1.dluz.com.br/api/webhook/woocommerce",
    evolution_api_url: "https://evolution.dluz.com.br/message/sendText/frya",
    evolution_api_key: "bvNSCH2VoX8ByDb000mJjMiKmmFJEkFj",
    whatsapp_support: "5563981199852",
    discord_invite: "https://discord.gg/r2tUSVnkn2",
    admin_user: "efovideos@gmail.com",
    admin_password_hash: hashPassword(process.env.ADMIN_PASSWORD || "dluz_admin_master_2026_pro")
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    await dbRun("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [k, String(v)]);
  }

  // Garantir que o número oficial do WhatsApp do DLuz esteja atualizado
  const currentWa = await getSetting("whatsapp_support", "");
  if (!currentWa || currentWa === "5563992000000") {
    await setSetting("whatsapp_support", "5563981199852");
  }
}

async function getSetting(key, fallback = "") {
  const row = await dbGet("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}

async function getAllSettings() {
  const rows = await dbAll("SELECT key, value FROM settings");
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

async function setSetting(key, value) {
  await dbRun(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
}

function formatProductRow(row) {
  if (!row) return null;
  let features = [];
  let downloads = [];
  try { features = JSON.parse(row.features_json || "[]"); } catch {}
  try { downloads = JSON.parse(row.downloads_json || "[]"); } catch {}
  return {
    ...row,
    regular_price: Number(row.regular_price),
    sale_price: Number(row.sale_price),
    price: Number(row.price),
    featured: Boolean(row.featured),
    features,
    downloads
  };
}

function formatOrderRow(row) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch {}
  return {
    ...row,
    total: Number(row.total),
    discount_total: Number(row.discount_total || 0),
    items
  };
}

module.exports = {
  db,
  dbRun,
  dbGet,
  dbAll,
  initDatabase,
  getSetting,
  getAllSettings,
  setSetting,
  hashPassword,
  formatProductRow,
  formatOrderRow
};
