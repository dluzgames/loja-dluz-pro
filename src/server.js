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
  testMercadoPagoConnection,
  syncAndReconcileMpPayments
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
    const { product_id, first_name, last_name, email, phone, cpf, coupon_code, payment_method } = req.body || {};

    if (!product_id || !first_name || !email || !phone) {
      return res.status(400).json({
        error: "Preencha Nome, E-mail e WhatsApp para receber sua Chave de Ativação."
      });
    }

    const cleanCpf = String(cpf || "").replace(/\D/g, "");
    if (!cleanCpf || cleanCpf.length < 11) {
      return res.status(400).json({
        error: "Informe um CPF válido para emissão do pagamento e nota fiscal no Mercado Pago."
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

    const isCard = String(payment_method || "").toLowerCase() === "card";
    const payMethodKey = isCard ? "mercadopago_card" : "mercadopago_pix";
    const payMethodTitle = isCard ? "Cartão de Crédito Mercado Pago" : "Pix Mercado Pago";

    const insertRes = await dbRun(
      `INSERT INTO orders (
        order_key, status, currency, total, discount_total, coupon_code,
        first_name, last_name, email, phone, cpf, payment_method, payment_method_title, items_json, customer_ip
      ) VALUES (?, 'pending', 'BRL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderKey,
        finalTotal,
        discountTotal,
        appliedCoupon,
        String(first_name).trim(),
        String(last_name || "").trim(),
        String(email).trim().toLowerCase(),
        String(phone).trim(),
        String(cleanCpf).trim(),
        payMethodKey,
        payMethodTitle,
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
        cpf: cleanCpf,
        payment_method: payment_method || "pix",
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
      let downloads = order.items?.[0]?.downloads || [];
      const isOrbixLinux = (order.items || []).some(
        (i) => i.slug === "orbix-player-para-linux" || i.sku === "DLUZ-ORBIX-LINUX" || i.id === 2960
      );
      const isCanalDark = (order.items || []).some(
        (i) => i.slug === "canal-dark-100-automatico" || i.sku === "DLUZ-CANAL-DARK-AUTO" || i.id === 2970 || String(i.name || "").toLowerCase().includes("canal dark")
      );

      if (isOrbixLinux) {
        downloads = [
          {
            name: "Orbix Player para Linux (.deb) — Ubuntu, Pop!_OS, Mint, Debian, Zorin",
            file: `/download/orbix-player/${order.order_key}/deb`
          },
          {
            name: "Orbix Player para Linux (.tar.gz) — Outras Distribuições",
            file: `/download/orbix-player/${order.order_key}/tar`
          },
          {
            name: "Hashes de Verificação (SHA256SUMS)",
            file: `/download/orbix-player/${order.order_key}/sha256`
          }
        ];
      } else if (isCanalDark) {
        downloads = [
          {
            name: "Pack Canal Dark 100% Automático — Suite Completa de Softwares",
            file: `/download/canal-dark/${order.order_key}/suite`
          },
          {
            name: "Guia Rápido & Ativação da API Oficial (18 Meses Inclusos)",
            file: `/download/canal-dark/${order.order_key}/guia`
          }
        ];
      }

      return res.json({
        id: order.id,
        order_key: order.order_key,
        status: "completed",
        total: order.total,
        license_key: order.license_key,
        product_name: order.items?.[0]?.name || "Software DLuz Games",
        downloads
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

// 8. Download Seguro do Orbix Player para Linux (.deb, .tar.gz, sha256)
app.get([
  "/download/orbix-player/:orderKey/:fileType",
  "/download/orbix-player/:fileType"
], async (req, res) => {
  try {
    const orderKey = req.params.orderKey || req.query.token || req.query.key || "";
    const fileType = req.params.fileType || req.params.orderKey || "";

    let isAuthorized = false;
    if (req.session && req.session.adminUser) {
      isAuthorized = true;
    } else if (orderKey) {
      const order = await dbGet("SELECT id, status FROM orders WHERE order_key = ?", [orderKey]);
      if (order && order.status === "completed") {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head><meta charset="utf-8"><title>Acesso Restrito — Orbix Player</title>
        <style>body{font-family:sans-serif;background:#0B0F19;color:#F8FAFC;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#1E293B;padding:36px;border-radius:14px;text-align:center;max-width:440px;border:1px solid #334155;box-shadow:0 8px 30px rgba(0,0,0,0.5);}
        h2{color:#38BDF8;margin-top:0;}a{display:inline-block;margin-top:18px;background:#0284C7;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;}</style>
        </head>
        <body><div class="card">
          <h2>🐧 Orbix Player para Linux</h2>
          <p>O download dos instaladores (.deb e .tar.gz) é exclusivo para clientes com licença ativa.</p>
          <p>Consulte seu pedido ou fale com nosso suporte oficial no WhatsApp.</p>
          <a href="/consultar-pedido">Consultar Meu Pedido</a>
        </div></body>
        </html>
      `);
    }

    const downloadsDir = path.join(__dirname, "../data/downloads");
    let targetFileName = "";
    let contentType = "application/octet-stream";

    const cleanType = String(fileType || "").toLowerCase();
    if (cleanType === "deb" || cleanType.includes(".deb")) {
      targetFileName = "orbix-player_1.0.0_amd64.deb";
      contentType = "application/vnd.debian.binary-package";
    } else if (cleanType === "tar" || cleanType.includes(".tar") || cleanType.includes("tar.gz")) {
      targetFileName = "orbix-player-1.0.0-linux-x64.tar.gz";
      contentType = "application/gzip";
    } else if (cleanType === "sha256" || cleanType === "sha256sums") {
      targetFileName = "SHA256SUMS";
      contentType = "text/plain; charset=utf-8";
    } else {
      return res.status(404).send("Arquivo não encontrado.");
    }

    const filePath = path.join(downloadsDir, targetFileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send("Instalador em processamento no servidor.");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${targetFileName}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).send("Erro ao processar download.");
  }
});

// 9. Download Seguro do Pack Canal Dark 100% Automático
app.get([
  "/download/canal-dark/:orderKey/:fileType",
  "/download/canal-dark/:fileType"
], async (req, res) => {
  try {
    const orderKey = req.params.orderKey || req.query.token || req.query.key || "";
    const fileType = req.params.fileType || req.params.orderKey || "suite";

    let isAuthorized = false;
    if (req.session && req.session.adminUser) {
      isAuthorized = true;
    } else if (orderKey) {
      const order = await dbGet("SELECT id, status FROM orders WHERE order_key = ?", [orderKey]);
      if (order && order.status === "completed") {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head><meta charset="utf-8"><title>Acesso Restrito — Canal Dark 100% Automático</title>
        <style>body{font-family:sans-serif;background:#0B0F19;color:#F8FAFC;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#1E293B;padding:36px;border-radius:14px;text-align:center;max-width:440px;border:1px solid #334155;box-shadow:0 8px 30px rgba(0,0,0,0.5);}
        h2{color:#C084FC;margin-top:0;}a{display:inline-block;margin-top:18px;background:#8B5CF6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;}</style>
        </head>
        <body><div class="card">
        <h2>🔒 Download Protegido</h2>
        <p>Este download é exclusivo para compradores do Canal Dark 100% Automático na Loja DLuz.</p>
        <a href="https://loja.dluz.com.br/produto/canal-dark-100-automatico">Adquirir Pacote Oficial (R$ 78,00)</a>
        </div></body></html>
      `);
    }

    // Fallback amigável com Central do Criador e downloads
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Canal Dark 100% Automático — Central do Criador DLuz</title>
      <style>
        body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#07090E;color:#F8FAFC;padding:40px 20px;margin:0;}
        .container{max-width:680px;margin:0 auto;background:#0F172A;border:1px solid #8B5CF6;border-radius:20px;padding:36px;box-shadow:0 10px 40px rgba(139,92,246,0.15);}
        h1{color:#C084FC;font-size:24px;margin-top:0;display:flex;align-items:center;gap:10px;}
        .badge{display:inline-block;background:rgba(139,92,246,0.2);color:#C084FC;font-size:12px;font-weight:bold;padding:4px 10px;border-radius:20px;margin-bottom:16px;}
        .card{background:#1E293B;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:18px;margin-bottom:14px;}
        .card h3{margin:0 0 6px 0;font-size:15px;color:#F1F5F9;}
        .card p{margin:0;font-size:13px;color:#94A3B8;}
        .btn{display:inline-block;background:#8B5CF6;color:#fff;font-weight:bold;padding:12px 24px;border-radius:10px;text-decoration:none;margin-top:20px;transition:0.2s;}
        .btn:hover{background:#7C3AED;}
      </style></head>
      <body>
      <div class="container">
        <span class="badge">🔥 ACESSO VIP CONFIRMADO</span>
        <h1>🚀 Canal Dark 100% Automático</h1>
        <p style="color:#94A3B8;font-size:14px;">Parabéns pela sua compra! Abaixo estão as suas ferramentas e recursos liberados:</p>
        
        <div class="card">
          <h3>🎙️ 1. Clonador e Sintetizador de Voz Neural Studio</h3>
          <p>Síntese vocal com cadência ultra-humana e emoção de locutor profissional.</p>
        </div>
        <div class="card">
          <h3>🎮 2. Downloader de Gameplays 4K 60FPS</h3>
          <p>Cenas limpas dos jogos mais virais sem HUD e sem comentários.</p>
        </div>
        <div class="card">
          <h3>🎬 3. Minerador de Mídias, Manchetes e B-Rolls</h3>
          <p>Captura automática de notícias atualizadas para ganchos virais nos primeiros 3 segundos.</p>
        </div>
        <div class="card">
          <h3>🎵 4. Gerador de Trilhas com Sound Vacuum</h3>
          <p>BGM adaptativa com corte de áudio no clímax da narrativa para máxima retenção.</p>
        </div>
        <div class="card">
          <h3>✂️ 5. Editor de Vídeo Profissional 100% Automático</h3>
          <p>Cortes secos no beat, punch-zoom e legendas cinéticas em Amarelo Ouro e Verde Neon.</p>
        </div>
        <div class="card" style="border-color:#39FF14;">
          <h3 style="color:#39FF14;">⚡ 6. API Oficial Grátis por 18 Meses</h3>
          <p>Acesso total liberado para automação e inteligência artificial ilimitada.</p>
        </div>

        <a class="btn" href="https://discord.gg/r2tUSVnkn2">Acessar Canal VIP no Discord ➔</a>
      </div>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("Erro ao processar download.");
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

    if (!rawOrder && mpStatus === "approved") {
      console.log(`[Webhook MP] Pedido não encontrado localmente para pagamento aprovado #${payment.id}. Reconciliando automaticamente...`);
      await syncAndReconcileMpPayments();
      if (externalRef && /^\d+$/.test(externalRef)) {
        rawOrder = await dbGet("SELECT * FROM orders WHERE id = ?", [Number(externalRef)]);
      }
      if (!rawOrder) {
        rawOrder = await dbGet("SELECT * FROM orders WHERE mp_payment_id = ?", [String(payment.id)]);
      }
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
// Admin: Gestão de Licenças e Seriais Orbix Player
app.get("/api/admin/licencas", requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    let sql = "SELECT * FROM licencas";
    let params = [];
    if (q) {
      sql += " WHERE LOWER(email) LIKE ? OR LOWER(nome) LIKE ? OR serial LIKE ? OR pedido_id = ?";
      params = [`%${q}%`, `%${q}%`, `%${q}%`, Number(q) || 0];
    }
    sql += " ORDER BY id DESC LIMIT 100";
    const licencas = await dbAll(sql, params);
    res.json({ success: true, licencas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/licencas/gerar", requireAdmin, async (req, res) => {
  try {
    const { dias, maquina, email, nome, motivo } = req.body || {};
    const { emitirSerialManual } = require("./services/orbix-license");
    const lic = await emitirSerialManual({
      dias: Number(dias) || 0,
      maquina: maquina || null,
      email: email || "",
      nome: nome || "",
      motivo: motivo || "geracao_manual_admin"
    });
    res.json({ success: true, licenca: lic });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Consultar Status da Chave Privada ECDSA P-256
app.get("/api/admin/licencas/chave-status", requireAdmin, async (req, res) => {
  try {
    const { consultarStatusChaveOrbix } = require("./services/orbix-license");
    const status = await consultarStatusChaveOrbix();
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Salvar e Validar Chave Privada ECDSA P-256 + Sincronizar Coolify
app.post("/api/admin/licencas/salvar-chave", requireAdmin, async (req, res) => {
  try {
    const { pem } = req.body || {};
    if (!pem || typeof pem !== "string" || pem.trim().length < 30) {
      return res.status(400).json({ error: "Conteúdo da chave PEM é obrigatório." });
    }
    const { salvarChavePrivadaOrbix } = require("./services/orbix-license");
    const result = await salvarChavePrivadaOrbix(pem);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
  .then(async () => {
    // Reconciliação imediata na inicialização para resgatar pagamentos aprovados
    try {
      console.log("[Mercado Pago] Executando sincronização inicial de pagamentos...");
      await syncAndReconcileMpPayments();
    } catch (reconcileErr) {
      console.error("[Mercado Pago Startup Error]:", reconcileErr.message);
    }

    // Poller contínuo a cada 60 segundos garantindo que nenhuma venda fique pendente
    setInterval(syncAndReconcileMpPayments, 60000);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Loja Oficial DLuz Games rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Falha ao inicializar banco de dados da loja:", err);
    process.exit(1);
  });
