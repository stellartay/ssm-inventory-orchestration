#!/usr/bin/env node
/**
 * Monta o design completo do formulario "Request hardware and eSIM" e aplica
 * via PUT na Forms API.
 *
 * Schema descoberto empiricamente no tenant (2026-08-31):
 *   type "no" = number, "cs" = radio, "ts" = short text, "cd" = dropdown
 *   validation.rq = response required, validation.wh = whole numbers only
 *   jiraField = a ligacao com o campo Jira
 *   layout = array de docs ADF. layout[0] = fora de secao,
 *            layout[i] = conteudo da secao i
 *   sections[i].conditions = onde a condicao mora (formato ainda desconhecido)
 *
 * Uso:
 *   node apply-form.mjs           # grava form-planned.json para revisao
 *   node apply-form.mjs --apply   # PUT de verdade
 *
 * O PUT substitui o design inteiro, entao e idempotente: rodar duas vezes
 * deixa no mesmo estado.
 */

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const APPLY = process.argv.includes("--apply");

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Faltam JIRA_BASE_URL, JIRA_EMAIL ou JIRA_API_TOKEN.");
  process.exit(1);
}

const PROJECT = "SSM";
const FORM_ID = "83f310f0-7073-4418-873d-2de7da845ecc";

// Precisa casar exatamente com as opcoes do campo Jira customfield_10938,
// senao o envio quebra. Edite aqui e no campo Jira ao mesmo tempo.
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

const yesNo = [
  { id: "1", label: "Yes", other: false },
  { id: "2", label: "No", other: false },
];

/** id -> pergunta. A ordem dos ids nao define a ordem visual, o layout define. */
const Q = {
  // toggles, form-only de proposito: nao viram campo Jira
  1: { type: "cs", label: "Do you need GLOBBLE devices?", choices: yesNo, rq: true },
  2: { type: "cs", label: "Do you need connectivity (SIM, eSIM or chip)?", choices: yesNo, rq: true },
  3: { type: "cs", label: "Do you need accessories?", choices: yesNo, rq: true },

  // GLOBBLE
  4: { type: "no", label: "GLOBBLE 4G Black", jiraField: "customfield_10890", wh: true },
  5: { type: "no", label: "GLOBBLE 4G Regolith", jiraField: "customfield_10923", wh: true },
  6: { type: "no", label: "GLOBBLE 5G Black", jiraField: "customfield_10924", wh: true },
  7: { type: "no", label: "GLOBBLE 5G Regolith", jiraField: "customfield_10925", wh: true },
  8: { type: "no", label: "GLOBBLE Regolith WiFi Only", jiraField: "customfield_10926", wh: true },

  // conectividade
  9: { type: "no", label: "SIM Card", jiraField: "customfield_10927", wh: true },
  10: { type: "no", label: "A1 eSIM", jiraField: "customfield_10928", wh: true },
  11: { type: "no", label: "A1 Chip", jiraField: "customfield_10929", wh: true },

  // acessorios
  12: { type: "no", label: "Teltonika 5G Antennas", jiraField: "customfield_10930", wh: true },

  // endereco de entrega, alimenta a etiqueta UPS
  13: { type: "ts", label: "Recipient name", jiraField: "customfield_10931", rq: true },
  14: { type: "ts", label: "Address line 1", jiraField: "customfield_10932", rq: true },
  15: { type: "ts", label: "Address line 2", jiraField: "customfield_10933" },
  16: { type: "ts", label: "City", jiraField: "customfield_10934", rq: true },
  17: { type: "ts", label: "Postal code", jiraField: "customfield_10936", rq: true },
  18: {
    type: "ts",
    label: "State or region",
    jiraField: "customfield_10935",
    description: "Required for US, CA and IE only.",
  },
  19: {
    type: "cd",
    label: "Country",
    jiraField: "customfield_10938",
    rq: true,
    choices: COUNTRIES.map((c, i) => ({ id: String(i + 1), label: c, other: false })),
  },
  20: {
    type: "ts",
    label: "Phone",
    jiraField: "customfield_10937",
    rq: true,
    description: "Required by UPS for international shipments.",
  },
};

const SECTIONS = {
  1: { name: "GLOBBLE devices", questions: [4, 5, 6, 7, 8] },
  2: { name: "Connectivity", questions: [9, 10, 11] },
  3: { name: "Accessories", questions: [12] },
  4: { name: "Delivery address", questions: [13, 14, 15, 16, 17, 18, 19, 20] },
};

/**
 * Condicoes: mostrar a secao quando o toggle for "Yes".
 * Formato extraido do tenant (2026-08-31):
 *   i.groups[].checks[] = { fieldId, type: "SOME_OF", constraint: [choiceId] }
 *   i.co.cIds = mapa redundante pergunta -> choices, o editor mantem os dois
 *   o = { sIds: [secoes afetadas], t: "sh" }  ("sh" = show)
 *
 * choiceId "1" = "Yes" (ver yesNo acima).
 * A secao 4 (Delivery address) fica sem condicao: sempre visivel.
 */
const CONDITIONS = [
  { id: "21", triggerQuestion: 1, sections: ["1"] },
  { id: "22", triggerQuestion: 2, sections: ["2"] },
  { id: "23", triggerQuestion: 3, sections: ["3"] },
];

const YES_CHOICE_ID = "1";

// layout[0] = fora de secao. Os toggles ficam aqui para estarem sempre visiveis.
const OUTSIDE = [1, 2, 3];

function buildQuestion(q) {
  const out = {
    description: q.description ?? "",
    label: q.label,
    questionKey: "",
    type: q.type,
    validation: { rq: Boolean(q.rq) },
  };
  if (q.jiraField) out.jiraField = q.jiraField;
  if (q.wh) out.validation.wh = true;
  if (q.choices) out.choices = q.choices;
  return out;
}

function adfDoc(questionIds) {
  return {
    version: 1,
    type: "doc",
    content: questionIds.map((id) => ({
      type: "extension",
      attrs: {
        extensionKey: "question",
        extensionType: "com.thinktilt.proforma",
        parameters: { id: Number(id) },
        text: "",
        layout: "default",
        localId: randomUUID(),
      },
    })),
  };
}

function buildDesign() {
  const questions = {};
  for (const [id, q] of Object.entries(Q)) questions[id] = buildQuestion(q);

  const conditions = {};
  const sectionConditions = {};
  for (const c of CONDITIONS) {
    const fieldId = String(c.triggerQuestion);
    conditions[c.id] = {
      i: {
        co: { cIds: { [fieldId]: [YES_CHOICE_ID] } },
        operator: "OR",
        groups: [
          {
            operator: "AND",
            checks: [{ fieldId, type: "SOME_OF", constraint: [YES_CHOICE_ID] }],
          },
        ],
      },
      o: { sIds: c.sections, t: "sh" },
    };
    for (const s of c.sections) {
      (sectionConditions[s] ??= []).push(c.id);
    }
  }

  const sections = {};
  for (const [id, s] of Object.entries(SECTIONS)) {
    sections[id] = {
      sectionType: "b",
      name: s.name,
      conditions: sectionConditions[id] ?? [],
    };
  }

  const layout = [adfDoc(OUTSIDE)];
  for (const id of Object.keys(SECTIONS)) {
    layout.push(adfDoc(SECTIONS[id].questions));
  }

  return {
    conditions,
    layout,
    questions,
    sections,
    settings: {
      name: "Request hardware and eSIM",
      submit: { lock: false, pdf: false },
      primaryLocale: "en-US",
      translatedLocale: "en-US",
    },
  };
}

function sanityCheck(design) {
  const problems = [];
  const referenced = new Set();
  for (const doc of design.layout) {
    for (const node of doc.content) referenced.add(String(node.attrs.parameters.id));
  }

  for (const id of Object.keys(design.questions)) {
    if (!referenced.has(id)) problems.push(`pergunta ${id} nao aparece no layout`);
  }
  for (const id of referenced) {
    if (!design.questions[id]) problems.push(`layout referencia pergunta ${id} inexistente`);
  }

  const linked = Object.values(design.questions).map((q) => q.jiraField).filter(Boolean);
  if (new Set(linked).size !== linked.length) {
    problems.push("dois campos Jira ligados a mais de uma pergunta");
  }
  if (linked.length !== 17) {
    problems.push(`esperava 17 campos ligados, encontrei ${linked.length}`);
  }

  // Condicoes: o gatilho tem que existir, ser choice, e estar FORA de secao,
  // porque o editor so aceita perguntas de nivel raiz como gatilho.
  for (const [cid, c] of Object.entries(design.conditions)) {
    for (const g of c.i.groups) {
      for (const chk of g.checks) {
        const q = design.questions[chk.fieldId];
        if (!q) {
          problems.push(`condicao ${cid} usa pergunta ${chk.fieldId} inexistente`);
          continue;
        }
        if (!["cs", "cd"].includes(q.type)) {
          problems.push(`condicao ${cid}: pergunta ${chk.fieldId} nao e choice`);
        }
        if (!OUTSIDE.includes(Number(chk.fieldId))) {
          problems.push(
            `condicao ${cid}: pergunta ${chk.fieldId} esta dentro de secao e nao pode ser gatilho`
          );
        }
        for (const cid2 of chk.constraint) {
          if (!(q.choices ?? []).some((ch) => ch.id === cid2)) {
            problems.push(`condicao ${cid}: choice ${cid2} nao existe na pergunta ${chk.fieldId}`);
          }
        }
      }
    }
    for (const sid of c.o.sIds) {
      if (!design.sections[sid]) problems.push(`condicao ${cid} aponta secao ${sid} inexistente`);
      else if (!design.sections[sid].conditions.includes(cid)) {
        problems.push(`secao ${sid} nao referencia a condicao ${cid}`);
      }
    }
  }
  return problems;
}

async function main() {
  const design = buildDesign();
  const problems = sanityCheck(design);

  console.log(`Perguntas: ${Object.keys(design.questions).length}`);
  console.log(`Secoes: ${Object.keys(design.sections).length}`);
  console.log(`Condicoes: ${Object.keys(design.conditions).length}`);
  console.log(`Docs de layout: ${design.layout.length}`);
  console.log(
    `Campos Jira ligados: ${Object.values(design.questions).filter((q) => q.jiraField).length}\n`
  );

  if (problems.length) {
    console.error("Problemas encontrados, nao vou aplicar:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("Sanity check passou.\n");

  writeFileSync("form-planned.json", JSON.stringify({ design }, null, 2) + "\n");
  console.log("Design gravado em form-planned.json.");

  if (!APPLY) {
    console.log("Dry run. Revise o arquivo e rode com --apply.");
    return;
  }

  const tenant = await fetch(`${BASE}/_edge/tenant_info`).then((r) => r.json());
  const url = `https://api.atlassian.com/jira/forms/cloud/${tenant.cloudId}/project/${PROJECT}/form/${FORM_ID}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-ExperimentalApi": "opt-in",
    },
    body: JSON.stringify({ design }),
  });

  const text = await res.text();
  console.log(`\nPUT -> ${res.status}`);
  if (!res.ok) {
    console.error(text.slice(0, 1500));
    process.exit(1);
  }
  console.log("Design aplicado, condicoes incluidas.\n");
  console.log("FALTA:");
  console.log("  1. Anexar o formulario ao request type 396 (editor do request type)");
  console.log("  2. Abrir um ticket de teste pelo portal preenchendo TODOS os campos");
  console.log("  3. node form-sync.mjs --verify SSM-XXX");
}

main().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
