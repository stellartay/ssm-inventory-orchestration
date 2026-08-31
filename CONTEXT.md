# SSM Inventory Orchestration — Contexto e Especificação

Versão 4. Substitui v1, v2 e v3.
Fonte de verdade das decisões. Não reabrir decisão travada sem confirmação
explícita do dono do projeto.

Levantado e construído entre 2026-08-25 e 2026-08-31.

---

## 1. Objetivo

Cliente interno solicita hardware ou eSIM via portal do Jira Service Management.
O sistema verifica disponibilidade no Zoho Inventory, reserva o estoque, abre a
cadeia de work items de fulfillment conforme a composição do pedido, e dá baixa
no inventário quando o último ticket da cadeia fecha.

---

## 2. Roteamento

Regras avaliadas **nesta ordem**, sobre o conjunto de `routing_class` presentes
no pedido. A primeira que casar vence.

| # | Condição | Cadeia de tickets |
|---|---|---|
| 1 | Pelo menos uma linha `globble` | `Pick & Provisioning` → (ao fechar) → `Logistics Pack` |
| 2 | Contém `esim` **e** `physical`, sem `globble` | `A1 Allocation` + `Pick & Pack` em paralelo |
| 3 | Somente `esim` | `A1 Allocation` |
| 4 | Somente `physical` | `Pick & Pack` |

- **Regra 1 absorve o eSIM.** Provisionar um GLOBBLE inclui atribuir a
  conectividade. Linhas de eSIM nunca chegam ao Pack.
- **O Logistics Pack é sequencial**, criado quando o `Pick & Provisioning` fecha.
- **Regra 2 gera dois shipments parciais** contra o mesmo Sales Order.
- **O Pack não revalida estoque.** O committed stock protege desde o SO.
- **Quantidades duplicadas somam**, em vez de violar a unique constraint.
- **Política de disponibilidade: tudo ou nada.** Se qualquer linha faltar, nada
  é reservado, e o comentário lista **todas** as faltas de uma vez.

---

## 3. `item_map` completo

Os 9 itens, com ids reais confirmados via API em 2026-08-31.

| `zoho_item_id` | `display_name` | `routing_class` | `jira_qty_field` |
|---|---|---|---|
| `1262780000000063138` | GLOBBLE 4G Black | globble | `customfield_10890` |
| `1262780000000063156` | GLOBBLE 4G Regolith | globble | `customfield_10923` |
| `1262780000000063176` | GLOBBLE 5G Black | globble | `customfield_10924` |
| `1262780000000063166` | GLOBBLE 5G Regolith | globble | `customfield_10925` |
| `1262780000000063186` | GLOBBLE Regolith WiFi Only | globble | `customfield_10926` |
| `1262780000000063199` | SIM Card | physical | `customfield_10927` |
| `1262780000000069101` | A1 eSIM | esim | `customfield_10928` |
| `1262780000000069142` | A1 Chip | physical | `customfield_10929` |
| `1262780000000069074` | Teltonika 5G Antennas | physical | `customfield_10930` |

Estoque em 2026-08-31: SIM Card 1938, A1 eSIM 260, GLOBBLE 4G Black 130,
GLOBBLE 5G Regolith 98, GLOBBLE 4G Regolith 13, GLOBBLE 5G Black 3,
Teltonika 2, **A1 Chip 0**, **GLOBBLE Regolith WiFi Only 0**.

Nenhum item tem SKU. **Mapear por `item_id`, nunca por SKU.**

> ### O estoque vem como float
> A API retorna `260.0`, `3.0`, `1938.0`. São unidades inteiras, mas serializadas
> como decimal. Não comparar por igualdade exata. Arredondar ou usar `Math.floor`
> antes de qualquer comparação `qty > stock`, senão casos de borda dão resultado
> errado.

---

## 4. Campo de estoque correto

O Zoho rastreia contábil e físico separadamente:
- **Shipment Order** move o físico
- **Invoice** move o contábil

Como a decisão é usar apenas Shipment, usar **`actual_available_stock`**.
O `available_stock` (contábil) retorna número inflado que nunca desce.

---

## 5. Zoho Inventory

| | |
|---|---|
| Datacenter | **EU** |
| API base | `https://www.zohoapis.eu/inventory/v1` |
| OAuth | `https://accounts.zoho.eu/oauth/v2/token` |
| API Console | `https://api-console.zoho.eu` |
| `organization_id` | `20117600647` |
| Contato interno | `Internal IT Requests` · `1262780000000074002` |
| Location | Siège social, única. Id em `ZOHO_LOCATION_ID` |
| UPS | integração nativa conectada. **Não** integrar a API da UPS |

Scopes concedidos e confirmados na resposta do token:
```
ZohoInventory.items.READ
ZohoInventory.salesorders.CREATE
ZohoInventory.salesorders.UPDATE
ZohoInventory.packages.CREATE
ZohoInventory.shipmentorders.CREATE
```

Escopo mínimo de propósito. `/locations` e `/settings/*` retornam
`code: 57 not authorized`, o que é esperado. Se precisar, exige novo grant.

### Endereço, mapeamento até a UPS

| Campo Jira | `shipping_address` Zoho | UPS |
|---|---|---|
| Recipient name | `attention` | ShipTo Name |
| Address line 1 | `address` | AddressLine1 |
| Address line 2 | `street2` | AddressLine2 |
| City | `city` | City |
| State or region | `state` | StateProvinceCode |
| Postal code | `zip` | PostalCode |
| Country | `country` | CountryCode (ISO alpha-2) |
| Phone | `phone` | Phone |

O campo Country guarda `"FR - France"`. Cortar no primeiro espaço para o ISO.

---

## 6. Jira

Site: `https://stellartelecommunications.atlassian.net`
Projeto: **SSM**, Jira Service Management, **company-managed**
`cloudId`: `8cb90050-eca2-4420-b374-653bcc86c1d5`

### Work types (subtask, level -1)

| Nome | Id |
|---|---|
| Pick & Provisioning | `10375` |
| Logistics Pack | `10376` |
| Pick & Pack | `10377` |
| A1 Allocation | `10378` |

### Workflow

`SSM: Logistics Fulfilment` · `b1d13f71-ac61-4170-b59e-e2b8f42e3756`

```
START → Open → (Start work) → In Progress → (Finish) → Done
```

Done não tem transição de saída: ticket fechado não reabre, e a baixa acontece
exatamente uma vez.

- **Status id do Done: `10004`.** Usar o ID nos triggers, **nunca** o nome. O
  site tem Done, Closed, Completed e Cancelled convivendo, e dois status
  distintos chamados "Work in progress".
- Workflow scheme: `10164`, dedicado ao SSM
- Field configuration scheme: `2`, dedicado ao SSM
- Issue type scheme: `SSM: Jira Service Management Issue Type Scheme`, dedicado

### Request type

`Request hardware and eSIM` · id **`396`** · portal group **Logistics**
Work type: `[System] Service request`
Portal: `https://service.desk.stellar.tc/servicedesk/customer/portal/5/create/396`

### Campos custom

| Campo | Id | Tipo |
|---|---|---|
| Qty GLOBBLE 4G Black | `customfield_10890` | number |
| Qty GLOBBLE 4G Regolith | `customfield_10923` | number |
| Qty GLOBBLE 5G Black | `customfield_10924` | number |
| Qty GLOBBLE 5G Regolith | `customfield_10925` | number |
| Qty GLOBBLE Regolith WiFi Only | `customfield_10926` | number |
| Qty SIM Card | `customfield_10927` | number |
| Qty A1 eSIM | `customfield_10928` | number |
| Qty A1 Chip | `customfield_10929` | number |
| Qty Teltonika 5G Antennas | `customfield_10930` | number |
| Recipient name | `customfield_10931` | short text |
| Address line 1 | `customfield_10932` | short text |
| Address line 2 | `customfield_10933` | short text |
| City | `customfield_10934` | short text |
| State or region | `customfield_10935` | short text |
| Postal code | `customfield_10936` | short text |
| Phone | `customfield_10937` | short text |
| Country | `customfield_10938` | select list |

---

## 7. Formulário

Id: `83f310f0-7073-4418-873d-2de7da845ecc`
20 perguntas, 4 seções, 3 condições, 17 ligações. Definido em `apply-form.mjs`.

Os 3 toggles são form-only de propósito: só revelam seções. **Somente perguntas
fora de seção podem ser gatilho de condição.**

```bash
node apply-form.mjs            # dry run + sanity check
node apply-form.mjs --apply    # PUT do design completo
# reanexar na tela            <-- OBRIGATORIO
node form-sync.mjs --inspect   # confere as 17 ligacoes
```

> ### O PUT do design derruba o anexo ao request type
>
> Descoberto empiricamente, não documentado. Depois de **todo**
> `apply-form.mjs --apply`, o formulário some do request type 396 e precisa ser
> reanexado: Space settings → Request types → Request hardware and eSIM → Forms
> → Attach form → Select existing → Add → Save changes.
>
> Se esquecido, o portal mostra apenas o campo Summary, o requisitante envia um
> pedido vazio, e o backend recebe zero linhas **sem nenhum erro**.
>
> O `portalRequestTypeIds` da API **não** reflete esse anexo de forma confiável
> (fica `[]` mesmo anexado). Verificar na tela ou no portal.

### Schema do design da Forms API

Extraído do tenant, ausente da documentação pública:

| | |
|---|---|
| `type: "no"` | number |
| `type: "cs"` | radio |
| `type: "ts"` | short text |
| `type: "cd"` | dropdown |
| `validation.rq` | response required |
| `validation.wh` | whole numbers only |
| `jiraField` | a ligação, **default é não ligar** |
| `layout[0]` | conteúdo fora de seção |
| `layout[i]` | conteúdo da seção `i` |
| `sections[i].conditions` | ids das condições aplicadas |

Condição:

```json
{
  "21": {
    "i": {
      "co": { "cIds": { "1": ["1"] } },
      "operator": "OR",
      "groups": [{ "operator": "AND",
        "checks": [{ "fieldId": "1", "type": "SOME_OF", "constraint": ["1"] }] }]
    },
    "o": { "sIds": ["1"], "t": "sh" }
  }
}
```

---

## 8. Infra

| | |
|---|---|
| Repo | `github.com/stellartay/ssm-inventory-orchestration` |
| Vercel | `ssm-inventory-orchestration.vercel.app`, team Stellar, plano **Hobby** |
| Supabase | região **West EU (Paris)** |

Vercel Function Region deve ser EU (fra1 ou cdg1). Zoho está em EU e os usuários
em Paris; US-East adicionaria ~150ms por chamada no caminho crítico.

**Deployment Protection precisa estar desligada** em produção, senão o Jira
Automation recebe tela de login em vez de chamar o endpoint. É a causa mais
comum de webhook que dá timeout sem explicação.

**Hobby limita Vercel Cron a 1x/dia.** O `/api/availability-sync` roda diário em
vez de por hora. Não quebra nada: o `/api/reserve` continua sendo a autoridade.

### Env vars, todas configuradas

```
ZOHO_CLIENT_ID                (sensitive)
ZOHO_CLIENT_SECRET            (sensitive)
ZOHO_REFRESH_TOKEN            (sensitive)
ZOHO_ORGANIZATION_ID=20117600647
ZOHO_INTERNAL_CONTACT_ID=1262780000000074002
ZOHO_LOCATION_ID
JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
JIRA_CLOUD_ID=8cb90050-eca2-4420-b374-653bcc86c1d5
JIRA_SERVICE_ACCOUNT_EMAIL
JIRA_API_TOKEN                (sensitive)
JIRA_WEBHOOK_HMAC_SECRET      (sensitive)
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY     (sensitive)
```

O refresh token do Zoho não expira, mas o Zoho limita access tokens gerados em
janelas curtas. Cachear em `zoho_token` e reusar até expirar, com lock para não
disparar refresh concorrente.

`JIRA_API_TOKEN` é hoje um **token pessoal**, não de conta de serviço. Ver §11.

---

## 9. Schema Supabase

```sql
create table item_map (
  zoho_item_id     text primary key,
  display_name     text not null,
  routing_class    text not null
                   check (routing_class in ('globble','esim','physical')),
  jira_qty_field   text not null,
  location_id      text,
  active           boolean not null default true
);

create table requests (
  id            uuid primary key default gen_random_uuid(),
  parent_key    text not null unique,
  zoho_so_id    text,
  route         text check (route in ('globble','esim_plus_physical','esim_only','physical_only')),
  status        text not null default 'pending'
                check (status in ('pending','reserved','fulfilled','cancelled','failed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table request_lines (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  zoho_item_id  text not null references item_map(zoho_item_id),
  qty           int  not null check (qty > 0),
  unique (request_id, zoho_item_id)
);

create table tickets (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  issue_key     text not null unique,
  kind          text not null
                check (kind in ('pick_provisioning','logistics_pack','pick_pack','allocation')),
  status        text not null default 'open'
                check (status in ('open','closed')),
  created_at    timestamptz not null default now()
);

create table shipment_ledger (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references requests(id),
  ticket_id         uuid references tickets(id),
  zoho_item_id      text not null,
  qty               int  not null,
  zoho_shipment_id  text not null,
  tracking_number   text,
  shipped_at        timestamptz not null default now()
);

create table zoho_token (
  id            int primary key default 1 check (id = 1),
  access_token  text,
  expires_at    timestamptz
);
```

`tickets` permite saber quando a cadeia terminou, essencial na rota 2.
`shipment_ledger` alimenta a reconciliação contábil futura. Não remover.

---

## 10. Endpoints

Cinco, todos com HMAC em header, secret em `JIRA_WEBHOOK_HMAC_SECRET`.
Base: `https://ssm-inventory-orchestration.vercel.app`

### `POST /api/reserve`
Trigger: pai criado no request type 396.

1. Lê os 9 campos de quantidade do issue, monta linhas com os não vazios
2. Valida o endereço. Se incompleto, comenta e encerra **antes** de reservar
3. Adquire advisory locks de todas as linhas, **ordenados por `zoho_item_id`**
4. Lê `actual_available_stock` de cada item (cuidado com float, §3)
5. Se qualquer linha faltar: comenta listando **todas** as faltas, encerra sem
   criar Sales Order
6. Cria SO com N linhas e `shipping_address`, então
   `POST /salesorders/{id}/status/confirmed`
7. Resolve a rota (§2) e cria os tickets iniciais

### `POST /api/advance`
Trigger: `Pick & Provisioning` (`10375`) movido para status `10004`.
Cria o `Logistics Pack` (`10376`) como filho do mesmo pai.

### `POST /api/fulfill`
Trigger: ticket terminal (`10376`, `10377` ou `10378`) movido para `10004`.

- `logistics_pack` / `pick_pack`: Package das linhas físicas, Shipment Order
  **com UPS**, captura tracking, grava no ledger, comenta no pai
- `allocation`: Shipment Order **sem transportadora**, só linhas `esim`, sem etiqueta
- Rota 2 roda duas vezes: dois shipments parciais no mesmo SO, payload por linha
- Se todos os tickets da request estão `closed`, marca `fulfilled` e sinaliza no pai

### `POST /api/cancel`
Trigger: pai movido para Cancelled.
`POST /salesorders/{id}/status/void`, libera a reserva.
Sem isso o estoque fica preso em committed em todo ticket abandonado.

### `POST /api/availability-sync`
Vercel Cron. Reescreve a **descrição do campo** de itens com disponíveis,
indisponíveis e timestamp. Não alterar o label das opções: o label é o mesmo
objeto nos tickets históricos e mudá-lo reescreveria o histórico.

---

## 11. Concorrência

Janela de 1 a 2 segundos entre o `GET /items` e o SO confirmado. Serializar com
advisory lock por item, dentro de uma função Postgres:

```sql
select pg_advisory_xact_lock(hashtext(p_zoho_item_id));
```

Disponível real = `actual_available_stock` do Zoho − linhas `pending` locais.

Tudo ou nada: adquirir o lock de **todas** as linhas antes de checar qualquer
uma, **ordenados por `zoho_item_id`** para evitar deadlock entre pedidos com os
mesmos itens em ordem inversa.

---

## 12. Riscos aceitos

**Divergência contábil.** Shipment sem Invoice: o contábil não desce e diverge
do físico progressivamente. Aceito pelo dono. **Não** escrever job de
reconciliação antes de testar como `inventoryadjustments` interage com o split:
se mexer nos dois, o job derrubaria o físico de novo e criaria erro pior.

**Etiqueta UPS não validada.** Conta conectada, mas o setup do Zoho pede só o
account number. Não foi confirmado que conta UPS francesa gera etiqueta com
origem na França. Validar com Shipment de teste **antes** do handler do Pack.
Se falhar, avaliar EasyPost (nativo no Zoho, sem código).

**Formulário sem prova ponta a ponta.** As 17 ligações estão confirmadas na
configuração, mas nenhum ticket real foi verificado.

**Contato interno sem endereço.** `Internal IT Requests` não tem billing nem
shipping address, porque o endereço real vem do formulário a cada pedido. Se o
Zoho exigir billing address na criação do SO, o `/api/reserve` falha com erro
possivelmente pouco óbvio. Correção: adicionar Siège social como billing.

**Token pessoal do Jira.** Toda ação da automação aparece como feita pelo dono
da conta, e os endpoints param de escrever quando o token for revogado ou a
conta desativada. Aceito para validar o fluxo. Trocar por conta dedicada antes
de considerar produção.

**Itens em zero.** A1 Chip e GLOBBLE Regolith WiFi Only. Com tudo ou nada,
qualquer pedido que os inclua trava inteiro. Evitar no ticket de teste.

**Estoque baixo.** Teltonika em 2, GLOBBLE 5G Black em 3.

**Campos órfãos.** `Amount of eSIM` e `Amount of Physical SIM` duplicam
`Qty A1 eSIM` e `Qty SIM Card`. Mantidos porque servem o `Request New SIM`.
Limpar após a depreciação.

---

## 13. Pendências

### Bloqueiam o teste ponta a ponta
- [ ] Ticket de teste pelo portal com todos os campos, e
      `form-sync.mjs --verify <chave>`
- [ ] Validar etiqueta UPS com Sales Order, Package e Shipment de teste feitos
      à mão. Confirmar de passagem se o Zoho exige `location_id` no payload

### Backend
- [ ] Migrations, cliente Zoho com refresh e lock, cliente Jira, HMAC
- [ ] 5 endpoints
- [ ] `scripts/seed-item-map.ts` populando `item_map` (§3)
- [ ] Melhorar `form-sync.mjs --verify`: validar que o issue é do request type
      396 e tem formulário anexado antes de julgar campos vazios. Hoje aponta
      para qualquer ticket e conclui erradamente que a ligação quebrou

### Jira
- [ ] 4 regras de automation, uma por trigger, cada uma um Send web request
      com header HMAC
- [ ] Depreciar `Request New GLOBBLE` e `Request New SIM`, replicando as
      restrictions do segundo

### Decisões abertas
- [ ] O pai fecha automático ou um humano fecha? Muda se a conta precisa de
      permissão de transição
- [ ] Validação de endereço: só presença dos obrigatórios, ou formato de código
      postal por país?
- [ ] Lista final de países no `customfield_10938`. Hoje tem 15 que eu propus,
      confirmar se batem com os destinos reais

---

## 14. Resolvidas

- [x] Issue type, workflow e field config schemes do SSM são dedicados
- [x] UPS via integração nativa do Zoho, sem código de transportadora
- [x] eSIM é `routing_class` própria, não "software" nem "digital"
- [x] Datacenter Zoho é EU, confirmado pelo `api_domain` do token
- [x] Multi-linha sem repetição nativa no JSM: 9 campos de quantidade mais
      toggles condicionais
- [x] Schema do design da Forms API, incluindo condições
- [x] O PUT do design derruba o anexo ao request type
- [x] Os 9 `item_id` reais, confirmados por API
- [x] Estoque vem como float
- [x] As 13 env vars configuradas no Vercel
