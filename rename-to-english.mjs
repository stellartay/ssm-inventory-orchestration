#!/usr/bin/env node
/**
 * Renomeia para ingles os campos custom e os work types criados em portugues
 * no fluxo SSM x Zoho Inventory.
 *
 * Renomear campo custom NAO muda o customfield_ID, entao nada quebra.
 *
 * Uso:
 *   export JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
 *   export JIRA_EMAIL=...
 *   export JIRA_API_TOKEN=...
 *   node rename-to-english.mjs           # dry run
 *   node rename-to-english.mjs --apply
 */

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const APPLY = process.argv.includes("--apply");

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Faltam JIRA_BASE_URL, JIRA_EMAIL ou JIRA_API_TOKEN.");
  process.exit(1);
}

const NUMBER_SEARCHER = "com.atlassian.jira.plugin.system.customfieldtypes:exactnumber";
const TEXT_SEARCHER = "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher";
const SELECT_SEARCHER = "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher";

const FIELD_RENAMES = [
  { id: "customfield_10890", name: "Qty GLOBBLE 4G Black", description: "Requested quantity of GLOBBLE 4G Black.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10923", name: "Qty GLOBBLE 4G Regolith", description: "Requested quantity of GLOBBLE 4G Regolith.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10924", name: "Qty GLOBBLE 5G Black", description: "Requested quantity of GLOBBLE 5G Black.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10925", name: "Qty GLOBBLE 5G Regolith", description: "Requested quantity of GLOBBLE 5G Regolith.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10926", name: "Qty GLOBBLE Regolith WiFi Only", description: "Requested quantity of GLOBBLE Regolith WiFi Only.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10927", name: "Qty SIM Card", description: "Requested quantity of SIM Card.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10928", name: "Qty A1 eSIM", description: "Requested quantity of A1 eSIM.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10929", name: "Qty A1 Chip", description: "Requested quantity of A1 Chip.", searcherKey: NUMBER_SEARCHER },
  { id: "customfield_10930", name: "Qty Teltonika 5G Antennas", description: "Requested quantity of Teltonika 5G Antennas.", searcherKey: NUMBER_SEARCHER },

  { id: "customfield_10931", name: "Recipient name", description: "Who receives the shipment. Maps to attention in Zoho and ShipTo Name in UPS.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10932", name: "Address line 1", description: "Street and number. Maps to address in Zoho and AddressLine1 in UPS.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10933", name: "Address line 2", description: "Optional. Maps to street2 in Zoho and AddressLine2 in UPS.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10934", name: "City", description: "Maps to city in Zoho and City in UPS.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10935", name: "State or region", description: "Optional. Required for US, CA and IE. Maps to state and StateProvinceCode.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10936", name: "Postal code", description: "Maps to zip in Zoho and PostalCode in UPS.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10937", name: "Phone", description: "Required by UPS for international shipments. Maps to phone.", searcherKey: TEXT_SEARCHER },
  { id: "customfield_10938", name: "Country", description: "ISO 3166-1 alpha-2 code. Maps to country in Zoho and CountryCode in UPS.", searcherKey: SELECT_SEARCHER },
];

const TYPE_RENAMES = [
  {
    from: "Pick & Provisioning",
    name: "Pick & Provisioning",
    description: "Pick and provision GLOBBLE devices. Created for the SSM x Zoho Inventory automation.",
  },
  {
    from: "Logistics Pack",
    name: "Logistics Pack",
    description: "Pack the shipment and generate the UPS label. Created for the SSM x Zoho Inventory automation.",
  },
  {
    from: "Pick & Pack",
    name: "Pick & Pack",
    description: "Pick and pack without provisioning. Created for the SSM x Zoho Inventory automation.",
  },
  {
    from: "Alocação A1",
    name: "A1 Allocation",
    description: "Allocate eSIM profiles in the A1 portal. Created for the SSM x Zoho Inventory automation.",
  },
];

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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log(APPLY ? "Modo APPLY.\n" : "Dry run. Use --apply para aplicar.\n");

  console.log("CAMPOS");
  for (const f of FIELD_RENAMES) {
    if (!APPLY) {
      console.log(`  ~ ${f.id}  ->  ${f.name}`);
      continue;
    }
    try {
      await api("PUT", `/field/${f.id}`, {
        name: f.name,
        description: f.description,
        searcherKey: f.searcherKey,
      });
      console.log(`  ok ${f.id}  ->  ${f.name}`);
    } catch (e) {
      console.error(`  FALHOU ${f.id}: ${e.message}`);
    }
  }

  console.log("\nWORK TYPES");
  const all = await api("GET", "/issuetype");
  for (const t of TYPE_RENAMES) {
    const found = all.find((x) => x.name === t.from);
    if (!found) {
      console.error(`  nao encontrado: ${t.from}`);
      continue;
    }
    if (!APPLY) {
      console.log(`  ~ ${found.id} "${t.from}"  ->  "${t.name}"`);
      continue;
    }
    try {
      await api("PUT", `/issuetype/${found.id}`, {
        name: t.name,
        description: t.description,
      });
      console.log(`  ok ${found.id}  ->  ${t.name}`);
    } catch (e) {
      console.error(`  FALHOU ${t.from}: ${e.message}`);
    }
  }

  if (APPLY) {
    console.log(
      "\nFALTA UM ITEM MANUAL: a descricao do workflow\n" +
        '"SSM: Logistics Fulfilment" ainda esta em portugues. A API de\n' +
        "workflow do Jira Cloud e complexa para uma edicao de texto, entao\n" +
        "e mais rapido editar na tela: Jira admin > Workflows > SSM: Logistics\n" +
        "Fulfilment. Os nomes das transicoes (Start work, Finish) e dos\n" +
        "status (Open, In Progress, Done) ja estao em ingles."
    );
  }
}

main().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
