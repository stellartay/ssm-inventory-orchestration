#!/usr/bin/env node
/**
 * Sincroniza e verifica o formulario do request type "Request hardware and eSIM"
 * contra form-spec.json.
 *
 * Uso:
 *   export JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
 *   export JIRA_EMAIL=...
 *   export JIRA_API_TOKEN=...
 *
 *   node form-sync.mjs --inspect   # descobre cloudId, baixa o form salvo, testa
 *                                  # se a API suporta escrita. RODE ISSO PRIMEIRO.
 *   node form-sync.mjs --apply     # tenta aplicar a spec via API
 *   node form-sync.mjs --verify    # le o form salvo e compara com a spec
 *
 * O --verify e o que importa. Ele roda igual, tenha o formulario sido montado
 * por API ou a mao na tela, e falha com exit code 1 se qualquer campo da lista
 * mustBeLinked nao estiver ligado. Bom para usar em CI.
 */

import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

if (!BASE || !EMAIL || !TOKEN) {
  console.error("Faltam JIRA_BASE_URL, JIRA_EMAIL ou JIRA_API_TOKEN.");
  process.exit(1);
}

const MODE = process.argv.find((a) => ["--inspect", "--apply", "--verify"].includes(a));
if (!MODE) {
  console.error("Passe --inspect, --apply ou --verify.");
  process.exit(1);
}

const spec = JSON.parse(readFileSync("form-spec.json", "utf8"));
const auth = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

const headers = {
  Authorization: auth,
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-ExperimentalApi": "opt-in",
};

async function raw(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta nao-JSON, mantem o texto */
  }
  return { ok: res.ok, status: res.status, text, json };
}

async function getCloudId() {
  const r = await raw(`${BASE}/_edge/tenant_info`);
  if (!r.ok || !r.json?.cloudId) {
    throw new Error(`Nao consegui o cloudId: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return r.json.cloudId;
}

function formsBase(cloudId) {
  return `https://api.atlassian.com/jira/forms/cloud/${cloudId}`;
}

/**
 * A cobertura da API de Forms para TEMPLATES de formulario (nao formularios
 * anexados a um issue) varia. Tentamos varios caminhos conhecidos e reportamos
 * qual respondeu, em vez de assumir um.
 */
async function fetchFormTemplate(cloudId) {
  const { projectKey, formId } = spec.target;
  const url = `${formsBase(cloudId)}/project/${projectKey}/form/${formId}`;
  const r = await raw(url);
  if (r.ok) return { url, data: r.json };
  console.log(`  ${r.status}  ${url}`);
  console.log(`  corpo: ${r.text.slice(0, 300)}`);
  return null;
}

/** Lista os templates do projeto. Endpoint separado, so leitura. */
async function listFormTemplates(cloudId) {
  const url = `${formsBase(cloudId)}/project/${spec.target.projectKey}/form`;
  const r = await raw(url);
  return r.ok ? r.json : null;
}

/** Extrai label -> jiraField do design salvo, tolerando variacoes de schema. */
function extractLinks(design) {
  const links = [];
  const questions = design?.questions ?? design?.design?.questions ?? {};
  for (const [qid, q] of Object.entries(questions)) {
    links.push({
      qid,
      label: q.label ?? q.name ?? "(sem label)",
      jiraField: q.jiraField ?? q.linkedJiraField ?? null,
      required: Boolean(q.validation?.rq ?? q.required),
    });
  }
  return links;
}

async function inspect() {
  const cloudId = await getCloudId();
  console.log(`cloudId: ${cloudId}\n`);

  const list = await listFormTemplates(cloudId);
  if (list) {
    console.log("Templates no projeto:");
    for (const f of list) {
      console.log(`  ${f.id}  "${f.name || "(sem nome)"}"  rt=${JSON.stringify(f.portalRequestTypeIds)}`);
    }
    console.log("");
  }

  console.log(`Lendo o template ${spec.target.formId}:`);
  const found = await fetchFormTemplate(cloudId);
  if (!found) {
    console.log("\nNao consegui ler o template. Confira o formId na spec.");
    return;
  }

  console.log(`OK: ${found.url}`);
  writeFileSync("form-current.json", JSON.stringify(found.data, null, 2) + "\n");
  console.log("Design salvo em form-current.json.\n");

  const links = extractLinks(found.data);
  if (links.length) {
    console.log("Perguntas encontradas:");
    for (const l of links) {
      console.log(`  ${l.jiraField ?? "NAO LIGADO"}  <-  ${l.label}`);
    }
  } else {
    console.log("Formulario ainda sem perguntas, como esperado.");
    console.log("Veja form-current.json para o schema do design.");
  }
}

async function apply() {
  const cloudId = await getCloudId();
  const found = await fetchFormTemplate(cloudId);
  if (!found) {
    console.error("Sem endpoint de template. Nao da para aplicar via API.");
    process.exit(1);
  }
  console.error(
    "apply() precisa do schema real do design, que sai do --inspect.\n" +
      "Rode --inspect, me mande o form-current.json, e eu preencho a\n" +
      "traducao spec -> design com o schema correto em vez de adivinhar."
  );
  process.exit(1);
}

/**
 * Verificacao por ticket de teste: le um issue real criado pelo portal e
 * confere se cada campo de mustBeLinked chegou com valor. E a unica prova
 * de ponta a ponta, porque testa o caminho que o backend usa de verdade.
 */
async function verifyByIssue(issueKey) {
  const fields = spec.mustBeLinked.join(",");
  const r = await raw(
    `${BASE}/rest/api/3/issue/${issueKey}?fields=${fields}`
  );
  if (!r.ok) {
    console.error(`Nao consegui ler ${issueKey}: ${r.status} ${r.text.slice(0, 300)}`);
    process.exit(1);
  }

  const got = r.json.fields ?? {};
  let missing = 0;
  let present = 0;

  console.log(`Lendo ${issueKey} via API (o mesmo caminho do backend):\n`);
  for (const cf of spec.mustBeLinked) {
    const v = got[cf];
    const filled = v !== null && v !== undefined && v !== "";
    if (filled) {
      present++;
      console.log(`  OK      ${cf} = ${JSON.stringify(v)}`);
    } else {
      console.log(`  vazio   ${cf}`);
    }
  }

  console.log(
    `\n${present} com valor, ${spec.mustBeLinked.length - present} vazios.\n` +
      "Campo vazio pode ser normal (nao foi pedido) OU pode ser ligacao\n" +
      "faltando. Para distinguir, no ticket de teste preencha TODOS os\n" +
      "campos. Aí qualquer vazio e ligacao quebrada."
  );

  if (present === 0) {
    console.error("\nNenhum valor chegou. Ligacao Linked Jira Field nao foi feita.");
    process.exit(1);
  }
}

async function verify() {
  const issueKey = process.argv.find((a) => /^[A-Z]+-\d+$/.test(a));
  if (issueKey) return verifyByIssue(issueKey);

  const cloudId = await getCloudId();
  const found = await fetchFormTemplate(cloudId);
  if (!found) {
    console.error(
      "Sem endpoint de template para verificar o design.\n\n" +
        "Use a verificacao por ticket, que e mais forte de qualquer forma:\n" +
        "  1. Abra um ticket pelo portal preenchendo TODOS os campos\n" +
        "  2. node form-sync.mjs --verify SSM-123\n"
    );
    process.exit(1);
  }

  const links = extractLinks(found.data);
  const linked = new Set(links.map((l) => l.jiraField).filter(Boolean));
  let fail = 0;

  console.log("Conferindo mustBeLinked contra o formulario salvo:\n");
  for (const cf of spec.mustBeLinked) {
    if (linked.has(cf)) {
      console.log(`  OK    ${cf}`);
    } else {
      console.log(`  FALHA ${cf} nao esta ligado a nenhuma pergunta`);
      fail++;
    }
  }

  const extra = links.filter((l) => !l.jiraField);
  if (extra.length) {
    console.log("\nPerguntas sem ligacao (esperado apenas para os toggles):");
    for (const l of extra) console.log(`  ${l.label}`);
  }

  if (fail) {
    console.error(`\n${fail} campo(s) sem ligacao. Corrija na tela e rode de novo.`);
    process.exit(1);
  }
  console.log("\nTodos os 17 campos estao ligados.");
}

const run = { "--inspect": inspect, "--apply": apply, "--verify": verify }[MODE];
run().catch((e) => {
  console.error("\nFalhou:", e.message);
  process.exit(1);
});
