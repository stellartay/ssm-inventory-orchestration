# SSM Inventory Orchestration — Contexto e Especificação

Versão 6. Substitui v1 a v5.
Fonte de verdade das decisões. Não reabrir decisão travada sem confirmação
explícita do dono do projeto.

Construído e validado entre 2026-08-25 e 2026-08-31.

---

## 1. Objetivo

Cliente interno solicita hardware ou eSIM via portal do Jira Service Management.
O sistema verifica disponibilidade no Zoho Inventory, reserva o estoque, abre a
cadeia de work items de fulfillment conforme a composição do pedido, e dá baixa
no inventário quando o último ticket da cadeia fecha, gerando etiqueta UPS.

---

## 2. Roteamento

Regras avaliadas **nesta ordem**. A primeira que casar vence.

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
- **A1 Allocation não embala.** Sem Pak, sem Package, sem etiqueta. eSIM é
  alocado no portal da A1 e a baixa é um Shipment sem transportadora.

---

## 3. `item_map`

| `zoho_item_id` | `display_name` | `routing_class` | `jira_qty_field` | kg/un |
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

Estoque 31/08: SIM Card 1938, A1 eSIM 260, GLOBBLE 4G Black 130,
GLOBBLE 5G Regolith 98, GLOBBLE 4G Regolith 13, GLOBBLE 5G Black 3,
Teltonika 2, **A1 Chip 0**, **GLOBBLE Regolith WiFi Only 0**.

Nenhum item tem SKU. **Mapear por `item_id`.**

---

## 4. Estoque: quatro achados do teste manual

### 4.1 Vem como float
`260.0`, `1938.0`. Arredondar antes de comparar.

### 4.2 `actual_available_stock` NÃO desconta o committed
Testado: 1 unidade committed, `actual_available_stock` continuou 1938 e
`actual_committed_stock` foi para 1.

```
disponível = actual_available_stock − actual_committed_stock − pendentes locais
```

Se o backend confiar só em `actual_available_stock`, aprova além do estoque.
Subtrair explicitamente também protege contra reservas feitas na tela do Zoho.

### 4.3 Confirmar SO não move físico. Remover SO libera o committed
Testado nos dois sentidos. Em produção usar **Void**, não Delete: mantém
rastro auditável e libera igual.

### 4.4 Itens precisam de `can_be_sold = true`
Os 9 estavam `false`. Item não vendável **não aparece em Sales Order e a API
rejeita**. Corrigido, com `rate` 0. Item novo no catálogo precisa disso ou o
`/api/reserve` falha para ele.

Consequência aceita: SOs com total €0,00 aparecem nos relatórios de vendas.
A tela pede confirmação de "zero amount", mas **a API aceita direto**.

---

## 5. Zoho Inventory

| | |
|---|---|
| Datacenter | **EU** |
| API base | `https://www.zohoapis.eu/inventory/v1` |
| OAuth | `https://accounts.zoho.eu/oauth/v2/token` |
| `organization_id` | `20117600647` |
| Contato interno | `Internal IT Requests` · `1262780000000074002` |
| Location | Siège social, única, preenchida automaticamente |
| Origem | 1 Bis Chemin Bacchus, Bruges, Nouvelle-Aquitaine 33520, France |
| Telefone origem | 33-681312199 |

Scopes mínimos, confirmados:
```
ZohoInventory.items.READ
ZohoInventory.salesorders.CREATE
ZohoInventory.salesorders.UPDATE
ZohoInventory.packages.CREATE
ZohoInventory.shipmentorders.CREATE
```

`/locations` e `/settings/*` dão `code: 57`, esperado. `items.UPDATE` não
concedido de propósito.

### Numeração manual
A org usa numeração manual de Package e Shipment. O backend gera
`PKG-{parentKey}-{n}` e `SHP-{parentKey}-{n}`, rastreável até o ticket.

### Endereço de destino é obrigatório
O contato interno não tem billing nem shipping address. Sem `shipping_address`
no SO o shipment não pode ser criado ("Address cannot be empty").

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

---

## 6. UPS: validado

Integração nativa do Zoho funcionando com a conta francesa. Cotação real de
Bruges para Bruges: Express €14,10, Standard €7,07, Saver €10,97.
**Não integrar a API da UPS.**

Fluxo: Validate Address → Create Shipment → Generate Label.
Billing Method default `Bill Shipper`: frete na conta da Stellar.

### 6.1 Peso e Parcel Type obrigatórios

### 6.2 kg e cm têm que ser consistentes
A UPS rejeitou: *"A shipment cannot have a KGS/IN or LBS/CM or OZS/CM as its
unit of measurements"*. O Zoho traz peso em **`lb`** por default.
**O backend deve forçar `kg` e `cm`.**

### 6.3 Parcel Type: só valores da UPS
Opções: `UPS Letter`, `Package`, `Tube`, `Pak`, `UPS Express Box`,
`UPS 10 KG Box®`, `Pallet`, `Specify custom dimensions`.

| Conteúdo | Parcel Type |
|---|---|
| Até 100 un. de SIM Card ou A1 Chip, sem outros itens | `Pak` |
| Todo o resto | `Package` |

**Dimensões não são declaradas.** A logística confirmou que no formulário da
UPS eles informam apenas peso e quantidade. `Specify custom dimensions` foi
descartado.

### 6.4 Serviço de frete
Escolhido pelo cliente interno no formulário (`customfield_10971`), com
Standard, Saver e Express.

**Destino fora da Europa usa sempre Expedite**, sobrepondo a escolha. Da lista
atual de países, só os EUA se qualificam.

> Pendente: "Expedite" **não apareceu** na cotação doméstica. Confirmar cotando
> destino fora da UE antes de codificar essa regra.

### 6.5 N packages em um único shipment
Um shipment aceita vários pacotes: **um envio, um tracking number**.

### 6.6 Não decidido
`Residential Delivery` (provavelmente necessário para colaborador em casa, e
muda o preço), `Direct Delivery Only`, `Saturday Delivery`.

---

## 7. Regras de embalagem

**Peso total** = Σ (`qty` × kg/un), da tabela em §3. Cobre pedidos mistos.

**Número de pacotes** vem da logística, campo `Number of packages`
(`customfield_10975`), preenchido por quem embala antes de fechar o ticket.

**Peso por pacote** = peso total ÷ número de pacotes, divisão igual.
Aproximação aceita: a UPS cobra o envio como uma linha na fatura, então a
distribuição por caixa é declaratória, não financeira.

> Ressalva: se uma caixa passar do limite de peso da UPS, entra Additional
> Handling e a fatura muda. O limite do contrato de vocês é desconhecido. O
> backend deveria avisar no comentário do ticket acima de um limite
> configurável, começando desabilitado.

**Quem informa o quê:**

| Work type | Id | Informa pacotes |
|---|---|---|
| Logistics Pack | `10376` | sim |
| Pick & Pack | `10377` | sim |
| Pick & Provisioning | `10375` | não, ainda não embalou |
| A1 Allocation | `10378` | não, não tem caixa |

---

## 8. Jira

Site `https://stellartelecommunications.atlassian.net`
Projeto **SSM**, JSM, company-managed · `cloudId` `8cb90050-eca2-4420-b374-653bcc86c1d5`

### Workflows, dois

| Workflow | Id | Work types | Validador |
|---|---|---|---|
| `SSM: Logistics Fulfilment` | `b1d13f71-ac61-4170-b59e-e2b8f42e3756` | `10376`, `10377` | Number of packages obrigatório no Finish |
| `SSM: Logistics Fulfilment No Packing` | `a7531ca9-4ff3-454b-8f9f-a39955483681` | `10375`, `10378` | nenhum |

Grafo idêntico nos dois: `Open → (Start work) → In Progress → (Finish) → Done`,
sem saída de Done.

**Status id do Done: `10004`**, o mesmo nos dois workflows porque reusam os
status globais. Usar o ID nos triggers, nunca o nome: o site tem Done, Closed,
Completed e Cancelled convivendo, e dois status chamados "Work in progress".

> ### O toggle de customer transitions desativa as rules
> O Jira avisa: *"Rules won't work when customer transitions are enabled."*
> Está desligado hoje. Se alguém ligar "Customers can make this transition" no
> Finish, o validador para de funcionar **em silêncio**.

Workflow scheme `10164`, field config scheme `2`, issue type scheme dedicado,
issue type screen scheme `10162`.

### Request type

`Request hardware and eSIM` · **`396`** · portal group **Logistics**
Portal: `https://service.desk.stellar.tc/servicedesk/customer/portal/5/create/396`
Atendido por Bhumika Umesh (a regra `JIP-140` cobre só o `Logistics Request`
antigo; incluir o novo na condição dela ou criar regra equivalente).

### Campos custom

| Campo | Id |
|---|---|
| Qty GLOBBLE 4G Black | `customfield_10890` |
| Qty GLOBBLE 4G Regolith | `customfield_10923` |
| Qty GLOBBLE 5G Black | `customfield_10924` |
| Qty GLOBBLE 5G Regolith | `customfield_10925` |
| Qty GLOBBLE Regolith WiFi Only | `customfield_10926` |
| Qty SIM Card | `customfield_10927` |
| Qty A1 eSIM | `customfield_10928` |
| Qty A1 Chip | `customfield_10929` |
| Qty Teltonika 5G Antennas | `customfield_10930` |
| Recipient name | `customfield_10931` |
| Address line 1 | `customfield_10932` |
| Address line 2 | `customfield_10933` |
| City | `customfield_10934` |
| State or region | `customfield_10935` |
| Postal code | `customfield_10936` |
| Phone | `customfield_10937` |
| Country | `customfield_10938` |
| **Shipping service** | `customfield_10971` |
| **Number of packages** | `customfield_10975` |

Não usados, mantidos apenas para não sujar "Deleted fields":
`UNUSED Box length cm` `10972`, `UNUSED Box width cm` `10973`,
`UNUSED Box height cm` `10974`. Fora de qualquer scheme.

> ### Campo no field config scheme não basta
> Associar ao field configuration scheme torna o campo **existente**, mas não
> **visível**. Ele precisa estar numa **tela**. O `Number of packages` só
> apareceu no createmeta depois de ser adicionado ao screen `10361`, tab
> `10365`, que é o default do issue type screen scheme `10162`.
>
> Verificar sempre com:
> ```
> GET /rest/api/3/issue/createmeta/SSM/issuetypes/{typeId}
> ```
> Se o campo não estiver ali, ninguém consegue preencher, e um validador que o
> exige trava a pessoa sem saída.

---

## 9. Formulário

Id `83f310f0-7073-4418-873d-2de7da845ecc`.
**21 perguntas, 4 seções, 3 condições, 18 ligações.** Definido em `apply-form.mjs`.

```bash
node apply-form.mjs            # dry run + sanity check
node apply-form.mjs --apply    # PUT do design
# reanexar na tela            <-- OBRIGATORIO
node form-sync.mjs --inspect   # confere as 18 ligacoes
```

> ### O PUT do design derruba o anexo ao request type
> Depois de **todo** `--apply`, reanexar em Space settings → Request types →
> Request hardware and eSIM → Forms → Attach form → Select existing → Add →
> Save changes.
>
> Se esquecido, o portal mostra só o Summary, o pedido chega vazio e o backend
> recebe zero linhas **sem nenhum erro**.
>
> `portalRequestTypeIds` da API **não** reflete o anexo (fica `[]`).

### Schema do design (extraído do tenant, ausente da doc pública)

`no` number · `cs` radio · `ts` short text · `cd` dropdown
`validation.rq` required · `validation.wh` whole numbers
`jiraField` a ligação, **default é não ligar**
`layout[0]` fora de seção · `layout[i]` seção `i`

```json
{"21":{"i":{"co":{"cIds":{"1":["1"]}},"operator":"OR","groups":[{"operator":"AND",
"checks":[{"fieldId":"1","type":"SOME_OF","constraint":["1"]}]}]},
"o":{"sIds":["1"],"t":"sh"}}}
```

Só perguntas **fora de seção** podem ser gatilho de condição.

---

## 10. Automation

Existe um molde salvo e **desabilitado**:
`SSM: Zoho reserve on hardware request - TEMPLATE DO NOT ENABLE`
id `01a06657-4f37-76bc-8c6f-8afe5c1bd0c6`

Configuração dele, que serve de padrão para as outras três:
- Trigger **Work item created**
- Condição **JQL**: `project = SSM AND "Request Type" = "Request hardware and eSIM"`
- Ação **Send web request**, POST para `/api/reserve`

**A URL não é validada na criação**, então as regras podem existir antes do
backend. `Validate your web request configuration` é opcional.

**Falta em todas:** body JSON com smart values, header HMAC, e o
"Delay execution of subsequent flow actions" onde a resposta for lida.

> As três regras restantes devem ser criadas **depois** do backend, porque o
> body depende do contrato exato dos endpoints. Se o payload divergir, o
> webhook devolve 400 e o Jira não avisa ninguém.

Automation deste site fica em `/jira/settings/automation`. O caminho por
projeto responde "Legacy Automation is not available for this site".

Convenção de nome existente no projeto: `SSM: descrição (JIP-XXX)`.

---

## 11. Infra

| | |
|---|---|
| Repo | `github.com/stellartay/ssm-inventory-orchestration` |
| Vercel | `ssm-inventory-orchestration.vercel.app`, team Stellar, **Hobby** |
| Supabase | região **West EU (Paris)** |

Function Region deve ser EU. Deployment Protection **desligada** em produção,
senão o Jira Automation recebe tela de login. Hobby limita Cron a 1x/dia.

### Env vars, 13 no Vercel

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

Refresh do token do Zoho testado. Cachear em `zoho_token` e reusar até expirar,
com lock para não disparar refresh concorrente.

`JIRA_API_TOKEN` é **token pessoal**, não conta de serviço. Ver §14.

O `.env.local` local precisa das mesmas variáveis para o Claude Code rodar os
scripts. `.env` e `.env.local` estão no `.gitignore`.

---

## 12. Schema Supabase

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
  id               uuid primary key default gen_random_uuid(),
  parent_key       text not null unique,
  zoho_so_id       text,
  route            text check (route in ('globble','esim_plus_physical','esim_only','physical_only')),
  shipping_service text,             -- Standard | Saver | Express | Expedite
  status           text not null default 'pending'
                   check (status in ('pending','reserved','fulfilled','cancelled','failed')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table request_lines (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  zoho_item_id  text not null references item_map(zoho_item_id),
  qty           int  not null check (qty > 0),
  unique (request_id, zoho_item_id)
);

create table tickets (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references requests(id) on delete cascade,
  issue_key          text not null unique,
  kind               text not null
                     check (kind in ('pick_provisioning','logistics_pack','pick_pack','allocation')),
  status             text not null default 'open'
                     check (status in ('open','closed')),
  number_of_packages int,
  created_at         timestamptz not null default now()
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

## 13. Endpoints

Base `https://ssm-inventory-orchestration.vercel.app`. HMAC em header.

### `POST /api/reserve`
Trigger: pai criado no request type 396.

1. Lê os 9 campos de quantidade, monta linhas com os não vazios
2. Lê o `Shipping service` (`10971`). Se o país estiver fora da Europa,
   sobrepõe para Expedite
3. Valida o endereço. Se incompleto, comenta e encerra **antes** de reservar
4. Locks de todas as linhas, **ordenados por `zoho_item_id`**
5. Disponível = `actual_available_stock − actual_committed_stock − pendentes`
6. Se qualquer linha faltar: comenta **todas** as faltas, encerra sem criar SO
7. Cria SO com N linhas e `shipping_address` (país por nome), confirma com
   `POST /salesorders/{id}/status/confirmed`
8. Resolve a rota (§2) e cria os tickets iniciais

### `POST /api/advance`
Trigger: `Pick & Provisioning` (`10375`) → status `10004`.
Cria o `Logistics Pack` (`10376`).

### `POST /api/fulfill`
Trigger: ticket terminal (`10376`, `10377`, `10378`) → status `10004`.

- Lê `Number of packages` (`10975`) do ticket
- Peso total por §7, dividido igualmente entre os pacotes
- Parcel Type por §6.3
- Cria N Packages `PKG-{parentKey}-{n}`
- Cria Shipment Order **com UPS**, `kg` e `cm` forçados, serviço por §6.4,
  N packages no mesmo shipment
- Captura tracking, grava no `shipment_ledger`, comenta no pai
- `allocation`: Shipment **sem transportadora**, só linhas `esim`, sem etiqueta
- Se todos os tickets estão `closed`, marca `fulfilled` e sinaliza no pai

### `POST /api/cancel`
Trigger: pai → Cancelled.
`POST /salesorders/{id}/status/void`. Void, não Delete.

### `POST /api/availability-sync`
Vercel Cron. Reescreve a **descrição do campo** de itens. Não alterar o label
das opções: é o mesmo objeto nos tickets históricos.

---

## 14. Concorrência

```sql
select pg_advisory_xact_lock(hashtext(p_zoho_item_id));
```

Lock de **todas** as linhas antes de checar qualquer uma, **ordenados por
`zoho_item_id`** para evitar deadlock entre pedidos com os mesmos itens em
ordem inversa.

---

## 15. Riscos aceitos

**Divergência contábil.** Shipment sem Invoice: o contábil não desce. **Não**
escrever job de reconciliação antes de testar como `inventoryadjustments`
interage com o split contábil/físico.

**Token pessoal do Jira.** Toda ação aparece como do dono da conta, e os
endpoints param de escrever se o token for revogado. Trocar por conta dedicada
antes de produção.

**Sales Orders de valor zero** nos relatórios de vendas.

**Peso por pacote é aproximação.** Divisão igual do total.

**Formulário sem prova ponta a ponta.** As 18 ligações estão confirmadas na
configuração, mas nenhum ticket real foi verificado.

**Itens em zero.** A1 Chip e GLOBBLE Regolith WiFi Only. Com tudo ou nada,
qualquer pedido que os inclua trava inteiro.

**Estoque baixo.** Teltonika 2, GLOBBLE 5G Black 3.

**Campos órfãos.** `Amount of eSIM` e `Amount of Physical SIM` duplicam
`Qty A1 eSIM` e `Qty SIM Card`. Limpar após depreciar o `Request New SIM`.

**Limite de peso da UPS desconhecido.**

---

## 16. Pendências

### Você
- [ ] Ticket de teste pelo portal com todos os campos, e
      `form-sync.mjs --verify <chave>`
- [ ] Popular o `.env.local` com as 13 variáveis
- [ ] Validar que "Expedite" existe cotando destino fora da UE
- [ ] Limite de peso e faixa de Additional Handling do contrato UPS
- [ ] Incluir o `Request hardware and eSIM` na regra `JIP-140` da Bhumika
- [ ] Trocar o Weight Unit default da org de `lb` para `kg`

### Backend, primeiro
- [ ] Migrations, cliente Zoho com refresh e lock, cliente Jira, HMAC
- [ ] 5 endpoints
- [ ] `scripts/seed-item-map.ts` populando `item_map` (§3)
- [ ] Melhorar `form-sync.mjs --verify`: validar que o issue é do request type
      396 e tem formulário anexado antes de julgar campos vazios

### Automation, depois do backend
- [ ] 3 regras restantes, a partir do molde `01a06657-...`
- [ ] Body JSON, header HMAC e "Delay execution" nas quatro
- [ ] Habilitar e renomear o molde

### Depois de validado
- [ ] Depreciar `Request New GLOBBLE` e `Request New SIM`, replicando as
      restrictions do segundo

### Decisões abertas
- [ ] O pai fecha automático ou um humano fecha?
- [ ] `Residential Delivery`: quando marcar?
- [ ] Validação de endereço: só presença, ou formato de CEP por país?
- [ ] Lista final de países no `customfield_10938`

---

## 17. Resolvidas

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
- [x] Itens precisavam de `can_be_sold`
- [x] Endereço de destino é obrigatório no SO
- [x] País no Zoho é o nome, não o ISO
- [x] kg e cm têm que ser consistentes
- [x] Peso e Parcel Type obrigatórios
- [x] Dimensões não são declaradas, só peso e quantidade
- [x] N packages em um único shipment
- [x] Remover ou anular SO libera o committed
- [x] Campo no field config scheme não basta, precisa estar numa tela
- [x] Dois workflows, com e sem validador de packing
- [x] Send web request não valida URL na criação
- [x] 13 env vars configuradas, refresh do token testado
