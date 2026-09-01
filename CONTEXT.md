# SSM Inventory Orchestration — Contexto e Especificação

Versão 5. Substitui v1 a v4.
Fonte de verdade das decisões. Não reabrir decisão travada sem confirmação
explícita do dono do projeto.

Construído e validado entre 2026-08-25 e 2026-08-31.
A v5 incorpora os achados do teste manual de ponta a ponta no Zoho e na UPS.

---

## 1. Objetivo

Cliente interno solicita hardware ou eSIM via portal do Jira Service Management.
O sistema verifica disponibilidade no Zoho Inventory, reserva o estoque, abre a
cadeia de work items de fulfillment conforme a composição do pedido, e dá baixa
no inventário quando o último ticket da cadeia fecha, gerando etiqueta UPS.

---

## 2. Roteamento

Regras avaliadas **nesta ordem**, sobre o conjunto de `routing_class` do pedido.

| # | Condição | Cadeia de tickets |
|---|---|---|
| 1 | Pelo menos uma linha `globble` | `Pick & Provisioning` → (ao fechar) → `Logistics Pack` |
| 2 | Contém `esim` **e** `physical`, sem `globble` | `A1 Allocation` + `Pick & Pack` em paralelo |
| 3 | Somente `esim` | `A1 Allocation` |
| 4 | Somente `physical` | `Pick & Pack` |

- **Regra 1 absorve o eSIM.** Linhas de eSIM nunca chegam ao Pack.
- **O Logistics Pack é sequencial**, criado quando o `Pick & Provisioning` fecha.
- **Regra 2 gera dois shipments parciais** contra o mesmo Sales Order.
- **O Pack não revalida estoque.** O committed protege desde o SO.
- **Quantidades duplicadas somam.**
- **Tudo ou nada:** se qualquer linha faltar, nada é reservado e o comentário
  lista **todas** as faltas de uma vez.

---

## 3. `item_map`

| `zoho_item_id` | `display_name` | `routing_class` | `jira_qty_field` | peso kg |
|---|---|---|---|---|
| `1262780000000063138` | GLOBBLE 4G Black | globble | `customfield_10890` | 1,68 |
| `1262780000000063156` | GLOBBLE 4G Regolith | globble | `customfield_10923` | 1,68 |
| `1262780000000063176` | GLOBBLE 5G Black | globble | `customfield_10924` | 1,68 |
| `1262780000000063166` | GLOBBLE 5G Regolith | globble | `customfield_10925` | 1,68 |
| `1262780000000063186` | GLOBBLE Regolith WiFi Only | globble | `customfield_10926` | 1,68 |
| `1262780000000063199` | SIM Card | physical | `customfield_10927` | 0,01 |
| `1262780000000069101` | A1 eSIM | esim | `customfield_10928` | n/a |
| `1262780000000069142` | A1 Chip | physical | `customfield_10929` | 0,01 |
| `1262780000000069074` | Teltonika 5G Antennas | physical | `customfield_10930` | 1,30 |

Estoque em 31/08: SIM Card 1938, A1 eSIM 260, GLOBBLE 4G Black 130,
GLOBBLE 5G Regolith 98, GLOBBLE 4G Regolith 13, GLOBBLE 5G Black 3,
Teltonika 2, **A1 Chip 0**, **GLOBBLE Regolith WiFi Only 0**.

Nenhum item tem SKU. **Mapear por `item_id`.**

---

## 4. Estoque: três coisas que só o teste revelou

### 4.1 O estoque vem como float
`260.0`, `1938.0`. Arredondar antes de comparar. Não usar igualdade exata.

### 4.2 `actual_available_stock` NÃO desconta o committed
Testado: com 1 unidade committed, `actual_available_stock` continuou 1938 e
`actual_committed_stock` foi para 1. **O campo ignora a reserva.**

```
disponível = actual_available_stock − actual_committed_stock − pendentes locais
```

Se o backend confiar apenas em `actual_available_stock`, ele nunca vê reservas
existentes e aprova pedidos além do estoque. Isso também protege contra reservas
criadas manualmente na tela do Zoho, fora da automação.

### 4.3 Confirmar SO não move estoque físico, deletar SO libera o committed
Testado nos dois sentidos. É o comportamento que o `/api/cancel` depende.
Em produção usar **Void** e não Delete: mantém rastro auditável e libera igual.

### 4.4 Os itens precisam de `can_be_sold = true`
Descoberto no teste: os 9 itens estavam com `can_be_sold` e `can_be_purchased`
em `false`. Item não vendável **não aparece em Sales Order e a API rejeita**.
Já corrigido manualmente nos 9, com `rate` 0. Se um item novo entrar no catálogo,
habilitar Sales Information ou o `/api/reserve` falha para ele.

Consequência aceita: os Sales Orders saem com total €0,00 e aparecem nos
relatórios de vendas como documentos de valor nulo. O Zoho pede confirmação de
"zero amount" na tela, mas **a API aceita direto**.

---

## 5. Zoho Inventory

| | |
|---|---|
| Datacenter | **EU** |
| API base | `https://www.zohoapis.eu/inventory/v1` |
| OAuth | `https://accounts.zoho.eu/oauth/v2/token` |
| `organization_id` | `20117600647` |
| Contato interno | `Internal IT Requests` · `1262780000000074002` |
| Location | Siège social, única. Preenchida automaticamente pelo Zoho |
| Endereço de origem | 1 Bis Chemin Bacchus, Bruges, Nouvelle-Aquitaine 33520, France |
| Telefone origem | 33-681312199 |

Scopes (mínimos, confirmados):
```
ZohoInventory.items.READ
ZohoInventory.salesorders.CREATE
ZohoInventory.salesorders.UPDATE
ZohoInventory.packages.CREATE
ZohoInventory.shipmentorders.CREATE
```

`/locations` e `/settings/*` retornam `code: 57`, esperado. `items.UPDATE` não
está concedido de propósito: o backend nunca escreve em itens.

### Numeração manual
A org usa numeração **manual** para Package e Shipment Order. O backend gera:
```
PKG-{parentKey}-{n}
SHP-{parentKey}-{n}
```
Rastreável até o ticket, ao contrário de um contador sequencial.

### Endereço de destino é obrigatório
O contato interno **não tem** billing nem shipping address. Sem
`shipping_address` no payload do Sales Order, o shipment não pode ser criado:
a tela mostra "Address cannot be empty". O `/api/reserve` **tem** que enviar.

Mapeamento confirmado um para um com o diálogo do Zoho:

| Campo Jira | Zoho | UPS |
|---|---|---|
| Recipient name `10931` | `attention` | ShipTo Name |
| Address line 1 `10932` | `address` | AddressLine1 |
| Address line 2 `10933` | `street2` | AddressLine2 (opcional) |
| City `10934` | `city` | City |
| State or region `10935` | `state` | StateProvinceCode |
| Postal code `10936` | `zip` | PostalCode |
| Country `10938` | `country` | CountryCode |
| Phone `10937` | `phone` | Phone |

> **O Zoho espera o nome do país, não o ISO.** O dropdown oferece "France".
> O campo Jira guarda `"FR - France"`. Enviar a parte **depois** do separador.
> (A v4 dizia o contrário e estava errado.)

---

## 6. UPS: validado, com requisitos que não estavam previstos

A integração nativa do Zoho funciona com a conta francesa. Testado: cotação real
de Bruges para Bruges retornou UPS Express €14,10, UPS Standard €7,07,
UPS Saver €10,97. **Não integrar a API da UPS.**

Fluxo: Validate Address → Create Shipment → Generate Label.

### 6.1 Peso e Parcel Type são obrigatórios
Sem os dois a UPS não gera etiqueta.

### 6.2 kg e cm têm que ser consistentes
A UPS rejeitou com: *"A shipment cannot have a KGS/IN or LBS/CM or OZS/CM as its
unit of measurements"*. O Zoho traz peso em **`lb`** por default e dimensão em
`cm`, combinação inválida. **O backend deve forçar `kg` e `cm` explicitamente.**

### 6.3 Parcel Type: só valores da UPS
As opções são `UPS Letter`, `Package`, `Tube`, `Pak`, `UPS Express Box`,
`UPS 10 KG Box®`, `Pallet`, `Specify custom dimensions`.
"Big box", "Medium box" e "envelope de bolha" **não existem**.

Regra decidida:

| Conteúdo | Parcel Type |
|---|---|
| Até 100 un. de SIM Card ou A1 Chip, sem outros itens | `Pak` |
| Todo o resto | `Specify custom dimensions` |

`Specify custom dimensions` exige Length, Width, Height obrigatórios, em cm.

### 6.4 Serviço de frete precisa ser escolhido
O backend não pode omitir. Decidido: **o cliente interno escolhe no formulário
inicial** (campo novo, dropdown Express / Standard / Saver).

**Exceção: destino fora da Europa usa sempre Expedite**, sobrepondo a escolha do
requisitante. Da lista atual de países, só os EUA se qualificam. O formulário
deve avisar que a escolha pode ser sobreposta.

> Pendente de validação: "Expedite" **não apareceu** na cotação doméstica. O
> UPS Worldwide Expedited provavelmente só aparece com destino internacional.
> Confirmar cotando um destino fora da UE antes de codificar essa regra.

### 6.5 N packages em um único shipment
A tela tem "1. ASSOCIATED PACKAGES" com "Add Package". Um shipment aceita vários
pacotes, então **um envio e um tracking number** mesmo com múltiplas caixas.

### 6.6 Billing Method
Default `Bill Shipper`: o frete é cobrado da conta da Stellar.

### 6.7 Outras opções relevantes
`Residential Delivery` provavelmente necessário para colaborador em casa, e
muda o preço. `Direct Delivery Only` e `Saturday Delivery` disponíveis.
Nenhuma dessas está decidida.

---

## 7. Regras de embalagem

**Peso do pacote** = Σ (`qty` × peso unitário), da tabela em §3.
Cobre automaticamente todas as combinações, incluindo pedidos mistos.

**Número de caixas:**
```
caixas = ceil(qty / unidades_por_caixa)
peso da caixa = unidades na caixa × peso unitário
```

O `unidades_por_caixa` é **informado pela logística no ticket de Pick**, não
fixado em regra. Motivo: as dimensões da caixa e o que cabe nela são
conhecimento de quem embala, e um número fixo envelheceria.

**SIM Card e A1 Chip:** até 100 un. em `Pak`, 1 pacote. De 101 a 2000, custom
dimensions, 1 pacote. Acima de 2000, 1 pacote a cada 2000. A 10g, 2000 unidades
dão 20 kg por caixa.

**Campos novos no ticket de Pick & Pack e Pick & Provisioning:**
Length, Width, Height (cm) e Unidades por caixa. **Obrigatórios na transição
para Done**, via validador de workflow, senão o `/api/fulfill` falha por falta
de dado.

---

## 8. Jira

Site: `https://stellartelecommunications.atlassian.net`
Projeto: **SSM**, JSM, **company-managed** · `cloudId` `8cb90050-eca2-4420-b374-653bcc86c1d5`

### Work types (subtask, level -1)

| Nome | Id |
|---|---|
| Pick & Provisioning | `10375` |
| Logistics Pack | `10376` |
| Pick & Pack | `10377` |
| A1 Allocation | `10378` |

### Workflow

`SSM: Logistics Fulfilment` · `b1d13f71-ac61-4170-b59e-e2b8f42e3756`
`Open → (Start work) → In Progress → (Finish) → Done`, sem saída de Done.

**Status id do Done: `10004`.** Usar o ID, nunca o nome: o site tem Done,
Closed, Completed e Cancelled convivendo, e dois status chamados
"Work in progress".

Workflow scheme `10164`, field config scheme `2`, ambos dedicados ao SSM.

### Request type

`Request hardware and eSIM` · id **`396`** · portal group **Logistics**
Portal: `https://service.desk.stellar.tc/servicedesk/customer/portal/5/create/396`

### Campos custom existentes

`customfield_10890` e `10923` a `10938`. Ver mapeamento em §3 e §5.

### Campos custom a criar

| Campo | Onde | Obrigatório |
|---|---|---|
| Shipping service | formulário inicial | sim |
| Length (cm) | ticket de Pick | na transição para Done |
| Width (cm) | ticket de Pick | idem |
| Height (cm) | ticket de Pick | idem |
| Units per box | ticket de Pick | idem |

---

## 9. Formulário

Id `83f310f0-7073-4418-873d-2de7da845ecc`. 20 perguntas, 4 seções, 3 condições,
17 ligações. Definido em `apply-form.mjs`.

```bash
node apply-form.mjs            # dry run + sanity check
node apply-form.mjs --apply    # PUT do design
# reanexar na tela            <-- OBRIGATORIO
node form-sync.mjs --inspect   # confere as 17 ligacoes
```

> ### O PUT do design derruba o anexo ao request type
> Não documentado. Depois de **todo** `--apply`, reanexar em Space settings →
> Request types → Request hardware and eSIM → Forms → Attach form → Select
> existing → Add → Save changes.
>
> Se esquecido, o portal mostra só o Summary, o pedido chega vazio e o backend
> recebe zero linhas **sem nenhum erro**.
>
> `portalRequestTypeIds` da API **não** reflete o anexo (fica `[]`). Verificar
> na tela.

### Schema do design (extraído do tenant, ausente da doc pública)

`no` number · `cs` radio · `ts` short text · `cd` dropdown
`validation.rq` required · `validation.wh` whole numbers
`jiraField` a ligação, **default é não ligar**
`layout[0]` fora de seção · `layout[i]` seção `i`

Condição:
```json
{"21":{"i":{"co":{"cIds":{"1":["1"]}},"operator":"OR","groups":[{"operator":"AND",
"checks":[{"fieldId":"1","type":"SOME_OF","constraint":["1"]}]}]},
"o":{"sIds":["1"],"t":"sh"}}}
```

Só perguntas **fora de seção** podem ser gatilho de condição.

---

## 10. Infra

| | |
|---|---|
| Repo | `github.com/stellartay/ssm-inventory-orchestration` |
| Vercel | `ssm-inventory-orchestration.vercel.app`, team Stellar, **Hobby** |
| Supabase | região **West EU (Paris)** |

Function Region deve ser EU. Deployment Protection **desligada** em produção,
senão o Jira Automation recebe tela de login. Hobby limita Cron a 1x/dia.

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

Refresh do token do Zoho testado e funcionando. Cachear em `zoho_token` e reusar
até expirar, com lock para não disparar refresh concorrente.

`JIRA_API_TOKEN` é **token pessoal**, não conta de serviço. Ver §12.

---

## 11. Schema Supabase

```sql
create table item_map (
  zoho_item_id     text primary key,
  display_name     text not null,
  routing_class    text not null
                   check (routing_class in ('globble','esim','physical')),
  jira_qty_field   text not null,
  unit_weight_kg   numeric,          -- null para esim
  location_id      text,
  active           boolean not null default true
);

create table requests (
  id            uuid primary key default gen_random_uuid(),
  parent_key    text not null unique,
  zoho_so_id    text,
  route         text check (route in ('globble','esim_plus_physical','esim_only','physical_only')),
  shipping_service text,             -- Express | Standard | Saver | Expedite
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

---

## 12. Endpoints

Base `https://ssm-inventory-orchestration.vercel.app`. HMAC em header.

### `POST /api/reserve`
Trigger: pai criado no request type 396.

1. Lê os 9 campos de quantidade, monta linhas com os não vazios
2. Valida o endereço. Se incompleto, comenta e encerra **antes** de reservar
3. Locks de todas as linhas, **ordenados por `zoho_item_id`**
4. Para cada item: `actual_available_stock − actual_committed_stock − pendentes`
5. Se qualquer linha faltar: comenta **todas** as faltas, encerra sem criar SO
6. Cria SO com N linhas e `shipping_address` (país por nome), confirma com
   `POST /salesorders/{id}/status/confirmed`
7. Resolve a rota (§2) e cria os tickets iniciais

### `POST /api/advance`
Trigger: `Pick & Provisioning` (`10375`) → status `10004`.
Cria o `Logistics Pack` (`10376`).

### `POST /api/fulfill`
Trigger: ticket terminal (`10376`, `10377`, `10378`) → status `10004`.

- Lê Length, Width, Height e Units per box do ticket
- Calcula caixas e peso por caixa (§7)
- Cria Package(s) com numeração `PKG-{parentKey}-{n}`
- Cria Shipment Order **com UPS**, `kg` e `cm` forçados, parcel type por §6.3,
  serviço por §6.4, N packages no mesmo shipment
- Captura tracking, grava no `shipment_ledger`, comenta no pai
- `allocation`: Shipment **sem transportadora**, só linhas `esim`, sem etiqueta
- Se todos os tickets estão `closed`, marca `fulfilled` e sinaliza no pai

### `POST /api/cancel`
Trigger: pai → Cancelled.
`POST /salesorders/{id}/status/void`. Void, não Delete: mantém auditoria e
libera o committed igual (testado).

### `POST /api/availability-sync`
Vercel Cron. Reescreve a **descrição do campo** de itens. Não alterar o label
das opções: o label é o mesmo objeto nos tickets históricos.

---

## 13. Concorrência

```sql
select pg_advisory_xact_lock(hashtext(p_zoho_item_id));
```

Adquirir o lock de **todas** as linhas antes de checar qualquer uma,
**ordenados por `zoho_item_id`** para evitar deadlock entre pedidos com os
mesmos itens em ordem inversa.

---

## 14. Riscos aceitos

**Divergência contábil.** Shipment sem Invoice: o contábil não desce. Aceito.
**Não** escrever job de reconciliação antes de testar como `inventoryadjustments`
interage com o split contábil/físico.

**Token pessoal do Jira.** Toda ação da automação aparece como do dono da conta,
e os endpoints param de escrever se o token for revogado. Aceito para validar o
fluxo. Trocar por conta dedicada antes de produção.

**Sales Orders de valor zero** nos relatórios de vendas.

**Formulário sem prova ponta a ponta.** As 17 ligações estão confirmadas na
configuração, mas nenhum ticket real foi verificado.

**Itens em zero.** A1 Chip e GLOBBLE Regolith WiFi Only. Com tudo ou nada,
qualquer pedido que os inclua trava inteiro.

**Estoque baixo.** Teltonika 2, GLOBBLE 5G Black 3.

**Campos órfãos.** `Amount of eSIM` e `Amount of Physical SIM`. Limpar após a
depreciação do `Request New SIM`.

**Limite de peso da UPS desconhecido.** Não sabemos o teto do contrato nem
quando entra Additional Handling. O backend deveria recusar ou dividir caixa
acima do limite, mas falta o número.

---

## 15. Pendências

### Bloqueiam o teste ponta a ponta
- [ ] Ticket de teste pelo portal com todos os campos, e `form-sync.mjs --verify <chave>`
- [ ] Validar que "Expedite" existe cotando destino fora da UE
- [ ] Obter o limite de peso e a faixa de Additional Handling do contrato UPS

### Jira, configuração
- [ ] Criar `Shipping service` no formulário inicial
- [ ] Criar Length, Width, Height, Units per box nos tickets de Pick
- [ ] Validador de workflow tornando os 4 obrigatórios na transição para Done
- [ ] 4 regras de automation, uma por trigger, com header HMAC
- [ ] Depreciar `Request New GLOBBLE` e `Request New SIM`, replicando as
      restrictions do segundo

### Backend
- [ ] Migrations, cliente Zoho com refresh e lock, cliente Jira, HMAC
- [ ] 5 endpoints
- [ ] `scripts/seed-item-map.ts` populando `item_map` (§3)
- [ ] Melhorar `form-sync.mjs --verify`: validar que o issue é do request type
      396 e tem formulário anexado antes de julgar campos vazios

### Decisões abertas
- [ ] O pai fecha automático ou um humano fecha?
- [ ] `Residential Delivery`: quando marcar? Muda o preço
- [ ] Validação de endereço: só presença, ou formato de CEP por país?
- [ ] Lista final de países no `customfield_10938`
- [ ] Trocar o Weight Unit default da org de `lb` para `kg`

---

## 16. Resolvidas

- [x] Schemes do SSM são dedicados
- [x] UPS via integração nativa, validada com cotação real em conta francesa
- [x] eSIM é `routing_class` própria
- [x] Datacenter Zoho é EU
- [x] Multi-linha via 9 campos de quantidade mais toggles condicionais
- [x] Schema do design da Forms API, incluindo condições
- [x] O PUT do design derruba o anexo ao request type
- [x] Os 9 `item_id` reais
- [x] Estoque vem como float
- [x] `actual_available_stock` não desconta committed
- [x] Itens precisavam de `can_be_sold`, corrigido
- [x] Endereço de destino é obrigatório no SO
- [x] País no Zoho é o nome, não o ISO
- [x] kg e cm têm que ser consistentes
- [x] Peso e Parcel Type são obrigatórios
- [x] N packages caem em um único shipment
- [x] Deletar ou anular SO libera o committed
- [x] 13 env vars configuradas, refresh do token testado
