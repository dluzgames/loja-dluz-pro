#!/usr/bin/env node
/**
 * Script Oficial de Cadastro e Sincronização da Chave Privada Orbix Player
 * Uso:
 *   node scripts/cadastrar-chave-orbix.js <caminho_do_arquivo.pem ou texto_pem>
 */

const fs = require('fs');
const path = require('path');
const { salvarChavePrivadaOrbix, consultarStatusChaveOrbix, OFICIAL_PUBLIC_KEY_B64 } = require('../src/services/orbix-license');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log('------------------------------------------------------------');
    console.log('Status Atual do Motor de Licenças Orbix:');
    const status = await consultarStatusChaveOrbix();
    console.log(JSON.stringify(status, null, 2));
    console.log('------------------------------------------------------------');
    console.log('Uso: node scripts/cadastrar-chave-orbix.js <caminho_para_arquivo.pem>');
    process.exit(0);
  }

  let pemContent = '';
  if (fs.existsSync(arg)) {
    console.log(`Lendo arquivo PEM de: ${arg}`);
    pemContent = fs.readFileSync(arg, 'utf-8');
  } else if (arg.includes('BEGIN PRIVATE KEY') || arg.includes('BEGIN EC PRIVATE KEY')) {
    pemContent = arg;
  } else {
    console.error(`Erro: Arquivo não encontrado e argumento não parece ser um PEM: ${arg}`);
    process.exit(1);
  }

  console.log('Validando e cadastrando chave privada...');
  try {
    const res = await salvarChavePrivadaOrbix(pemContent);
    console.log('\n============================================================');
    console.log('RESULTADO DO CADASTRO:');
    console.log(`Sucesso: ${res.success}`);
    console.log(`Casa com a Chave Pública Oficial: ${res.matchesOfficial ? 'SIM (100% compatível)' : 'NÃO (divergência detectada)'}`);
    console.log(`Chave Pública Derivada: ${res.derivedPublicKey}`);
    console.log(`Chave Pública Oficial:  ${OFICIAL_PUBLIC_KEY_B64}`);
    console.log(`Sincronizado com Coolify API: ${res.coolifySync ? 'SIM' : 'FALHA: ' + res.coolifyError}`);
    console.log(`Mensagem: ${res.message}`);
    console.log('============================================================\n');
  } catch (err) {
    console.error('Erro ao cadastrar chave:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Falha fatal:', err);
  process.exit(1);
});
