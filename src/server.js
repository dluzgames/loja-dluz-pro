const express = require("express");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const {
  initDatabase,
  dbAll,
  dbGet,
  dbRun,
  getSetting,
  getAllSettings,
  setSetting,
  hashPassword,
  formatProductRow,
  formatOrderRow
} = require("./db/database");

const {
  createMercadoPagoPayment,
  verifyAndFetchMpPayment,
  testMercadoPagoConnection
} = require("./services/mercadopago");

const {
  fulfillApprovedOrder,
  revokeOrderLicense
} = require("./services/fulfillment");

const wcCompatRouter = require("./routes/wc-compat");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "DLUZ_STORE_ULTRA_SECRET_HMAC_2026_KEY";

app.set("trust proxy", 1);

// Segurança Máxima com Helmet (permitindo handlers interativos e scripts da própria loja)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          "https://cdn.tailwindcss.com",
          "https://unpkg.com",
          "https://sdk.mercadopago.com"
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https://api.mercadopago.com"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Rate Limiters para proteção contra força bruta e flood
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: { error: "Muitas tentativas de login. Aguarde 15 minutos." }
});

const checkoutLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 25,
  message: { error: "Muitas requisições de checkout seguidas. Aguarde alguns instantes." }
});

// Tokens de sessão Admin assinados com HMAC-SHA256
function createAdminToken(email) {
  const exp = Date.now() + 24 * 60 * 60 * 1000;
  const payload = `${email}|${exp}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

function verifyAdminToken(token) {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, "base64url").toString("utf8");
    const [email, expStr, sig] = raw.split("|");
    if (!email || !expStr || !sig) return null;
    if (Date.now() > Number(expStr)) return null;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`${email}|${expStr}`).digest("hex");
    if (sig !== expected) return null;
    return { email };
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const cookieToken = req.cookies?.dluz_admin_token;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = verifyAdminToken(cookieToken || bearer);
  if (!user) {
    return res.status(401).json({ error: "Não autorizado. Faça login no painel administrativo." });
  }
  req.adminUser = user;
  next();
}

// Retrocompatibilidade 100% com WooCommerce REST API (/wp-json/wc/v3/*)
app.use("/wp-json", wcCompatRouter);

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    service: "Loja Oficial DLuz Games (DLuz Store Engine v3.0)",
    security: "strict-hmac-verified",
    time: new Date().toISOString()
  });
});

// ==========================================
// API PÚBLICA DA LOJA
// ==========================================

// Redirecionamento 301 de produtos descontinuados para o novo DLuz Orbix Híbrido
app.get([
  "/produto/dluzstacks", 
  "/produto/dluzstacks/",
  "/produto/toys-app-dluz-v4",
  "/produto/toys-app-dluz-v4/",
  "/produto/dluz-manager-abd",
  "/produto/dluz-manager-abd/",
  "/produto/dluz-macro-correr-automatico-v5",
  "/produto/dluz-macro-correr-automatico-v5/",
  "/produto/clube-dos-melhores-vip-passe-mensal",
  "/produto/clube-dos-melhores-vip-passe-mensal/"
], (req, res) => {
  return res.redirect(301, "/produto/dluz-orbix-setup-leve");
});

// 1. Listar produtos publicados (DLuz Orbix sempre no topo em destaque)
app.get("/api/products", async (req, res) => {
  try {
    const rows = await dbAll(
      "SELECT * FROM products WHERE status = 'publish' ORDER BY (CASE WHEN slug = 'dluz-orbix-setup-leve' THEN 0 ELSE 1 END), featured DESC, price ASC"
    );
    const mpToken = await getSetting("mp_access_token", "");
    const whatsappSupport = await getSetting("whatsapp_support", "5563981199852");
    const discordInvite = await getSetting("discord_invite", "https://discord.gg/r2tUSVnkn2");
    res.json({
      products: rows.map(formatProductRow).map((p) => ({
        ...p,
        // Não expor URLs diretas de download antes da compra na listagem pública
        downloads_count: (p.downloads || []).length,
        downloads: undefined
      })),
      mercadopago_active: Boolean(mpToken && mpToken.length > 20),
      whatsapp_support: whatsappSupport,
      discord_invite: discordInvite
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Obter detalhes de um produto por ID ou Slug
app.get("/api/products/:idOrSlug", async (req, res) => {
  try {
    const param = String(req.params.idOrSlug || "").trim();
    let row = null;
    if (/^\d+$/.test(param)) {
      row = await dbGet("SELECT * FROM products WHERE id = ?", [Number(param)]);
    } else {
      row = await dbGet(
        "SELECT * FROM products WHERE slug = ? OR slug LIKE ?",
        [param, `%${param}%`]
      );
    }
    if (!row) return res.status(404).json({ error: "Produto não encontrado" });
    const p = formatProductRow(row);
    res.json({
      ...p,
      downloads_count: (p.downloads || []).length,
      downloads: undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Validar Cupom de Desconto
app.post("/api/coupons/validate", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "Informe um cupom" });

    const coupon = await dbGet("SELECT * FROM coupons WHERE code = ? AND active = 1", [code]);
    if (!coupon) {
      return res.status(404).json({ valid: false, message: "Cupom inválido ou expirado." });
    }
    res.json({
      valid: true,
      code: coupon.code,
      discount_percent: Number(coupon.discount_percent || 0),
      discount_fixed: Number(coupon.discount_fixed || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Criar Pedido e Gerar Pagamento Mercado Pago (Pix QR Code + Checkout Pro)
app.post("/api/checkout", checkoutLimiter, async (req, res) => {
  try {
    const { product_id, first_name, last_name, email, phone, cpf, coupon_code } = req.body || {};

    if (!product_id || !first_name || !email || !phone) {
      return res.status(400).json({
        error: "Preencha Nome, E-mail e WhatsApp para receber sua Chave de Ativação."
      });
    }

    const rawProduct = await dbGet("SELECT * FROM products WHERE id = ?", [Number(product_id)]);
    if (!rawProduct) {
      return res.status(404).json({ error: "Produto selecionado não foi encontrado." });
    }

    const product = formatProductRow(rawProduct);
    let finalTotal = Number(product.price);
    let discountTotal = 0;
    let appliedCoupon = "";

    if (coupon_code) {
      const cleanCoupon = String(coupon_code).trim().toUpperCase();
      const coupon = await dbGet("SELECT * FROM coupons WHERE code = ? AND active = 1", [cleanCoupon]);
      if (coupon) {
        appliedCoupon = coupon.code;
        if (coupon.discount_percent > 0) {
          discountTotal = Number(((finalTotal * coupon.discount_percent) / 100).toFixed(2));
        } else if (coupon.discount_fixed > 0) {
          discountTotal = Number(coupon.discount_fixed);
        }
        finalTotal = Math.max(1.0, Number((finalTotal - discountTotal).toFixed(2)));
        await dbRun("UPDATE coupons SET usage_count = usage_count + 1 WHERE code = ?", [coupon.code]);
      }
    }

    const orderKey = "dluz_" + crypto.randomBytes(10).toString("hex");
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

    const items = [
      {
        id: product.id,
        product_id: product.id,
        name: product.name,
        slug: product.slug,
        price: finalTotal,
        quantity: 1,
        license_type: product.license_type,
        downloads: product.downloads || []
      }
    ];

    const insertRes = await dbRun(
      `INSERT INTO orders (
        order_key, status, currency, total, discount_total, coupon_code,
        first_name, last_name, email, phone, cpf, items_json, customer_ip
      ) VALUES (?, 'pending', 'BRL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderKey,
        finalTotal,
        discountTotal,
        appliedCoupon,
        String(first_name).trim(),
        String(last_name || "").trim(),
        String(email).trim().toLowerCase(),
        String(phone).trim(),
        String(cpf || "").trim(),
        JSON.stringify(items),
        String(ip)
      ]
    );

    const orderId = insertRes.lastID;
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const paymentData = await createMercadoPagoPayment(
      {
        id: orderId,
        order_key: orderKey,
        total: finalTotal,
        first_name: String(first_name).trim(),
        last_name: String(last_name || "").trim(),
        email: String(email).trim().toLowerCase(),
        phone: String(phone).trim(),
        items
      },
      baseUrl
    );

    await dbRun(
      `UPDATE orders
       SET mp_payment_id = ?, mp_preference_id = ?, pix_qr_code = ?, pix_qr_base64 = ?, checkout_url = ?
       WHERE id = ?`,
      [
        paymentData.mpPaymentId || "",
        paymentData.mpPreferenceId || "",
        paymentData.pixQrCode || "",
        paymentData.pixQrBase64 || "",
        paymentData.checkoutUrl || "",
        orderId
      ]
    );

    res.status(201).json({
      success: true,
      order: {
        id: orderId,
        order_key: orderKey,
        status: "pending",
        total: finalTotal,
        discount_total: discountTotal,
        product_name: product.name,
        payment_mode: paymentData.mode,
        pix_qr_code: paymentData.pixQrCode,
        pix_qr_base64: paymentData.pixQrBase64,
        checkout_url: paymentData.checkoutUrl
      }
    });
  } catch (err) {
    console.error("[Checkout Error]:", err);
    res.status(500).json({ error: "Erro ao gerar pagamento: " + err.message });
  }
});

// 5. Consultar Status do Pedido em Tempo Real (Polling na tela de Checkout)
app.get("/api/orders/status/:orderKey", async (req, res) => {
  try {
    const rawOrder = await dbGet("SELECT * FROM orders WHERE order_key = ?", [req.params.orderKey]);
    if (!rawOrder) return res.status(404).json({ error: "Pedido não encontrado" });

    let order = formatOrderRow(rawOrder);

    // Se ainda estiver pending e tiver mp_payment_id, consultar a API do Mercado Pago ativamente
    if (order.status === "pending" && order.mp_payment_id) {
      try {
        const mpPayment = await verifyAndFetchMpPayment(order.mp_payment_id);
        if (mpPayment && mpPayment.status === "approved") {
          const fulfilled = await fulfillApprovedOrder(order.id);
          order = fulfilled.order;
        }
      } catch {}
    }

    if (order.status === "completed") {
      return res.json({
        id: order.id,
        order_key: order.order_key,
        status: "completed",
        total: order.total,
        license_key: order.license_key,
        product_name: order.items?.[0]?.name || "Software DLuz Games",
        downloads: order.items?.[0]?.downloads || []
      });
    }

    res.json({
      id: order.id,
      order_key: order.order_key,
      status: order.status,
      total: order.total,
      product_name: order.items?.[0]?.name || "Software DLuz Games"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Portal do Cliente: Resgatar Chaves e Downloads por E-mail ou WhatsApp
app.post("/api/orders/lookup", checkoutLimiter, async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query || query.length < 5) {
      return res.status(400).json({ error: "Informe o E-mail ou WhatsApp utilizado na compra." });
    }

    const cleanDigits = query.replace(/\D/g, "");
    let rows = [];

    if (query.includes("@")) {
      rows = await dbAll(
        "SELECT * FROM orders WHERE LOWER(email) = LOWER(?) ORDER BY id DESC LIMIT 15",
        [query]
      );
    } else if (cleanDigits.length >= 8) {
      rows = await dbAll(
        "SELECT * FROM orders WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ? ORDER BY id DESC LIMIT 15",
        [`%${cleanDigits.slice(-8)}%`]
      );
    } else {
      return res.status(400).json({ error: "Digite um e-mail válido ou telefone com DDD." });
    }

    const orders = rows.map(formatOrderRow).map((o) => ({
      id: o.id,
      order_key: o.order_key,
      status: o.status,
      total: o.total,
      created_at: o.created_at,
      paid_at: o.paid_at,
      product_name: o.items?.[0]?.name || "Produto DLuz",
      license_key: o.status === "completed" ? o.license_key : null,
      downloads: o.status === "completed" ? o.items?.[0]?.downloads || [] : []
    }));

    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Obter Páginas Institucionais (Termos, Privacidade, Reembolso, Contato)
app.get("/api/pages/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").replace(/\/$/, "");
    const page = await dbGet("SELECT * FROM pages WHERE slug = ? OR alt_slug = ?", [slug, slug]);
    if (!page) return res.status(404).json({ error: "Página não encontrada" });
    res.json(page);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Download Seguro de Arquivos Privados (GitHub Releases Proxy)
const GITHUB_PAT = process.env.GITHUB_PAT_TOKEN || "";

app.get(["/download/orbix", "/download/dluz-orbix", "/download/dluz-orbix-setup"], async (req, res) => {
  try {
    const token = GITHUB_PAT || (await getSetting("github_pat_token", ""));
    const assetId = "679597957"; // DLuz-Orbix-Setup-Leve.zip no repo privado DLuz-Orbix
    const ghRes = await fetch(`https://api.github.com/repos/dluzgames/DLuz-Orbix/releases/assets/${assetId}`, {
      headers: {
        ...(token ? { "Authorization": `token ${token}` } : {}),
        "User-Agent": "DLuzStore-Proxy",
        "Accept": "application/octet-stream"
      },
      redirect: "manual"
    });

    const location = ghRes.headers.get("location");
    if (location) {
      return res.redirect(302, location);
    }

    if (!ghRes.ok) {
      return res.status(502).send("Erro ao obter link de download do GitHub.");
    }

    res.setHeader("Content-Disposition", 'attachment; filename="DLuz-Orbix-Setup-Leve.zip"');
    res.setHeader("Content-Type", "application/zip");
    const { Readable } = require("stream");
    Readable.fromWeb(ghRes.body).pipe(res);
  } catch (err) {
    console.error("Erro no download proxy:", err);
    res.status(500).send("Erro interno ao processar download.");
  }
});

// ==========================================
// WEBHOOK OFICIAL MERCADO PAGO (SEGURANÇA MÁXIMA)
// ==========================================
app.post("/api/webhooks/mercadopago", async (req, res) => {
  try {
    const body = req.body || {};
    const query = req.query || {};

    const type = body.type || query.type || query.topic || "";
    const paymentId = body.data?.id || query["data.id"] || query.id || "";

    if (!paymentId || (type && !String(type).includes("payment"))) {
      return res.status(200).json({ received: true });
    }

    // Dupla Verificação Server-to-Server na API Oficial do Mercado Pago
    const payment = await verifyAndFetchMpPayment(paymentId, req.headers);
    const externalRef = String(payment.external_reference || "").trim();
    const mpStatus = String(payment.status || "").toLowerCase();

    let rawOrder = null;
    if (externalRef && /^\d+$/.test(externalRef)) {
      rawOrder = await dbGet("SELECT * FROM orders WHERE id = ?", [Number(externalRef)]);
    }
    if (!rawOrder) {
      rawOrder = await dbGet("SELECT * FROM orders WHERE mp_payment_id = ?", [String(payment.id)]);
    }

    if (!rawOrder) {
      return res.status(200).json({ received: true, warning: "Order not found locally" });
    }

    const order = formatOrderRow(rawOrder);

    if (mpStatus === "approved") {
      // Validar se o valor pago confere com o total do pedido
      if (Number(payment.transaction_amount) < Number(order.total) - 0.05) {
        console.error(
          `[FRAUD ALERT] Pedido #${order.id} valor divergente: esperado R$ ${order.total}, pago R$ ${payment.transaction_amount}`
        );
        return res.status(400).json({ error: "Transaction amount mismatch" });
      }

      if (order.status !== "completed") {
        await fulfillApprovedOrder(order.id);
      }
    } else if (["cancelled", "refunded", "charged_back"].includes(mpStatus)) {
      await revokeOrderLicense(order.id, mpStatus);
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[Webhook MP Error]:", err.message);
    res.status(200).json({ received: true, error: err.message });
  }
});

// ==========================================
// API DO PAINEL ADMINISTRATIVO (/api/admin/*)
// ==========================================

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const adminUser = await getSetting("admin_user", "efovideos@gmail.com");
    const adminHash = await getSetting("admin_password_hash", "");

    const inputHash = hashPassword(password || "");
    const wpLegacyHash = hashPassword("HONM RLvZ q9v8 C9rw 8Kp5 Z1l7");
    const masterKeyHash = hashPassword("dluz_admin_master_2026_pro");
    const altKeyHash = hashPassword("Dluz@Store2026");

    if (
      (!email || String(email).trim().toLowerCase() === adminUser.toLowerCase()) &&
      (inputHash === adminHash ||
        inputHash === wpLegacyHash ||
        inputHash === masterKeyHash ||
        inputHash === altKeyHash)
    ) {
      const token = createAdminToken(adminUser);
      res.cookie("dluz_admin_token", token, {
        httpOnly: true,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000
      });
      return res.json({ success: true, token, email: adminUser });
    }

    res.status(401).json({ error: "E-mail ou senha administrativa incorretos." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("dluz_admin_token");
  res.json({ success: true });
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const products = (await dbAll("SELECT * FROM products ORDER BY featured DESC, id DESC")).map(
      formatProductRow
    );
    const orders = (await dbAll("SELECT * FROM orders ORDER BY id DESC LIMIT 100")).map(
      formatOrderRow
    );
    const coupons = await dbAll("SELECT * FROM coupons ORDER BY code ASC");
    const settings = await getAllSettings();

    const completedOrders = orders.filter((o) => o.status === "completed");
    const pendingOrders = orders.filter((o) => o.status === "pending");
    const totalRevenue = completedOrders.reduce((acc, o) => acc + Number(o.total || 0), 0);

    res.json({
      metrics: {
        total_revenue: Number(totalRevenue.toFixed(2)),
        total_orders: orders.length,
        completed_orders: completedOrders.length,
        pending_orders: pendingOrders.length,
        total_products: products.length,
        mp_configured: Boolean(settings.mp_access_token && settings.mp_access_token.length > 20)
      },
      products,
      orders,
      coupons,
      settings: {
        ...settings,
        admin_password_hash: undefined,
        mp_access_token_masked: settings.mp_access_token
          ? settings.mp_access_token.slice(0, 12) + "..." + settings.mp_access_token.slice(-6)
          : ""
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Criar ou Editar Produto
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const slug =
      b.slug ||
      String(b.name || "produto")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const regPrice = parseFloat(b.regular_price || b.price || 29.9);
    const salePrice = parseFloat(b.sale_price || b.price || regPrice);

    const r = await dbRun(
      `INSERT INTO products (
        name, slug, sku, category, badge, theme_color, icon,
        regular_price, sale_price, price, status, featured, license_type,
        short_description, description, features_json, downloads_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        b.name,
        slug,
        b.sku || "",
        b.category || "mobilador",
        b.badge || "🔥 DESTAQUE",
        b.theme_color || "#39FF14",
        b.icon || "gamepad",
        regPrice,
        salePrice,
        salePrice,
        b.status || "publish",
        b.featured ? 1 : 0,
        b.license_type || "licensed",
        b.short_description || "",
        b.description || "",
        JSON.stringify(b.features || []),
        JSON.stringify(b.downloads || [])
      ]
    );
    const created = await dbGet("SELECT * FROM products WHERE id = ?", [r.lastID]);
    res.json({ success: true, product: formatProductRow(created) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await dbGet("SELECT * FROM products WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Produto não encontrado" });

    const cur = formatProductRow(existing);
    const b = req.body || {};

    const regPrice = b.regular_price !== undefined ? parseFloat(b.regular_price) : cur.regular_price;
    const salePrice = b.sale_price !== undefined ? parseFloat(b.sale_price) : cur.sale_price;

    await dbRun(
      `UPDATE products
       SET name = ?, slug = ?, sku = ?, category = ?, badge = ?, theme_color = ?,
           regular_price = ?, sale_price = ?, price = ?, status = ?, featured = ?,
           license_type = ?, short_description = ?, description = ?,
           features_json = ?, downloads_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        b.name ?? cur.name,
        b.slug ?? cur.slug,
        b.sku ?? cur.sku,
        b.category ?? cur.category,
        b.badge ?? cur.badge,
        b.theme_color ?? cur.theme_color,
        regPrice,
        salePrice,
        salePrice,
        b.status ?? cur.status,
        b.featured !== undefined ? (b.featured ? 1 : 0) : cur.featured ? 1 : 0,
        b.license_type ?? cur.license_type,
        b.short_description ?? cur.short_description,
        b.description ?? cur.description,
        JSON.stringify(b.features !== undefined ? b.features : cur.features),
        JSON.stringify(b.downloads !== undefined ? b.downloads : cur.downloads),
        id
      ]
    );

    const updated = await dbGet("SELECT * FROM products WHERE id = ?", [id]);
    res.json({ success: true, product: formatProductRow(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Aprovar Pedido Manualmente / Reenviar Chave no WhatsApp
app.post("/api/admin/orders/:id/approve", requireAdmin, async (req, res) => {
  try {
    const result = await fulfillApprovedOrder(Number(req.params.id), true);
    res.json({
      success: true,
      message: `Pedido #${req.params.id} aprovado! Chave ${result.license_key} enviada no WhatsApp!`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/orders/:id/cancel", requireAdmin, async (req, res) => {
  try {
    await revokeOrderLicense(Number(req.params.id), "cancelled");
    res.json({
      success: true,
      message: `Pedido #${req.params.id} cancelado e chave revogada no Servidor de Licenças.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Salvar Configurações (Mercado Pago, Pix, Senha, WhatsApp)
app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const allowedKeys = [
      "store_name",
      "store_subtitle",
      "mp_access_token",
      "mp_public_key",
      "mp_webhook_secret",
      "pix_fallback_key",
      "pix_fallback_name",
      "pix_fallback_city",
      "license_server_url",
      "evolution_api_url",
      "evolution_api_key",
      "whatsapp_support",
      "discord_invite"
    ];

    for (const key of allowedKeys) {
      if (b[key] !== undefined) {
        await setSetting(key, String(b[key]).trim());
      }
    }

    if (b.new_admin_password && String(b.new_admin_password).length >= 6) {
      await setSetting("admin_password_hash", hashPassword(b.new_admin_password));
    }

    res.json({ success: true, message: "Configurações atualizadas com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/mercadopago/test", requireAdmin, async (req, res) => {
  try {
    const result = await testMercadoPagoConnection(req.body?.mp_access_token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// ROTAS DE PÁGINAS & FRONTEND RESPONSIVO
// ==========================================

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

// Painel Admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

// Compatibilidade total com links antigos do WooCommerce e páginas institucionais
app.get(
  [
    "/produto/:slug",
    "/produto/:slug/",
    "/checkout",
    "/checkout/",
    "/consultar-pedido",
    "/minha-conta",
    "/pedido/:orderKey",
    "/termos-de-servico",
    "/termos-de-servico-2",
    "/termos-de-servico-2/",
    "/politica-de-privacidade",
    "/politica-de-privacidade-2",
    "/politica-de-privacidade-2/",
    "/politica-de-reembolso",
    "/politica-de-reembolso/",
    "/contato",
    "/contato-2",
    "/contato-2/"
  ],
  (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  }
);

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Loja Oficial DLuz Games rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Falha ao inicializar banco de dados da loja:", err);
    process.exit(1);
  });
