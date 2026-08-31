#!/usr/bin/env node
/**
 * Cria os campos custom do fluxo SSM x Zoho Inventory via Jira REST API
 * e grava os customfield ids em jira-fields.json.
 *
 * Uso:
 *   export JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
 *   export JIRA_EMAIL=seu.email@stellar...
 *   export JIRA_API_TOKEN=...            # id.atlassian.com/manage-profile/security/api-tokens
 *   node create-jira-fields.mjs          # dry run, nao escreve nada
 *   node create-jira-fields.mjs --apply  # cria de verdade
 *
 * Idempotente: campo que ja existe com o mesmo nome e reaproveitado, nao duplicado.
 *
 * NAO cria o "Qtd GLOBBLE 4G Black" (customfield_10890), que ja existe.
 */

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const APPLY = process.argv.includes("--apply");

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Faltam JIRA_BASE_URL, JIRA_EMAIL ou JIRA_API_TOKEN.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// EDITE AQUI: paises de destino. Codigo ISO 3166-1 alpha-2, que e o que a UPS
// aceita como CountryCode. Adicione ou remova conforme os destinos reais.
// ---------------------------------------------------------------------------
const COUNTRIES = [
  "FR - France",
  "DE - Germany",
  "AT - Austria",
  "BE - Belgium",
  "ES - Spain",
  "IT - Italy",
  "NL - Netherlands",
  "PT - Portugal",
  "PL - Poland",
  "CH - Switzerland",
  "GB - United Kingdom",
  "IE - Ireland",
  "SE - Sweden",
  "DK - Denmark",
  "US - United States",
];

const NUMBER = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const TEXT = "com.atlassian.jira.plugin.system.customfieldtypes:textfield";
const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";

const SEARCHER = {
  [NUMBER]: "com.atlassian.jira.plugin.system.customfieldtypes:exactnumber",
  [TEXT]: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
  [SELECT]: "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher",
};

const FIELDS = [
  // Quantidades por item. O nome depois do "Qtd " tem que casar com o
  // display_name em item_map, para o seed conseguir ligar campo a zoho_item_id.
  { name: "Qtd GLOBBLE 4G Regolith", type: NUMBER, desc: "Quantidade solicitada de GLOBBLE 4G Regolith." },
  { name: "Qtd GLOBBLE 5G Black", type: NUMBER, desc: "Quantidade solicitada de GLOBBLE 5G Black." },
  { name: "Qtd GLOBBLE 5G Regolith", type: NUMBER, desc: "Quantidade solicitada de GLOBBLE 5G Regolith." },
  { name: "Qtd GLOBBLE Regolith WiFi Only", type: NUMBER, desc: "Quantidade solicitada de GLOBBLE Regolith WiFi Only." },
  { name: "Qtd SIM Card", type: NUMBER, desc: "Quantidade solicitada de SIM Card." },
  { name: "Qtd A1 eSIM", type: NUMBER, desc: "Quantidade solicitada de A1 eSIM." },
  { name: "Qtd A1 Chip", type: NUMBER, desc: "Quantidade solicitada de A1 Chip." },
  { name: "Qtd Teltonika 5G Antennas", type: NUMBER, desc: "Quantidade solicitada de Teltonika 5G Antennas." },

  // Endereco de destino. Mapeia 1:1 para shipping_address do Sales Order do
  // Zoho, que alimenta a etiqueta UPS.
  { name: "Destinatario", type: TEXT, desc: "Nome de quem recebe. Vai para attention no Zoho e ShipTo Name na UPS." },
  { name: "Endereco linha 1", type: TEXT, desc: "Rua e numero. Vai para address no Zoho e AddressLine1 na UPS." },
  { name: "Endereco linha 2", type: TEXT, desc: "Complemento, opcional. Vai para street2 no Zoho e AddressLine2 na UPS." },
  { name: "Cidade", type: TEXT, desc: "Vai para city no Zoho e City na UPS." },
  { name: "Estado ou regiao", type: TEXT, desc: "Opcional. Obrigatorio para US, CA e IE. Vai para state e StateProvinceCode." },
  { name: "Codigo postal", type: TEXT, desc: "Vai para zip no Zoho e PostalCode na UPS." },
  { name: "Telefone", type: TEXT, desc: "Obrigatorio para envio internacional na UPS. Vai para phone." },
  { name: "Pais", type: SELECT, desc: "Codigo ISO alpha-2. Vai para country no Zoho e CountryCode na UPS.", options: COUNTRIES },
];

// ---------------------------------------------------------------------------

const auth = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

async function api(method, path, body) {
  const res = await fetch(`${BASE}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function findExisting(name) {
  const res = await api("GET", `/field/search?query=${encodeURIComponent(name)}&maxResults=50`);
  return (res.values || []).find((f) => f.name === name) || null;
}

async function addOptions(fieldId, options) {
  const ctx = await api("GET", `/field/${fieldId}/context`);
  const contextId = ctx.values?.[0]?.id;
  if (!contextId) throw new Error(`Sem context para ${fieldId}`);
  await api("POST", `/field/${fieldId}/context/${contextId}/option`, {
    options: options.map((value) => ({ value, disabled: false })),
  });
}

async function main() {
  console.log(APPLY ? "Modo APPLY: criando campos.\n" : "Dry run. Use --apply para criar.\n");

  const result = { "Qtd GLOBBLE 4G Black": "customfield_10890" };

  for (const f of FIELDS) {
    const existing = await findExisting(f.name);
    if (existing) {
      console.log(`= ja existe   ${f.name}  ->  ${existing.id}`);
      result[f.name] = existing.id;
      continue;
    }
    if (!APPLY) {
      console.log(`+ criaria     ${f.name}  (${f.type.split(":")[1]})`);
      continue;
    }
    const created = await api("POST", "/field", {
      name: f.name,
      description: f.desc,
      type: f.type,
      searcherKey: SEARCHER[f.type],
    });
    result[f.name] = created.id;
    console.log(`+ criado      ${f.name}  ->  ${created.id}`);

    if (f.options) {
      await addOptions(created.id, f.options);
      console.log(`  ${f.options.length} opcoes adicionadas`);
    }
  }

  if (APPLY) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("jira-fields.json", JSON.stringify(result, null, 2) + "\n");
    console.log("\njira-fields.json gravado.");
    console.log(
      "\nPROXIMO PASSO MANUAL: associar os campos ao field configuration\n" +
        "scheme do SSM. Jira admin > Fields > Field schemes >\n" +
        '"Jira Service Management Field Configuration Scheme for Space SSM".\n' +
        "Da para adicionar todos de uma vez nessa tela. Sem isso os campos\n" +
        "existem mas nao aparecem no projeto."
    );
  }
}

main().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
