# SSM Inventory Orchestration — Contexto e Especificação

Versão 2. Substitui integralmente a v1.
Handoff para implementação. Este documento é a fonte de verdade das decisões.
Não reabrir decisões travadas sem confirmação explícita do dono do projeto.

Levantamento feito em 2026-08-25.

> **Mudança relevante em relação à v1:** o eixo de roteamento não é
> físico versus digital. É a classe do item. O modelo `fulfillment_mode`
> com valores `physical`/`digital`/`unlimited` foi **descartado**.

---

## 1. Objetivo

Cliente interno solicita hardware ou eSIM via portal do Jira Service Management.
O sistema verifica disponibilidade no Zoho Inventory, reserva o estoque, abre a
cadeia de work items de fulfillment conforme a composição do pedido, e dá baixa
no inventário quando o último ticket da cadeia fecha.

---

## 2. Classificação dos itens

Cada item tem uma `routing_class`. É ela que decide a cadeia de tickets.

| `routing_class` | Itens |
|---|---|
| `globble` | GLOBBLE 4G Black, 4G Regolith, 5G Black, 5G Regolith, Regolith WiFi Only |
| `esim` | A1 eSIM |
| `physical` | SIM Card, A1 Chip, Teltonika 5G Antennas |

---

## 3. Regras de roteamento

Avaliadas **nesta ordem**, sobre o conjunto de classes presentes no pedido.
A primeira que casar vence.

| # | Condição | Cadeia de tickets |
|---|---|---|
| 1 | Contém pelo menos uma linha `globble` | `Pick & Provisioning` → (ao fechar) → `Pack` |
| 2 | Contém `esim` **e** `physical`, sem `globble` | `Alocação A1` + `Pick & Pack` em paralelo |
| 3 | Somente `esim` | `Alocação A1` |
| 4 | Somente `physical` | `Pick & Pack` |

Notas que não são óbvias no diagrama:

- **Regra 1 absorve o eSIM.** Se o pedido tem GLOBBLE e eSIM, as linhas de eSIM
  são consumidas dentro do Provisioning (provisionar o device inclui atribuir a
  conectividade). Elas **nunca** chegam ao Pack.
- **O Pack é sequencial**, criado só quando o `Pick & Provisioning` fecha.
  É uma regra de automation separada, não um filho criado na reserva.
- **Regra 2 gera dois tickets paralelos.** O pai só avança quando os dois fecham,
  e isso produz **dois shipments parciais contra o mesmo Sales Order** (ver §7).
- **O Pack não revalida estoque.** O committed stock já protege as linhas desde
  o Sales Order confirmado. Nada pode ser tomado por outro pedido no meio.

---

## 4. Ambiente confirmado

### Zoho Inventory
- Datacenter: **EU**
- API base: `https://www.zohoapis.eu/inventory/v1`
- OAuth base: `https://accounts.zoho.eu/oauth/v2/token`
- API Console: `https://api-console.zoho.eu`
- `organization_id`: `20117600647`
- Org: Stellar Telecommunications
- Locale: francês. Conta de inventário "Équipement en stock". Valoração FIFO
- Location única: **Siège social**
- **UPS: integração nativa do Zoho, conectada.** Não integrar a API da UPS

Scopes OAuth necessários:
```
ZohoInventory.items.READ
ZohoInventory.salesorders.CREATE
ZohoInventory.salesorders.UPDATE
ZohoInventory.packages.CREATE
ZohoInventory.shipmentorders.CREATE
```

### Jira
- Site: `https://stellartelecommunications.atlassian.net`
- Projeto: **SSM**, Jira Service Management, **company-managed**
- `SSM: Jira Service Management Issue Type Scheme` é **dedicado ao SSM**.
  Pode criar work types novos sem afetar PoC Management ou JSM Implementation Project
- Work types atuais: Task, `[System] Service request`, Sub-task,
  `[System] Incident`, `[System] Service request with approvals`
- Workflow único hoje: `SSM: Service Request Fulfilment workflow for Jira Service Management`
- Portal group **Logistics** já existe
- Request types a depreciar depois de validar: `Request New GLOBBLE`, `Request New SIM`
  (o segundo tem restrictions aplicadas, replicar no novo)

### Itens

Nenhum item tem SKU preenchido. **Mapear sempre por `item_id`, nunca por SKU.**

| Item | Stock on hand (25/08) | `routing_class` |
|---|---|---|
| SIM Card | 1938 | physical |
| A1 eSIM | 260 | esim |
| GLOBBLE 4G Black | 130 | globble |
| GLOBBLE 5G Regolith | 98 | globble |
| GLOBBLE 4G Regolith | 13 | globble |
| GLOBBLE 5G Black | 3 | globble |
| Teltonika 5G Antennas | 2 | physical |
| A1 Chip | 0 | physical |
| GLOBBLE Regolith WiFi Only | 0 | globble |

`item_id` conhecido: A1 eSIM = `1262780000000069101`.
Os demais vêm do script de seed, não hardcodar.

---

## 5. Campo de estoque correto

O Zoho rastreia estoque **contábil** e **físico** separadamente, e eles se movem
por eventos diferentes:

- Shipment Order → move o **físico**
- Invoice → move o **contábil**

Como a decisão é usar apenas Shipment, a checagem de disponibilidade **deve** usar
`actual_available_stock` (base física). Usar `available_stock` (base contábil)
retorna um número inflado que nunca desce.

---

## 6. Schema Supabase

```sql
create table item_map (
  zoho_item_id   text primary key,
  display_name   text not null,
  routing_class  text not null
                 check (routing_class in ('globble','esim','physical')),
  location_id    text,
  active         boolean not null default true
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
                check (kind in ('pick_provisioning','pack','pick_pack','allocation')),
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

A tabela `tickets` é o que permite saber se a cadeia terminou. Sem ela não há
como decidir quando o pai pode fechar no caso da regra 2.

`shipment_ledger` alimenta a reconciliação contábil futura sem depender de
contagem física. Não remover.

---

## 7. Endpoints

Cinco, todos autenticados por HMAC em header, secret compartilhado com o
Jira Automation.

### `POST /api/reserve`
Trigger: pai criado no request type novo.
Payload: `{ parentKey, lines: [{ zohoItemId, qty }] }`

1. Adquire advisory locks de todas as linhas, **ordenados por `zoho_item_id`**
2. Lê `actual_available_stock` de cada item
3. Se qualquer linha faltar: comenta no pai listando **todas** as faltas de uma
   vez, encerra sem criar Sales Order
4. Se tudo disponível: cria SO com N linhas, `POST /salesorders/{id}/status/confirmed`
5. Resolve a rota conforme §3 e cria os tickets iniciais dessa rota

### `POST /api/advance`
Trigger: `Pick & Provisioning` fechado.
Cria o ticket `Pack` como filho do mesmo pai. É o único passo sequencial da cadeia.

### `POST /api/fulfill`
Trigger: ticket terminal fechado (`pack`, `pick_pack` ou `allocation`).

- `pack` / `pick_pack`: cria Package das linhas físicas, cria Shipment Order **com
  UPS**, captura o tracking number, grava em `shipment_ledger`, comenta no pai
- `allocation`: cria Shipment Order **sem transportadora** apenas para as linhas
  `esim`. Não gera etiqueta. O Zoho aceita shipment manual sem carrier
- Na rota `esim_plus_physical` isso roda duas vezes, produzindo dois shipments
  parciais contra o mesmo Sales Order. O payload precisa ser por linha, não pelo
  SO inteiro
- Depois de gravar: se todos os tickets da `request` estão `closed`, marca a
  request como `fulfilled` e sinaliza no pai

### `POST /api/cancel`
Trigger: pai movido para Cancelled.
`POST /salesorders/{id}/status/void`, libera a reserva, marca `cancelled`.
Sem este endpoint o estoque fica preso em committed para sempre em todo ticket
abandonado.

### `POST /api/availability-sync`
Vercel Cron. Lê os 9 itens e reescreve a **descrição do campo** de itens no
request type via Jira REST, separando disponíveis de indisponíveis com o número
atual e o timestamp.

Não alterar o label das opções: o label é o mesmo objeto nos tickets históricos,
e mudá-lo reescreveria o histórico.

Cron por hora exige Vercel Pro. No Hobby cai para 1x/dia. O backend continua
sendo a autoridade: item que zerou entre dois ciclos é reprovado no `/api/reserve`.

---

## 8. Concorrência

Entre o `GET /items` e o Sales Order confirmado há uma janela de 1 a 2 segundos.
Dois pedidos simultâneos do mesmo item passariam os dois pela checagem.

Serializar com advisory lock por item, dentro de uma função Postgres:

```sql
select pg_advisory_xact_lock(hashtext(p_zoho_item_id));
```

Disponível real = `actual_available_stock` do Zoho − soma das linhas `pending`
locais que ainda não viraram SO confirmado.

Como a política é tudo ou nada: adquirir o lock de **todas** as linhas antes de
checar qualquer uma, **ordenados por `zoho_item_id`** para evitar deadlock entre
dois pedidos com os mesmos itens em ordem inversa.

---

## 9. Riscos conhecidos e aceitos

**Divergência contábil.** Com Shipment sem Invoice, o estoque contábil não desce.
Físico e contábil divergem progressivamente. Aceito pelo dono, a reconciliar
depois. **Não** escrever job de reconciliação automática antes de testar
empiricamente como `inventoryadjustments` interage com o split contábil/físico:
se ele mexer nos dois, o job derrubaria o físico de novo e criaria erro pior.

**Etiqueta UPS não validada ponta a ponta.** A conta está conectada, mas o setup
do Zoho pede só o account number. Não foi confirmado que uma conta UPS francesa
gera etiqueta com origem na França pela integração nativa. Validar com um
Shipment de teste **antes** de escrever o handler do Pack. Se falhar, avaliar
EasyPost (também nativo no Zoho, sem código).

**Ambiguidade de status no Jira.** O projeto usa Done, Closed, Completed e
Cancelled simultaneamente. Os triggers devem usar **status ID**, nunca o nome.

**Itens em zero.** A1 Chip e GLOBBLE Regolith WiFi Only estão em 0. Com tudo ou
nada, qualquer pedido que os inclua trava inteiro. Estoque será normalizado em breve.

**Estoque baixo.** Teltonika em 2 e GLOBBLE 5G Black em 3. Pedidos combinados
vão reprovar com frequência no começo.

---

## 10. Segurança

Nunca commitar. Tudo em env var no Vercel e `.env.local` no `.gitignore`:

```
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_REFRESH_TOKEN
ZOHO_ORGANIZATION_ID=20117600647
ZOHO_INTERNAL_CONTACT_ID
ZOHO_LOCATION_ID
JIRA_BASE_URL=https://stellartelecommunications.atlassian.net
JIRA_SERVICE_ACCOUNT_EMAIL
JIRA_API_TOKEN
JIRA_WEBHOOK_HMAC_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

O refresh token do Zoho não expira, mas o Zoho limita quantos access tokens ele
gera em janelas curtas. Cachear em `zoho_token` e reusar até expirar, com lock
para não disparar refresh concorrente.

---

## 11. Pendências antes da implementação

- [ ] Validar geração de etiqueta UPS com Shipment de teste (conta francesa)
- [ ] Criar contato interno no Zoho e capturar o `contact_id`
- [ ] Capturar o `location_id` de Siège social
- [ ] Confirmar o plano do Zoho (havia prompt de Upgrade) e o acesso à API
- [ ] Criar os 4 work types no scheme do SSM e definir os **status IDs** de fechamento
- [ ] Decidir se o pai fecha automaticamente ou se um humano fecha

## 12. Resolvidas

- [x] Issue type scheme do SSM é dedicado, pode criar work types direto
- [x] UPS via integração nativa do Zoho, sem código de transportadora
- [x] eSIM é `routing_class` própria, não "software" nem "digital"
- [x] Datacenter Zoho é EU
