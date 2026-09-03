#!/usr/bin/env node
/**
 * Cria os 4 campos custom que faltam para o fluxo de embalagem e frete.
 *
 *   Shipping service   -> formulario inicial, escolhido pelo cliente interno
 *   Length / Width / Height (cm) -> ticket de Pick, informados pela logistica
 *   Units per box      -> ticket de Pick
 *
 * Uso:
 *   export JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
 *   export JIRA_EMAIL=...
 *   export JIRA_API_TOKEN=...
 *   node create-shipping-fields.mjs          # dry run
 *   node create-shipping-fields.mjs --apply
 *
 * Idempotente: campo com o mesmo nome e reaproveitado.
 *
 * PASSO MANUAL DEPOIS: associar ao field configuration scheme do SSM em
 * Jira admin > Fields > Field schemes > "...for Space SSM" > Add fields.
 */

import { writeFileSync } from "node:fs";

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const APPLY = process.argv.includes("--apply");

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Faltam JIRA_BASE_URL, JIRA_EMAIL ou JIRA_API_TOKEN.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Servicos UPS. "Expedite" ainda NAO foi confirmado nesta conta: ele nao
// apareceu na cotacao domestica. Manter na lista porque a regra de destino
// fora da UE depende dele, mas validar antes de confiar.
// ---------------------------------------------------------------------------
const SERVICES = [
  "UPS Standard",
  "UPS Saver",
  "UPS Express",
];

const NUMBER = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const SELECT = "com.atlassian.jira.plugin.system.customfieldtypes:select";

const SEARCHER = {
  [NUMBER]: "com.atlassian.jira.plugin.system.customfieldtypes:exactnumber",
  [SELECT]: "com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher",
};

const FIELDS = [
  {
    name: "Shipping service",
    type: SELECT,
    options: SERVICES,
    desc:
      "UPS service chosen by the requester. Destinations outside Europe are " +
      "always shipped as Expedite, overriding this choice.",
  },
  {
    name: "Box length cm",
    type: NUMBER,
    desc: "Box length in centimetres, provided by logistics. Feeds the UPS label.",
  },
  {
    name: "Box width cm",
    type: NUMBER,
    desc: "Box width in centimetres, provided by logistics. Feeds the UPS label.",
  },
  {
    name: "Box height cm",
    type: NUMBER,
    desc: "Box height in centimetres, provided by logistics. Feeds the UPS label.",
  },
  {
    name: "Units per box",
    type: NUMBER,
    desc:
      "How many units fit in one box, provided by logistics. The backend " +
      "computes the number of boxes as ceil(qty / units per box).",
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

async function findExisting(name) {
  const r = await api("GET", `/field/search?query=${encodeURIComponent(name)}&maxResults=50`);
  return (r.values || []).find((f) => f.name === name) || null;
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
  console.log(APPLY ? "Modo APPLY.\n" : "Dry run. Use --apply para criar.\n");
  const result = {};

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
    writeFileSync("shipping-fields.json", JSON.stringify(result, null, 2) + "\n");
    console.log("\nshipping-fields.json gravado.");
    console.log(
      "\nFALTA MANUAL:\n" +
        "  1. Associar os 5 campos ao field configuration scheme do SSM\n" +
        "     (Jira admin > Fields > Field schemes > ...for Space SSM)\n" +
        "  2. Adicionar 'Shipping service' ao formulario em apply-form.mjs\n" +
        "     e reaplicar, LEMBRANDO de reanexar o formulario depois\n" +
        "  3. Adicionar os 4 campos de caixa aos work types de Pick, e criar\n" +
        "     o validador de workflow que os torna obrigatorios no Done"
    );
  }
}

main().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
