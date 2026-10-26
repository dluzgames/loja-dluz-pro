const https = require("https");
const { dbRun, dbGet, getSetting, formatOrderRow } = require("../db/database");

function requestHttps(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = postData ? (typeof postData === "string" ? postData : JSON.stringify(postData)) : null;

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DLuz-Store-Fulfillment/3.0",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...(options.headers || {})
        },
        rejectUnauthorized: false
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
 * Processa a aprovação de um pedido:
 * 1. Sincroniza com o Servidor de Licenças Oficial (lf7k749dplzo1qaa2au0izl1.dluz.com.br) para gerar a chave DLUZ-PRO-XXXX
 * 2. O Servidor de Licenças (ou fallback direto aqui) envia a mensagem no WhatsApp do cliente via Evolution API (frya)
 * 3. Salva a chave e os links de download no pedido para exibição imediata na tela do cliente e área "Meus Pedidos"
 */
async function fulfillApprovedOrder(orderId, forceResend = false) {
  const rawOrder = await dbGet("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!rawOrder) {
    throw new Error(`Pedido #${orderId} não encontrado.`);
  }

  const order = formatOrderRow(rawOrder);
  const licenseServerUrl = await getSetting(
    "license_server_url",
    "https://lf7k749dplzo1qaa2au0izl1.dluz.com.br/api/webhook/woocommerce"
  );

  // Montar payload idêntico ao WooCommerce para máxima compatibilidade com o Servidor de Licenças
  const wcPayload = {
    id: order.id,
    status: "completed",
    force: Boolean(forceResend),
    billing: {
      first_name: order.first_name || "Gamer",
      last_name: order.last_name || "",
      email: order.email || "",
      phone: order.phone || ""
    },
    line_items: (order.items || []).map((item) => ({
      id: item.id || item.product_id,
      product_id: item.product_id || item.id,
      name: item.name,
      quantity: item.quantity || 1,
      total: String(item.price || order.total)
    }))
  };

  let generatedKey = order.license_key || "";
  let whatsappStatus = "pending";
  let licenseResData = null;

  try {
    const res = await requestHttps(licenseServerUrl, { method: "POST" }, wcPayload);
    licenseResData = res.data;

    if (res.data && res.data.key) {
      generatedKey = res.data.key;
    } else if (res.data && res.data.type === "unlicensed") {
      generatedKey = "PRODUTO-LIBERADO-SEM-CHAVE";
    }

    if (res.data && res.data.whatsapp && String(res.data.whatsapp).includes("Enviado")) {
      whatsappStatus = "sent_by_license_server";
    }
  } catch (err) {
    console.error(`[Fulfillment] Erro ao contatar Servidor de Licenças para pedido #${order.id}:`, err.message);
  }

  // Se o Servidor de Licenças não enviou o WhatsApp (ou se falhou conexão), enviamos diretamente via Evolution API (frya)
  if (whatsappStatus !== "sent_by_license_server" && order.phone) {
    try {
      const evoUrl = await getSetting("evolution_api_url", "https://evolution.dluz.com.br/message/sendText/frya");
      const evoKey = await getSetting("evolution_api_key", "bvNSCH2VoX8ByDb000mJjMiKmmFJEkFj");

      let cleanPhone = String(order.phone).replace(/\D/g, "");
      if (cleanPhone.length === 10 || cleanPhone.length === 11) {
        cleanPhone = "55" + cleanPhone;
      }

      const mainItem = order.items?.[0] || { name: "DLuz Mobilador Pro v3.5.1" };
      const downloadsList = (mainItem.downloads || [])
        .map((d) => `🔹 *${d.name}:*\n${d.file}`)
        .join("\n\n");

      const keyBlock =
        generatedKey && generatedKey !== "PRODUTO-LIBERADO-SEM-CHAVE"
          ? `\n━━━━━━━━━━━━━━━━━━━━\n🔑 *SUA CHAVE DE ATIVAÇÃO VITALÍCIA PRO:*\n\`${generatedKey}\`\n━━━━━━━━━━━━━━━━━━━━\n`
          : `\nℹ️ *Acesso Direto Liberado (Não necessita de chave de ativação)*\n`;

      const message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🎮

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *#${order.id}* (*${mainItem.name}*) foi aprovado com sucesso!
${keyBlock}
📦 *LINKS OFICIAIS DE DOWNLOAD:*
${downloadsList || "https://github.com/dluzgames/DLuzMobiladorPlus/releases/download/v3.5.1/DLuzMobiladorPlus_v3.5.1_Portatil.zip"}

⭐ *SUPORTE & COMUNIDADE:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, estamos 100% à disposição aqui no WhatsApp! Bom jogo! 🚀🎮🔥`;

      const waRes = await requestHttps(
        evoUrl,
        {
          method: "POST",
          headers: { apikey: evoKey }
        },
        {
          number: cleanPhone,
          text: message
        }
      );

      if (waRes.status >= 200 && waRes.status < 300) {
        whatsappStatus = "sent_direct";
      }
    } catch (waErr) {
      console.error(`[Fulfillment] Erro ao enviar WhatsApp direto para pedido #${order.id}:`, waErr.message);
    }
  }

  await dbRun(
    `UPDATE orders
     SET status = 'completed',
         license_key = COALESCE(NULLIF(?, ''), license_key),
         whatsapp_sent = ?,
         email_sent = 1,
         paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [generatedKey, whatsappStatus.startsWith("sent") ? 1 : 0, order.id]
  );

  await dbRun(
    "INSERT INTO order_notes (order_id, note, customer_note) VALUES (?, ?, 1)",
    [
      order.id,
      `Pedido #${order.id} aprovado e liberado! Chave: ${generatedKey || "Acesso Direto"} | WhatsApp: ${whatsappStatus}`
    ]
  );

  // Incrementar contador de vendas do produto
  if (order.items?.[0]?.id) {
    await dbRun("UPDATE products SET sales_count = sales_count + 1 WHERE id = ?", [order.items[0].id]);
  }

  const updated = await dbGet("SELECT * FROM orders WHERE id = ?", [order.id]);
  return {
    order: formatOrderRow(updated),
    license_key: generatedKey,
    whatsapp_status: whatsappStatus,
    license_server_response: licenseResData
  };
}

/**
 * Revoga a licença imediatamente em caso de cancelamento ou reembolso no Mercado Pago
 */
async function revokeOrderLicense(orderId, reason = "cancelled") {
  await dbRun(
    "UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [reason, orderId]
  );

  const licenseServerUrl = await getSetting(
    "license_server_url",
    "https://lf7k749dplzo1qaa2au0izl1.dluz.com.br/api/webhook/woocommerce"
  );

  try {
    await requestHttps(licenseServerUrl, { method: "POST" }, {
      id: orderId,
      status: "cancelled"
    });
  } catch (err) {
    console.error(`[Revoke] Erro ao revogar licença do pedido #${orderId}:`, err.message);
  }

  await dbRun(
    "INSERT INTO order_notes (order_id, note, customer_note) VALUES (?, ?, 0)",
    [orderId, `Pedido alterado para ${reason} e chave revogada no Servidor de Licenças.`]
  );
}

module.exports = {
  fulfillApprovedOrder,
  revokeOrderLicense
};
