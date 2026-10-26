const https = require("https");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { getSetting } = require("../db/database");

function httpsJson(urlStr, options = {}, payload = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = payload ? JSON.stringify(payload) : null;

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "DLuz-Store-Engine/3.0",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...(options.headers || {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data || "{}") });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      }
    );

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Gera payload BRCode EMVCo oficial (Padrão Banco Central do Brasil - CRC16-CCITT)
 * Usado como contingência imediata caso o token da API Mercado Pago ainda não esteja preenchido.
 */
function formatEmvField(id, value) {
  const str = String(value);
  const len = String(str.length).padStart(2, "0");
  return `${id}${len}${str}`;
}

function computeCrc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function generateEmvPixPayload({ pixKey, merchantName, merchantCity, amount, txid }) {
  const cleanName = (merchantName || "DLUZ GAMES")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .substring(0, 25)
    .toUpperCase();
  const cleanCity = (merchantCity || "SAO PAULO")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .substring(0, 15)
    .toUpperCase();
  const cleanTxid = String(txid || "DLUZ").replace(/[^a-zA-Z0-9]/g, "").substring(0, 25) || "***";

  const gui = formatEmvField("00", "br.gov.bcb.pix");
  const keyField = formatEmvField("01", pixKey.trim());
  const merchantAccount = formatEmvField("26", `${gui}${keyField}`);

  const payloadFormat = formatEmvField("00", "01");
  const merchantCategory = formatEmvField("52", "0000");
  const currency = formatEmvField("53", "986");
  const amountField = amount > 0 ? formatEmvField("54", Number(amount).toFixed(2)) : "";
  const country = formatEmvField("58", "BR");
  const nameField = formatEmvField("59", cleanName);
  const cityField = formatEmvField("60", cleanCity);
  const addData = formatEmvField("62", formatEmvField("05", cleanTxid));

  const basePayload = `${payloadFormat}${merchantAccount}${merchantCategory}${currency}${amountField}${country}${nameField}${cityField}${addData}6304`;
  const crc = computeCrc16(basePayload);
  return `${basePayload}${crc}`;
}

/**
 * Cria pagamento Pix no Mercado Pago (API v1/payments) + Preferência Checkout Pro (Cartão/Boleto)
 */
async function createMercadoPagoPayment(order, baseUrl) {
  const accessToken = (await getSetting("mp_access_token", process.env.MP_ACCESS_TOKEN || "")).trim();
  const itemTitle = order.items?.[0]?.name || "Software Oficial DLuz Games";
  const webhookUrl = `${baseUrl}/api/webhooks/mercadopago`;

  let mpPaymentId = "";
  let mpPreferenceId = "";
  let pixQrCode = "";
  let pixQrBase64 = "";
  let checkoutUrl = "";
  let mode = "mercadopago_api";

  if (accessToken && accessToken.length > 20) {
    // 1. Criar Pix Transparente Oficial via Mercado Pago API v1
    try {
      const idempotencyKey = `dluz-order-${order.id}-${Date.now()}`;
      const pixPayload = {
        transaction_amount: Number(Number(order.total).toFixed(2)),
        description: `Pedido #${order.id} - ${itemTitle}`,
        payment_method_id: "pix",
        external_reference: String(order.id),
        notification_url: webhookUrl,
        payer: {
          email: order.email || "cliente@dluzgames.com.br",
          first_name: order.first_name || "Cliente",
          last_name: order.last_name || "Gamer"
        }
      };

      const mpRes = await httpsJson(
        "https://api.mercadopago.com/v1/payments",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "X-Idempotency-Key": idempotencyKey
          }
        },
        pixPayload
      );

      if (mpRes.status >= 200 && mpRes.status < 300 && mpRes.data?.id) {
        mpPaymentId = String(mpRes.data.id);
        const txData = mpRes.data.point_of_interaction?.transaction_data || {};
        pixQrCode = txData.qr_code || "";
        pixQrBase64 = txData.qr_code_base64
          ? `data:image/png;base64,${txData.qr_code_base64}`
          : "";
        checkoutUrl = txData.ticket_url || "";
      } else {
        console.warn("[Mercado Pago Pix Warning]:", mpRes.status, JSON.stringify(mpRes.data));
      }
    } catch (err) {
      console.error("[Mercado Pago Pix Error]:", err.message);
    }

    // 2. Criar Preferência Checkout Pro (Para Cartão de Crédito até 12x / Conta Mercado Pago)
    try {
      const prefPayload = {
        items: (order.items || []).map((item) => ({
          id: String(item.product_id || item.id || "2755"),
          title: item.name,
          quantity: Number(item.quantity || 1),
          currency_id: "BRL",
          unit_price: Number(Number(item.price || order.total).toFixed(2))
        })),
        payer: {
          name: order.first_name,
          surname: order.last_name || "",
          email: order.email
        },
        external_reference: String(order.id),
        notification_url: webhookUrl,
        back_urls: {
          success: `${baseUrl}/pedido/${order.order_key}?status=approved`,
          pending: `${baseUrl}/pedido/${order.order_key}?status=pending`,
          failure: `${baseUrl}/pedido/${order.order_key}?status=failure`
        },
        auto_return: "approved",
        statement_descriptor: "DLUZ GAMES"
      };

      const prefRes = await httpsJson(
        "https://api.mercadopago.com/checkout/preferences",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`
          }
        },
        prefPayload
      );

      if (prefRes.status >= 200 && prefRes.status < 300 && prefRes.data?.init_point) {
        mpPreferenceId = String(prefRes.data.id || "");
        checkoutUrl = prefRes.data.init_point;
      }
    } catch (prefErr) {
      console.error("[Mercado Pago Preference Error]:", prefErr.message);
    }
  }

  // Fallback seguro EMVCo BRCode caso o Pix da API não tenha retornado QR (ex: token ainda não configurado)
  if (!pixQrCode) {
    mode = "pix_emv_fallback";
    const pixKey = await getSetting("pix_fallback_key", "duilioluzefo@gmail.com");
    const merchantName = await getSetting("pix_fallback_name", "MANOEL DUILIO DA LUZ SOUSA");
    const merchantCity = await getSetting("pix_fallback_city", "PARAISO DO TOCANTINS");

    pixQrCode = generateEmvPixPayload({
      pixKey,
      merchantName,
      merchantCity,
      amount: order.total,
      txid: `DLUZ${order.id}`
    });

    pixQrBase64 = await QRCode.toDataURL(pixQrCode, {
      width: 320,
      margin: 1,
      color: {
        dark: "#000000",
        light: "#FFFFFF"
      }
    });
  } else if (!pixQrBase64 && pixQrCode) {
    pixQrBase64 = await QRCode.toDataURL(pixQrCode, { width: 320, margin: 1 });
  }

  return {
    mode,
    mpPaymentId,
    mpPreferenceId,
    pixQrCode,
    pixQrBase64,
    checkoutUrl
  };
}

/**
 * Valida a assinatura HMAC-SHA256 do Webhook do Mercado Pago (x-signature)
 * e realiza a dupla verificação Server-to-Server consultando GET /v1/payments/:id
 */
async function verifyAndFetchMpPayment(paymentId, headers = {}) {
  const accessToken = (await getSetting("mp_access_token", process.env.MP_ACCESS_TOKEN || "")).trim();
  const webhookSecret = (await getSetting("mp_webhook_secret", process.env.MP_WEBHOOK_SECRET || "")).trim();

  if (!accessToken) {
    throw new Error("MP_ACCESS_TOKEN não configurado.");
  }

  // Se o webhook_secret estiver configurado, valida a assinatura criptográfica x-signature
  if (webhookSecret && headers["x-signature"]) {
    const xSignature = String(headers["x-signature"]);
    const xRequestId = String(headers["x-request-id"] || "");
    const parts = {};
    xSignature.split(",").forEach((p) => {
      const [k, v] = p.trim().split("=");
      if (k && v) parts[k] = v;
    });

    if (parts.ts && parts.v1) {
      const manifest = `id:${paymentId};request-id:${xRequestId};ts:${parts.ts};`;
      const hmac = crypto.createHmac("sha256", webhookSecret).update(manifest).digest("hex");
      if (hmac !== parts.v1) {
        console.warn("[SECURITY ALERT] Assinatura HMAC do webhook não coincidiu, verificando diretamente na API Mercado Pago...");
      }
    }
  }

  // Dupla Checagem Obrigatória Server-to-Server direto na API oficial do Mercado Pago
  const res = await httpsJson(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`
    }
  });

  if (res.status === 200 && res.data && res.data.id) {
    return res.data;
  }

  throw new Error(`Não foi possível validar o pagamento #${paymentId} na API do Mercado Pago (Status ${res.status})`);
}

async function testMercadoPagoConnection(customToken = null) {
  const token = (customToken || (await getSetting("mp_access_token", ""))).trim();
  if (!token) {
    return { ok: false, message: "Nenhum Access Token informado." };
  }
  const res = await httpsJson("https://api.mercadopago.com/users/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  if (res.status === 200 && res.data?.id) {
    return {
      ok: true,
      user_id: res.data.id,
      nickname: res.data.nickname,
      email: res.data.email,
      site_id: res.data.site_id
    };
  }
  return { ok: false, status: res.status, details: res.data };
}

module.exports = {
  createMercadoPagoPayment,
  verifyAndFetchMpPayment,
  testMercadoPagoConnection
};
