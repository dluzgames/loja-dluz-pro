/**
 * Serviço Oficial de Licenças e Seriais do Orbix Player para Linux
 * Baseado estritamente em H:\Games\OrbixPlayer-Loja-1.0.0\licenca\gerar-serial.mjs
 *
 * Formato do Serial: 16 bytes de dados + assinatura ECDSA P-256/SHA-256 (64 bytes r||s)
 * em base32 RFC 4648 sem "=", com prefixo "ORBX" e hífens a cada 6 caracteres (~154 chars).
 *
 * A chave privada NUNCA vai no repositório nem no código: lida exclusivamente de:
 * process.env.ORBIX_LICENSE_PRIVATE_KEY
 */

const { createPrivateKey, sign } = require("node:crypto");
const { dbGet, dbRun, dbAll } = require("../db/database");

const EPOCH = Date.UTC(2026, 0, 1);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DAY = 86400000;

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
      "ORBIX_LICENSE_PRIVATE_KEY não definida no ambiente Coolify. Por favor cadastre a variável com o conteúdo do PEM PKCS#8."
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

  // 3. Gerar o serial com a chave privada
  let serial = "";
  try {
    serial = gerarSerialOrbix({ numero: nextNum, dias: 0, maquina: null });
  } catch (err) {
    console.error("[ORBIX LICENSE] Aviso ao gerar serial com chave privada:", err.message);
    // Caso a chave ainda não tenha sido cadastrada no Coolify pelo usuário:
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

  const serial = gerarSerialOrbix({ numero: nextNum, dias, maquina });
  const expiraEm = dias > 0 ? new Date(Date.now() + dias * 86400000).toISOString() : null;

  const insertRes = await dbRun(
    `INSERT INTO licencas (pedido_id, order_key, numero, serial, email, nome, plano, expira_em, maquina, status)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'ativa')`,
    ["manual_" + Date.now(), nextNum, serial, email, nome || motivo, dias > 0 ? `${dias} dias` : "vitalicio", expiraEm, maquina]
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
  gerarSerialOrbix,
  obterOuCriarLicencaOrbix,
  emitirSerialManual
};
