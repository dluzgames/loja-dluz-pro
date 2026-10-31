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

  // Identificar se é o Orbix Player (Windows ou Linux) ou Canal Dark 100% Automático
  const isOrbixWindows = (order.items || []).some(
    (item) =>
      item.slug === "dluz-orbix-setup-leve" ||
      item.sku === "DLUZ-ORBIX-SETUP" ||
      item.product_id === 2950 ||
      item.id === 2950 ||
      String(item.name || "").toLowerCase().includes("orbix player para windows") ||
      String(item.name || "").toLowerCase().includes("orbix setup")
  );

  const isOrbixLinux = (order.items || []).some(
    (item) =>
      item.slug === "orbix-player-para-linux" ||
      item.sku === "DLUZ-ORBIX-LINUX" ||
      item.product_id === 2960 ||
      item.id === 2960 ||
      String(item.name || "").toLowerCase().includes("orbix player para linux")
  );

  const isOrbix = isOrbixWindows || isOrbixLinux || (order.items || []).some(
    (item) => String(item.name || "").toLowerCase().includes("orbix")
  );

  const isCanalDark = (order.items || []).some(
    (item) =>
      item.slug === "canal-dark-100-automatico" ||
      item.sku === "DLUZ-CANAL-DARK-AUTO" ||
      item.product_id === 2970 ||
      item.id === 2970 ||
      String(item.name || "").toLowerCase().includes("canal dark")
  );

  const isDluzMusic = (order.items || []).some(
    (item) =>
      item.slug === "dluz-music-pro" ||
      item.sku === "DLUZ-MUSIC-PRO-V1" ||
      item.product_id === 2980 ||
      item.id === 2980 ||
      String(item.name || "").toLowerCase().includes("music pro") ||
      String(item.name || "").toLowerCase().includes("dluz music")
  );

  let generatedKey = order.license_key || "";
  let whatsappStatus = "pending";
  let licenseResData = null;

  let canalDarkApiToken = "";

  if (isDluzMusic) {
    generatedKey = "DLUZ-MUSIC-PRO-VITALICIO";
    licenseResData = {
      type: "dluz_music_pro",
      serial: generatedKey,
      status: "ativa",
      plano: "vitalicio"
    };
  } else if (isOrbix) {
    // 2.A. EMISSÃO OFICIAL DO SERIAL DO ORBIX PLAYER (ECDSA P-256) - VÁLIDO PARA WINDOWS & LINUX
    try {
      const orbixLic = await obterOuCriarLicencaOrbix(order);
      generatedKey = orbixLic.serial;
      licenseResData = {
        type: isOrbixWindows ? "orbix_windows_serial" : "orbix_linux_serial",
        serial: generatedKey,
        numero: orbixLic.numero,
        status: orbixLic.status
      };
    } catch (err) {
      console.error(`[Fulfillment] Erro ao emitir serial do Orbix Player para pedido #${order.id}:`, err.message);
      generatedKey = `ORBX-PENDENTE-${order.id}`;
    }
  } else if (isCanalDark) {
    // 2.B. EMISSÃO DO PACOTE CANAL DARK 100% AUTOMÁTICO + API 18 MESES
    const crypto = require("crypto");
    const randHex1 = crypto.randomBytes(4).toString("hex").toUpperCase();
    const randHex2 = crypto.randomBytes(4).toString("hex").toUpperCase();
    generatedKey = `DLUZ-DARK-${randHex1}-${randHex2}`;
    canalDarkApiToken = `DARK-18M-${order.id}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    licenseResData = {
      type: "canal_dark_suite",
      key: generatedKey,
      api_token: canalDarkApiToken,
      api_months: 18
    };
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

      if (isOrbixWindows) {
        message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🪟

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *${order.id}* (*Orbix Player para Windows*) foi aprovado com sucesso!

━━━━━━━━━━━━━━━━━━━━
🔑 *SEU SERIAL OFICIAL ORBIX PLAYER (VITALÍCIO):*
\`${generatedKey}\`
━━━━━━━━━━━━━━━━━━━━

📦 *SEU LINK EXCLUSIVO DE DOWNLOAD (WINDOWS):*
🪟 *Instalador de Arquivo Único (Windows 10 & 11 64 bits):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/exe

🐧 *(Seu serial também é válido no Linux! Os instaladores .deb e .tar.gz estão disponíveis na tela do seu pedido).*

📖 *PASSO A PASSO PARA INSTALAR NO WINDOWS:*
1. Baixe *DLuz-Orbix-Setup.exe* pelo link acima e abra.
2. Se aparecer a mensagem *"O Windows protegeu o computador"*, clique em *Mais informações → Executar assim mesmo* (o instalador ainda não tem certificado comercial, mas é 100% oficial e seguro).
3. Clique em *Instalar*. O instalador baixa o emulador e a imagem Android 17 (~2,7 GB) sozinho diretamente do Google. Se a internet oscilar, ele continua de onde parou.
4. Se o instalador avisar que o *WHPX* (Plataforma do Hipervisor do Windows) está desligado, clique no botão para ligar e *reinicie o Windows*.
5. Abra o *Orbion* pela Área de Trabalho, cole o serial acima (começando em \`ORBX-\`) e clique em *Ativar*.
6. O primeiro boot do Android leva de 3 a 5 minutos para configuração inicial de root e perfil de performance. As próximas aberturas levam ~1 minuto!

💡 *DICAS E REQUISITOS:*
- Requer Windows 10/11 64 bits com WHPX ativado.
- Recomendado ter ~25 GB livres em disco para o Android e seus jogos.

⭐ *SUPORTE & COMUNIDADE:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, fale direto conosco aqui no WhatsApp! Bom jogo! 🚀🎮🔥`;
      } else if (isOrbixLinux) {
        message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🐧

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *${order.id}* (*Orbix Player para Linux*) foi aprovado com sucesso!

━━━━━━━━━━━━━━━━━━━━
🔑 *SEU SERIAL OFICIAL ORBIX PLAYER (LINUX & WINDOWS):*
\`${generatedKey}\`
━━━━━━━━━━━━━━━━━━━━

📦 *SEUS LINKS EXCLUSIVOS DE DOWNLOAD:*
🐧 *Instalador Ubuntu, Pop!_OS, Mint, Debian, Zorin (.deb):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/deb

📦 *Outras Distribuições Linux (.tar.gz):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/tar

🪟 *Versão Windows (DLuz-Orbix-Setup.exe):*
https://loja.dluz.com.br/download/orbix-player/${order.order_key}/exe

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
      } else if (isDluzMusic) {
        message = `Fala, *${order.first_name}*! 🚀
Seu pedido do *DLuz Music Pro (Licença Vitalícia)* foi aprovado com sucesso!

🎵 O streaming sem anúncios definitivo já está liberado para você.

📥 *Links de Download Direto do APK Oficial:*
• Versão Principal Otimizada (arm64): https://loja.dluz.com.br/download/dluz-music-pro/${order.order_key}/arm64
• Versão Universal Android: https://loja.dluz.com.br/download/dluz-music-pro/${order.order_key}/universal

🔑 *Status:* Ativação Vitalícia Confirmada
📖 *Como instalar:* Basta baixar o arquivo .apk no seu celular Android, autorizar a instalação e curtir suas músicas sem limites e sem anúncios!

⭐ *SUPORTE & COMUNIDADE:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, é só nos chamar por aqui. Bem-vindo à DLuz Games! 🚀🎵🔥`;
      } else if (isCanalDark) {
        message = `👋 Olá, *${order.first_name}*! Tudo bem? Aqui é da equipe *DLuz Games*! 🚀🎬

Muito obrigado pela sua compra na nossa Loja Oficial! Seu pedido *#${order.id}* (*Canal Dark 100% Automático*) foi aprovado com sucesso!

━━━━━━━━━━━━━━━━━━━━
🔑 *SUA CHAVE DE ATIVAÇÃO VITALÍCIA (SUITE DARK):*
\`${generatedKey}\`

⚡ *SUA CHAVE DA API DE IA (18 MESES GRÁTIS INCLUSOS):*
\`${canalDarkApiToken || "DARK-API-18M-ATIVADA"}\`
━━━━━━━━━━━━━━━━━━━━

📦 *SEUS SOFTWARES & PRODUTOS INCLUSOS:*
1. 🎙️ *Clonador e Sintetizador de Voz Neural Studio* (Voz ultra-realista)
2. 🎮 *Downloader Inteligente de Gameplays 4K 60FPS* (Sem comentários)
3. 🎬 *Extrator de Notícias, Mídias e B-Rolls* (Vídeos de alta retenção)
4. 🎵 *Gerador de Trilhas com Sound Vacuum* (Áudio dinâmico)
5. ✂️ *Editor de Vídeo Profissional* (Cortes secos e legendas cinéticas)
6. ⚡ *Acesso Completo à API Oficial por 18 Meses 100% Grátis*

📥 *ACESSO & DOWNLOAD DO PACOTE COMPLETO:*
https://loja.dluz.com.br/download/canal-dark/${order.order_key}/suite

📖 *COMO ATIVAR:*
1. Acesse o link acima para baixar os softwares e instaladores.
2. Ative as ferramentas com sua Chave de Ativação Vitalícia PRO.
3. Insira sua chave de API para desbloquear 18 meses de inteligência artificial ilimitada.

⭐ *SUPORTE & COMUNIDADE DE CRIADORES DARK:*
💬 Discord VIP: https://discord.gg/r2tUSVnkn2
🌐 Portal Oficial: https://dluzgames.com.br

Qualquer dúvida, fale conosco aqui no WhatsApp! Bons vídeos e muito sucesso no seu canal! 🚀🎬🔥`;
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
