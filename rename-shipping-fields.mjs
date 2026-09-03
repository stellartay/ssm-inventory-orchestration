#!/usr/bin/env node
/**
 * Renomeia "Units per box" para "Number of packages" e marca os 3 campos de
 * dimensao como nao utilizados.
 *
 * Contexto: a logistica confirmou que no formulario da UPS eles informam
 * apenas peso e quantidade, nunca dimensoes. Parcel Type passa a ser so
 * Pak (SIM/A1 Chip ate 100 un.) ou Package (todo o resto), e o numero de
 * pacotes e informado pela logistica no ticket.
 *
 * Renomear campo custom NAO muda o customfield_ID.
 *
 * Uso:
 *   node rename-shipping-fields.mjs           # dry run
 *   node rename-shipping-fields.mjs --apply
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

const RENAMES = [
  {
    id: "customfield_10975",
    name: "Number of packages",
    description:
      "How many packages logistics actually packed for this shipment. " +
      "Filled by logistics before closing the packing ticket. The backend " +
      "creates this many packages in the Zoho shipment and splits the total " +
      "weight across them.",
    searcherKey: NUMBER_SEARCHER,
  },

  // Os 3 de dimensao ficaram sem uso. Renomeados com prefixo UNUSED para que
  // ninguem os adicione a um formulario por engano. Nao deletados porque
  // campo deletado no Jira vai para "Deleted fields" e nao desaparece.
  {
    id: "customfield_10972",
    name: "UNUSED Box length cm",
    description:
      "NOT IN USE. Created 2026-08-31 when the plan was to declare package " +
      "dimensions to UPS. Logistics confirmed they only provide weight and " +
      "quantity, so this is unused. Do not add to any form. Safe to delete " +
      "once confirmed nothing references it.",
    searcherKey: NUMBER_SEARCHER,
  },
  {
    id: "customfield_10973",
    name: "UNUSED Box width cm",
    description: "NOT IN USE. See UNUSED Box length cm.",
    searcherKey: NUMBER_SEARCHER,
  },
  {
    id: "customfield_10974",
    name: "UNUSED Box height cm",
    description: "NOT IN USE. See UNUSED Box length cm.",
    searcherKey: NUMBER_SEARCHER,
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

  for (const f of RENAMES) {
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

  if (APPLY) {
    console.log(
      "\nCampos ativos do fluxo de frete:\n" +
        "  customfield_10971  Shipping service     (formulario inicial)\n" +
        "  customfield_10975  Number of packages   (ticket de packing)\n" +
        "\nFALTA MANUAL:\n" +
        "  1. Associar os dois ao field configuration scheme do SSM\n" +
        "  2. Adicionar 'Shipping service' ao apply-form.mjs e reaplicar,\n" +
        "     LEMBRANDO de reanexar o formulario depois\n" +
        "  3. Validador 'Validate details' na transicao Finish exigindo\n" +
        "     Number of packages, nos work types de packing"
    );
  }
}

main().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
