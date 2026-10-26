const express = require("express");
const router = express.Router();
const { dbAll, dbGet, dbRun, formatProductRow, formatOrderRow } = require("../db/database");

const WC_CK = process.env.WC_CONSUMER_KEY || "ck_71f87127a0096a0fdded44bb780724b27736b0f3";
const WC_CS = process.env.WC_CONSUMER_SECRET || "cs_b940c43384c5b7f1b1f5680da0dc03f0e1d01ce2";
const WP_USER = process.env.WP_USER || "efovideos@gmail.com";
const WP_PASS = process.env.WP_APP_PASSWORD || "HONM RLvZ q9v8 C9rw 8Kp5 Z1l7";

function authenticateWc(req, res, next) {
  const qKey = req.query.consumer_key;
  const qSecret = req.query.consumer_secret;
  if (qKey === WC_CK && qSecret === WC_CS) {
    return next();
  }

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [u, p] = decoded.split(":");
    if ((u === WC_CK && p === WC_CS) || (u === WP_USER && p === WP_PASS)) {
      return next();
    }
  }

  return res.status(401).json({
    code: "woocommerce_rest_cannot_view",
    message: "Credenciais da API WooCommerce inválidas ou ausentes.",
    data: { status: 401 }
  });
}

function toWcProduct(p, baseUrl) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    permalink: `${baseUrl}/produto/${p.slug}/`,
    type: "simple",
    status: p.status || "publish",
    featured: Boolean(p.featured),
    catalog_visibility: "visible",
    description: p.description || "",
    short_description: p.short_description || "",
    sku: p.sku || "",
    price: String(Number(p.price).toFixed(2)),
    regular_price: String(Number(p.regular_price).toFixed(2)),
    sale_price: String(Number(p.sale_price).toFixed(2)),
    on_sale: Number(p.sale_price) < Number(p.regular_price),
    purchasable: true,
    total_sales: p.sales_count || 0,
    virtual: true,
    downloadable: true,
    downloads: p.downloads || []
  };
}

function toWcOrder(o) {
  return {
    id: o.id,
    parent_id: 0,
    status: o.status,
    currency: o.currency || "BRL",
    total: String(Number(o.total).toFixed(2)),
    discount_total: String(Number(o.discount_total || 0).toFixed(2)),
    date_created: o.created_at,
    date_modified: o.updated_at,
    date_paid: o.paid_at,
    order_key: o.order_key,
    payment_method: o.payment_method,
    payment_method_title: o.payment_method_title,
    billing: {
      first_name: o.first_name,
      last_name: o.last_name || "",
      email: o.email,
      phone: o.phone
    },
    line_items: (o.items || []).map((i, idx) => ({
      id: idx + 1,
      name: i.name,
      product_id: i.id || i.product_id,
      quantity: i.quantity || 1,
      total: String(Number(i.price || o.total).toFixed(2))
    })),
    license_key: o.license_key || ""
  };
}

// GET /wp-json/wc/v3/products
router.get("/wc/v3/products", authenticateWc, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const rows = await dbAll("SELECT * FROM products ORDER BY featured DESC, id DESC");
    const list = rows.map(formatProductRow).map((p) => toWcProduct(p, baseUrl));
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /wp-json/wc/v3/products/:id
router.get("/wc/v3/products/:id", authenticateWc, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const row = await dbGet("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ message: "Produto não encontrado" });
    res.json(toWcProduct(formatProductRow(row), baseUrl));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /wp-json/wc/v3/products
router.post("/wc/v3/products", authenticateWc, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const b = req.body || {};
    const name = b.name || "Novo Software DLuz";
    const slug =
      b.slug ||
      name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const regPrice = parseFloat(b.regular_price || b.price || "29.90");
    const salePrice = parseFloat(b.sale_price || b.price || String(regPrice));

    const result = await dbRun(
      `INSERT INTO products (name, slug, sku, regular_price, sale_price, price, status, short_description, description, downloads_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        slug,
        b.sku || "",
        regPrice,
        salePrice,
        salePrice,
        b.status || "publish",
        b.short_description || "",
        b.description || "",
        JSON.stringify(b.downloads || [])
      ]
    );

    const created = await dbGet("SELECT * FROM products WHERE id = ?", [result.lastID]);
    res.status(201).json(toWcProduct(formatProductRow(created), baseUrl));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /wp-json/wc/v3/products/:id
router.put("/wc/v3/products/:id", authenticateWc, async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const id = req.params.id;
    const existing = await dbGet("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ message: "Produto não encontrado" });

    const cur = formatProductRow(existing);
    const b = req.body || {};

    const name = b.name !== undefined ? b.name : cur.name;
    const regPrice = b.regular_price !== undefined ? parseFloat(b.regular_price) : cur.regular_price;
    const salePrice =
      b.sale_price !== undefined
        ? parseFloat(b.sale_price)
        : b.price !== undefined
        ? parseFloat(b.price)
        : cur.sale_price;
    const price = salePrice || regPrice;
    const status = b.status !== undefined ? b.status : cur.status;
    const shortDesc = b.short_description !== undefined ? b.short_description : cur.short_description;
    const desc = b.description !== undefined ? b.description : cur.description;
    const downloads = b.downloads !== undefined ? b.downloads : cur.downloads;

    await dbRun(
      `UPDATE products
       SET name = ?, regular_price = ?, sale_price = ?, price = ?, status = ?,
           short_description = ?, description = ?, downloads_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, regPrice, salePrice, price, status, shortDesc, desc, JSON.stringify(downloads), id]
    );

    const updated = await dbGet("SELECT * FROM products WHERE id = ?", [id]);
    res.json(toWcProduct(formatProductRow(updated), baseUrl));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /wp-json/wc/v3/orders
router.get("/wc/v3/orders", authenticateWc, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    let rows;
    if (search) {
      const like = `%${search}%`;
      rows = await dbAll(
        `SELECT * FROM orders
         WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR CAST(id AS TEXT) = ?
         ORDER BY id DESC LIMIT 25`,
        [like, like, like, like, search]
      );
    } else {
      rows = await dbAll("SELECT * FROM orders ORDER BY id DESC LIMIT 25");
    }
    res.json(rows.map(formatOrderRow).map(toWcOrder));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /wp-json/wc/v3/orders/:id
router.get("/wc/v3/orders/:id", authenticateWc, async (req, res) => {
  try {
    const row = await dbGet("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!row) return res.status(404).json({ message: "Pedido não encontrado" });
    res.json(toWcOrder(formatOrderRow(row)));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /wp-json/wc/v3/orders/:id/notes
router.post("/wc/v3/orders/:id/notes", authenticateWc, async (req, res) => {
  try {
    const orderId = req.params.id;
    const note = req.body?.note || "";
    const customerNote = req.body?.customer_note ? 1 : 0;
    const r = await dbRun(
      "INSERT INTO order_notes (order_id, note, customer_note) VALUES (?, ?, ?)",
      [orderId, note, customerNote]
    );
    res.status(201).json({
      id: r.lastID,
      order_id: Number(orderId),
      note,
      customer_note: Boolean(customerNote),
      date_created: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /wp-json/wc/v3/webhooks
router.get("/wc/v3/webhooks", authenticateWc, async (req, res) => {
  res.json([
    {
      id: 1,
      name: "DLuz License Server Oficial (Automático)",
      status: "active",
      topic: "order.completed",
      delivery_url: "https://lf7k749dplzo1qaa2au0izl1.dluz.com.br/api/webhook/woocommerce"
    }
  ]);
});

module.exports = router;
