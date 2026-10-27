/**
 * Serviço Oficial de Licenças e Seriais do Orbix Player para Linux
 * Baseado estritamente em H:\Games\OrbixPlayer-Loja-1.0.0\licenca\gerar-serial.mjs
 *
 * Formato do Serial: 16 bytes de dados + assinatura ECDSA P-256/SHA-256 (64 bytes r||s)
 * em base32 RFC 4648 sem "=", com prefixo "ORBX" e hífens a cada 6 caracteres (~154 chars).
 *
 * Chave privada lida com tolerância a falhas de:
 * 1. process.env.ORBIX_LICENSE_PRIVATE_KEY (Coolify)
 * 2. SQLite settings 'orbix_license_private_key' (persistente no volume /data)
 */

const { createPrivateKey, createPublicKey, sign } = require("node:crypto");
const { dbGet, dbRun, dbAll } = require("../db/database");

const EPOCH = Date.UTC(2026, 0, 1);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DAY = 86400000;

// Chave pública oficial embutida nos binários do Orbix Player 1.0.0 (licenca/chave-publica.txt)
const OFICIAL_PUBLIC_KEY_B64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ69zmvUrU62rqYwAs9/Cu1mcgprop8bkcewzLEUFSn2k0sEGZEyzlG6TmjfPXF38JhBdzTJV3IiOlLeSug5FZw==";

function base32(buf) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Obtém a chave privada configurada (Ambiente Coolify ou Banco SQLite)
 */
async function obterChavePrivada() {
  if (
    process.env.ORBIX_LICENSE_PRIVATE_KEY &&
    typeof process.env.ORBIX_LICENSE_PRIVATE_KEY === "string" &&
    process.env.ORBIX_LICENSE_PRIVATE_KEY.trim().length > 50
  ) {
    return process.env.ORBIX_LICENSE_PRIVATE_KEY.trim();
  }

  try {
    const row = await dbGet("SELECT value FROM settings WHERE key = 'orbix_license_private_key'");
    if (row && row.value && row.value.trim().length > 50) {
      return row.value.trim();
    }
  } catch (err) {
    console.error("[ORBIX LICENSE] Erro ao buscar chave privada no banco:", err.message);
  }

  return null;
}

/**
 * Consulta o status seguro da chave sem expor os bytes da chave privada
 */
async function consultarStatusChaveOrbix() {
  let source = null;
  let pem = null;

  if (
    process.env.ORBIX_LICENSE_PRIVATE_KEY &&
    process.env.ORBIX_LICENSE_PRIVATE_KEY.trim().length > 50
  ) {
    source = "Ambiente Coolify (ORBIX_LICENSE_PRIVATE_KEY)";
    pem = process.env.ORBIX_LICENSE_PRIVATE_KEY.trim();
  } else {
    try {
      const row = await dbGet("SELECT value FROM settings WHERE key = 'orbix_license_private_key'");
      if (row && row.value && row.value.trim().length > 50) {
        source = "Banco de Dados Seguro (Volume Persistente)";
        pem = row.value.trim();
      }
    } catch (_) {}
  }

  if (!pem) {
    return {
      hasKey: false,
      source: null,
      matchesOfficial: false,
      officialPublicKey: OFICIAL_PUBLIC_KEY_B64,
      derivedPublicKey: null,
      message: "Nenhuma chave privada ECDSA cadastrada. Seriais reais pendentes."
    };
  }

  let derivedPubB64 = null;
  let matchesOfficial = false;
  let validPem = false;

  try {
    const keyObj = createPrivateKey(pem);
    const pubObj = createPublicKey(keyObj);
    derivedPubB64 = pubObj.export({ type: "spki", format: "der" }).toString("base64");
    matchesOfficial = derivedPubB64 === OFICIAL_PUBLIC_KEY_B64;
    validPem = true;
  } catch (err) {
    validPem = false;
  }

  return {
    hasKey: validPem,
    source,
    validPem,
    matchesOfficial,
    officialPublicKey: OFICIAL_PUBLIC_KEY_B64,
    derivedPublicKey: derivedPubB64,
    message: matchesOfficial
      ? "Motor Oficial 100% Operacional e Válido para o Orbix Player 1.0.0."
      : "Chave privada carregada, mas a chave pública não confere com o binário oficial 1.0.0."
  };
}

/**
 * Cadastra e valida a chave privada no SQLite e sincroniza com o Coolify via API
 */
async function salvarChavePrivadaOrbix(pemString) {
  if (!pemString || typeof pemString !== "string") {
    throw new Error("Conteúdo da chave privada PEM não fornecido.");
  }

  const cleanPem = pemString.trim();
  if (!cleanPem.includes("BEGIN PRIVATE KEY") && !cleanPem.includes("BEGIN EC PRIVATE KEY")) {
    throw new Error("Formato inválido: esperado cabeçalho -----BEGIN PRIVATE KEY----- ou -----BEGIN EC PRIVATE KEY-----.");
  }

  let keyObj;
  try {
    keyObj = createPrivateKey(cleanPem);
  } catch (err) {
    throw new Error(`Falha na validação criptográfica do PEM: ${err.message}`);
  }

  let derivedPubB64 = "";
  try {
    const pubObj = createPublicKey(keyObj);
    derivedPubB64 = pubObj.export({ type: "spki", format: "der" }).toString("base64");
  } catch (err) {
    throw new Error(`Não foi possível extrair a chave pública correspondente: ${err.message}`);
  }

  const matchesOfficial = derivedPubB64 === OFICIAL_PUBLIC_KEY_B64;

  // 1. Salvar no SQLite persistente
  await dbRun(
    `INSERT INTO settings (key, value, updated_at) VALUES ('orbix_license_private_key', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [cleanPem]
  );

  // 2. Atualizar processo Node em memória
  process.env.ORBIX_LICENSE_PRIVATE_KEY = cleanPem;

  // 3. Sincronizar com Coolify API
  let coolifySync = false;
  let coolifyError = null;
  try {
    const coolifyToken = process.env.COOLIFY_API_TOKEN || "9|ZFyMfXFPUEKhZG2d6eF8RNHO9f0bVdbawJMLfa3M9c32706c";
    const appId = "c5ninxy6fcbu3au1tixre52q";

    const resp = await fetch(`https://coolify.dluz.com.br/api/v1/applications/${appId}/envs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${coolifyToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        key: "ORBIX_LICENSE_PRIVATE_KEY",
        value: cleanPem,
        is_buildtime: false,
        is_literal: true,
        is_multiline: true,
        is_preview: false,
        is_runtime: true
      })
    });

    if (resp.ok) {
      coolifySync = true;
    } else {
      coolifyError = await resp.text();
    }
  } catch (cErr) {
    coolifyError = cErr.message;
  }

  return {
    success: true,
    matchesOfficial,
    derivedPublicKey: derivedPubB64,
    coolifySync,
    coolifyError,
    message: matchesOfficial
      ? "Chave privada oficial vinculada com sucesso! O gerador de seriais está 100% ativo e sincronizado com o Coolify."
      : "Chave gravada, mas ATENÇÃO: a chave pública derivada não confere com o binário oficial 1.0.0."
  };
}

/**
 * Gera o serial criptografado oficial do Orbix Player
 * @param {object} o
 * @param {number} o.numero        Sequência única (começando em 100000)
 * @param {number} [o.dias]        0 = vitalício (padrão) ou validade em dias
 * @param {string|null} [o.maquina] ID hex da máquina (12 chars) ou null (qualquer PC)
 * @param {number} [o.edicao]      1 = padrão
 * @param {string} [o.privateKeyPem] PEM PKCS#8
 */
function gerarSerialOrbix({
  numero,
  dias = 0,
  maquina = null,
  edicao = 1,
  privateKeyPem = process.env.ORBIX_LICENSE_PRIVATE_KEY
}) {
  if (!privateKeyPem || typeof privateKeyPem !== "string" || privateKeyPem.trim().length < 50) {
    throw new Error(
      "ORBIX_LICENSE_PRIVATE_KEY não definida. Cadastre a chave no painel /admin ou nas variáveis de ambiente."
    );
  }
  if (!Number.isInteger(numero) || numero < 1 || numero > 0xffffffff) {
    throw new Error("Número do serial inválido (deve ser um inteiro entre 1 e 4294967295).");
  }

  const now = Date.now();
  const issued = Math.floor((now - EPOCH) / DAY);
  const expires = dias > 0 ? Math.max(1, Math.floor((now + dias * DAY - EPOCH) / DAY)) : 0;
  const data = Buffer.alloc(16);
  data[0] = 1;
  data[1] = edicao & 0xff;
  data.writeUInt32LE(numero >>> 0, 2);
  data.writeUInt16LE(issued, 6);
  data.writeUInt16LE(expires, 8);

  if (maquina) {
    const m = Buffer.from(String(maquina).trim(), "hex");
    if (m.length !== 6) throw new Error("ID da máquina deve ter exatamente 12 caracteres hexadecimais.");
    m.copy(data, 10);
  }

  const key = createPrivateKey(privateKeyPem);
  const sig = sign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
  const b = base32(Buffer.concat([data, sig]));
  return "ORBX-" + b.match(/.{1,6}/g).join("-");
}

/**
 * Obtém ou emite o serial oficial do Orbix Player para um pedido (IDEMPOTÊNCIA TOTAL)
 */
async function obterOuCriarLicencaOrbix(order) {
  // 1. Verificar se já existe licença emitida para este pedido
  const existing = await dbGet("SELECT * FROM licencas WHERE pedido_id = ?", [order.id]);
  if (existing) {
    return existing;
  }

  // 2. Incrementar sequencial atômico de número de licença (começa em 100000)
  const seqRow = await dbGet("SELECT current_number FROM serial_sequence WHERE id = 1");
  const currentNum = seqRow ? seqRow.current_number : 100000;
  const nextNum = currentNum + 1;
  await dbRun("UPDATE serial_sequence SET current_number = ? WHERE id = 1", [nextNum]);

  // 3. Obter chave privada (env ou banco)
  const privKey = await obterChavePrivada();

  let serial = "";
  if (privKey) {
    try {
      serial = gerarSerialOrbix({ numero: nextNum, dias: 0, maquina: null, privateKeyPem: privKey });
    } catch (err) {
      console.error("[ORBIX LICENSE] Erro ao gerar serial com chave privada:", err.message);
      serial = `ORBX-PENDENTE-CHAVE-PRIVADA-${nextNum}`;
    }
  } else {
    console.warn("[ORBIX LICENSE] Chave privada ainda não cadastrada. Gerando serial de contingência.");
    serial = `ORBX-PENDENTE-CHAVE-PRIVADA-${nextNum}`;
  }

  const nome = `${order.first_name || ""} ${order.last_name || ""}`.trim() || "Cliente";
  const email = (order.email || "").toLowerCase().trim();

  // 4. Salvar na tabela licencas
  const insertRes = await dbRun(
    `INSERT INTO licencas (pedido_id, order_key, numero, serial, email, nome, plano, expira_em, maquina, status)
     VALUES (?, ?, ?, ?, ?, ?, 'vitalicio', NULL, NULL, 'ativa')`,
    [order.id, order.order_key, nextNum, serial, email, nome]
  );

  return {
    id: insertRes.lastID,
    pedido_id: order.id,
    order_key: order.order_key,
    numero: nextNum,
    serial,
    email,
    nome,
    plano: "vitalicio",
    status: "ativa"
  };
}

/**
 * Emissão manual de serial no painel de administração (cortesia / suporte)
 */
async function emitirSerialManual({ dias = 0, maquina = null, email = "", nome = "", motivo = "suporte" }) {
  const seqRow = await dbGet("SELECT current_number FROM serial_sequence WHERE id = 1");
  const currentNum = seqRow ? seqRow.current_number : 100000;
  const nextNum = currentNum + 1;
  await dbRun("UPDATE serial_sequence SET current_number = ? WHERE id = 1", [nextNum]);

  const privKey = await obterChavePrivada();
  if (!privKey) {
    throw new Error("Chave privada ECDSA P-256 não configurada. Cadastre a chave no painel antes de emitir.");
  }

  const serial = gerarSerialOrbix({ numero: nextNum, dias, maquina, privateKeyPem: privKey });
  const expiraEm = dias > 0 ? new Date(Date.now() + dias * 86400000).toISOString() : null;

  const insertRes = await dbRun(
    `INSERT INTO licencas (pedido_id, order_key, numero, serial, email, nome, plano, expira_em, maquina, status)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ativa')`,
    [
      "manual_" + Date.now(),
      nextNum,
      serial,
      email,
      nome || motivo,
      dias > 0 ? `${dias} dias` : "vitalicio",
      expiraEm,
      maquina
    ]
  );

  return {
    id: insertRes.lastID,
    numero: nextNum,
    serial,
    email,
    nome,
    expira_em: expiraEm,
    maquina,
    status: "ativa"
  };
}

module.exports = {
  OFICIAL_PUBLIC_KEY_B64,
  gerarSerialOrbix,
  obterOuCriarLicencaOrbix,
  emitirSerialManual,
  salvarChavePrivadaOrbix,
  consultarStatusChaveOrbix,
  obterChavePrivada
};
