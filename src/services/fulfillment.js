const https = require("https");
const { dbRun, dbGet, getSetting, formatOrderRow } = require("../db/database");
const { obterOuCriarLicencaOrbix } = require("./orbix-license");

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
 * 1. Se for Orbix Player para Linux, emite o serial oficial assinado ECDSA P-256 (ORBX-XXXX...)
 *    e gera os links autenticados de download (.deb e .tar.gz)
 * 2. Se for outro produto, sincroniza com o Servidor de Licenças Oficial (lf7k749dplzo1qaa2au0izl1.dluz.com.br)
 * 3. Envia mensagem no WhatsApp com a chave e links de download
 * 4. Salva a chave e os links no banco para acesso na tela e área "Meus Pedidos"
 */
async function fulfillApprovedOrder(orderId, forceResend = false) {
  const rawOrder = await dbGet("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!rawOrder) {
    throw new Error(`Pedido #${orderId} não encontrado.`);
  }

  const order = formatOrderRow(rawOrder);

  // 1. Marcar status como 'completed' no banco de dados
  await dbRun(
    `UPDATE orders
     SET status = 'completed',
         paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [orderId]
  );
  order.status = "completed";

  // Identificar se é o Orbix Player para Linux
  const isOrbixLinux = (order.items || []).some(
    (item) =>
      item.slug === "orbix-player-para-linux" ||
      item.sku === "DLUZ-ORBIX-LINUX" ||
      item.product_id === 2960 ||
      item.id === 2960 ||
      String(item.name || "").toLowerCase().includes("orbix player")
  );

  let generatedKey = order.license_key || "";
  let whatsappStatus = "pending";
  let licenseResData = null;

  if (isOrbixLinux) {
    // 2.A. EMISSÃO OFICIAL DO SERIAL DO ORBIX PLAYER LINUX (ECDSA P-256)
    try {
      const orbixLic = await obterOuCriarLicencaOrbix(order);
      generatedKey = orbixLic.serial;
      licenseResData = {
        type: "orbix_linux_serial",
        serial: generatedKey,
        numero: orbixLic.numero,
        status: orbixLic.status
      };
    } catch (err) {
      console.error(`[Fulfillment] Erro ao emitir serial do Orbix Player para pedido #${order.id}:`, err.message);
      generatedKey = `ORBX-PENDENTE-${order.id}`;
    }
  } else {
    // 2.B. FLUXO PADRÃO COM O SERVIDOR DE LICENÇAS WOOCOMMERCE
    const licenseServerUrl = await getSetting(
      "license_server_url",
      "https://lf7k749dplzo1qaa2au0izl1.dluz.com.br/api/webhook/woocommerce"
    );

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
  }

  // Envio de WhatsApp direto via Evolution API (frya)
  if (whatsappStatus !== "sent_by_license_server" && order.phone) {
    try {
      const evoUrl = await getSetting("evolution_api_url", "https://evolution.dluz.com.br/message/sendText/frya");
      const evoKey = await getSetting("evolution_api_key", "bvNSCH2VoX8ByDb000mJjMiKmmFJEkFj");

      let cleanPhone = String(order.phone).replace(/\D/g, "");
      if (cleanPhone.length === 10 || cleanPhone.length === 11) {
        cleanPhone = "55" + cleanPhone;
      }

      const mainItem = order.items?.[0] || { name: "DLuz Games Software" };
      let message = "";

      if (isOrbixLinux) {
        message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🐧

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *#${order.id}* (*Orbix Player para Linux*) foi aprovado com sucesso!

━━━━━━━━━━━━━━━━━━━━
🔑 *SEU SERIAL OFICIAL ORBIX PLAYER (LINUX):*
\`${generatedKey}\`
━━━━━━━━━━━━━━━━━━━━

📦 *SEUS LINKS EXCLUSIVOS DE DOWNLOAD:*
🐧 *Instalador Ubuntu, Pop!_OS, Mint, Debian, Zorin (.deb):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/deb

📦 *Outras Distribuições Linux (.tar.gz):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/tar

📖 *COMO INSTALAR:*
1. Baixe o arquivo .deb (ou extraia o .tar.gz e rode \`bash install.sh\`).
2. Dê dois cliques e clique em *Instalar* (ou no terminal: \`sudo apt install ./orbix-player_1.0.0_amd64.deb\`).
3. Abra o *Orbix Player* no menu de aplicativos.
4. Cole o serial acima e clique em *Ativar*.
5. Clique em *"Baixar e instalar"* para o Android baixar (cerca de 2,5 GB só na primeira vez). Se a internet cair, ele continua de onde parou.
6. Pronto: o Android liga sozinho. Instale seus jogos e jogue a 120 FPS!

💡 *REQUISITOS IMPORTANTES:*
- A virtualização precisa estar ativada na BIOS (Intel VT-x ou AMD-V / SVM).
- Placa de vídeo NVIDIA, AMD ou Intel.

⭐ *SUPORTE & COMUNIDADE:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, fale direto conosco aqui no WhatsApp! Bom jogo! 🚀🎮🔥`;
      } else {
        const downloadsList = (mainItem.downloads || [])
          .map((d) => `🔹 *${d.name}:*\n${d.file}`)
          .join("\n\n");

        const keyBlock =
          generatedKey && generatedKey !== "PRODUTO-LIBERADO-SEM-CHAVE"
            ? `\n━━━━━━━━━━━━━━━━━━━━\n🔑 *SUA CHAVE DE ATIVAÇÃO VITALÍCIA PRO:*\n\`${generatedKey}\`\n━━━━━━━━━━━━━━━━━━━━\n`
            : `\nℹ️ *Acesso Direto Liberado (Não necessita de chave de ativação)*\n`;

        message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🎮

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *#${order.id}* (*${mainItem.name}*) foi aprovado com sucesso!
${keyBlock}
📦 *LINKS OFICIAIS DE DOWNLOAD:*
${downloadsList || "https://github.com/dluzgames/DLuzMobiladorPlus/releases/download/v3.5.1/DLuzMobiladorPlus_v3.5.1_Portatil.zip"}

⭐ *SUPORTE & COMUNIDADE:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, estamos 100% à disposição aqui no WhatsApp! Bom jogo! 🚀🎮🔥`;
      }

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

  // Marcar licença do Orbix Player como reembolsada no banco (conforme item 8 de PROMPT-ANTIGRAVITY.md)
  try {
    await dbRun("UPDATE licencas SET status = 'reembolsada' WHERE pedido_id = ?", [orderId]);
  } catch {}

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
