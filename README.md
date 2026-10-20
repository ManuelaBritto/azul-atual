# Azul em Sintonia

Base web em **HTML, CSS e JavaScript** para a terceira problemática da Seletiva Azul. Cadastro e autenticação usam **Supabase Auth**; os registros ficam no **Postgres do Supabase**, protegidos por regras **RLS (Row Level Security)**. Atualizações aparecem em tempo real com **Supabase Realtime**.

## O que está estruturado

- Página institucional, login e cadastro de cliente.
- Entrada operacional separada; não existe cadastro público de funcionários.
- Área do passageiro para vincular códigos de voo (validados no catálogo de voos) e ler comunicados públicos.
- Área de funcionários organizada por organização e área autorizada.
- Criação de ocorrência pelo CCO/admin e encaminhamento para várias áreas.
- Atualizações internas compartilhadas e status separado para cada área.
- Mensagens públicas separadas dos registros internos.
- Regras RLS negando acesso por padrão e autorizando por conta, organização, área e papel.
- Catálogo com 21 voos, organização, 5 áreas, contas de demonstração e uma ocorrência de exemplo.
- Dashboard operacional com indicadores, gráficos por área e prioridade, atividade recente e ocorrências prioritárias.
- Central de Impacto Operacional para destacar casos de prioridade alta/crítica, áreas pendentes e última atividade registrada.
- Central de relatórios com filtro, exportação CSV e impressão/salvamento como PDF pelo navegador.
- Radar esquemático de rotas com busca por voo, origem e destino.

## Arquivos

```text
index.html                                 estrutura das telas
styles.css                                 identidade visual e layout responsivo
app.js                                     navegação, formulários, dashboard, relatórios e radar de rotas
supabase-config.js                         URL e chave pública (anon) do projeto Supabase
supabase/migrations/01_estrutura.sql       tabelas, gatilho de perfil e funções (RPC)
supabase/migrations/02_regras_rls.sql      regras de acesso (RLS) e tempo real
supabase/migrations/03_dados_iniciais.sql  voos, organização, áreas, contas e exemplo
```

## 1. Criar e configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. Abra **SQL Editor → New query**, cole e rode, **nesta ordem**:
   1. `supabase/migrations/01_estrutura.sql`
   2. `supabase/migrations/02_regras_rls.sql`
   3. `supabase/migrations/03_dados_iniciais.sql`
3. Em **Authentication → Sign In / Providers → Email**, deixe o provedor E-mail ativo. Para o cliente entrar logo após o cadastro, **desative "Confirm email"**. Se mantiver ativado, o site avisa para confirmar pelo link enviado.
4. Em **Project Settings → API**, copie a **Project URL** e a chave **anon / publishable** para `supabase-config.js`. Nunca use a chave `service_role`/secret no site.
5. Em **Authentication → URL Configuration**, coloque o endereço onde o site vai rodar (ex.: `http://localhost:5500`) em *Site URL*.

O SDK do Supabase é importado como módulo ES pela CDN jsDelivr, então o site não precisa de React, npm nem bundler. Para testar localmente, sirva a pasta por HTTP — por exemplo, execute `python -m http.server 5500` nesta pasta e abra `http://localhost:5500`. Não abra o HTML direto como `file://`, porque o navegador bloqueia imports de módulos nessa origem.

## 2. Contas de demonstração

Criadas pelo `03_dados_iniciais.sql`. Senha de todas: **`Azul@2026`**.

| E-mail | Entrada | Acesso |
| --- | --- | --- |
| `cco@exemplo.com` | Acesso operacional | CCO: vê todas as áreas, abre ocorrências e publica |
| `manutencao@exemplo.com` | Acesso operacional | Manutenção |
| `handling@exemplo.com` | Acesso operacional | Handling |
| `atendimento@exemplo.com` | Acesso operacional | Atendimento: publica para passageiros |
| `comercial@exemplo.com` | Acesso operacional | Comercial: publica para passageiros |
| `cliente@exemplo.com` | Entrar (cliente) | Já acompanha AD 4281 e AD 4302 |

Voos disponíveis: AD 4050, AD 4062, AD 4100, AD 2711, AD 4302, AD 4281, AD 4170, AD 4416, AD 4520, AD 4632, AD 4700, AD 4815, AD 4920, AD 5011, AD 5123, AD 2470, AD 4381, AD 4900, AD 8750, AD 8700, AD 8710. Rodar o `03_dados_iniciais.sql` de novo atualiza os horários para o dia atual.

## 3. Modelo de dados

| Tabela | Antes (Firestore) | Conteúdo |
| --- | --- | --- |
| `profiles` | `profiles/{uid}` | nome, e-mail e tipo (`customer` ou `employee`). Criado automaticamente no cadastro, sempre como cliente. |
| `memberships` | `profiles/{uid}/memberships/{orgId}` | vínculo com organização, áreas, nomes, papéis e permissões. |
| `organizations` | `organizations/{orgId}` | organização. |
| `areas` | `organizations/{orgId}/areas/{areaId}` | área operacional (`name`, `active`). |
| `boards` | `.../areas/{areaId}/boards/{incidentId}` | cartão da ocorrência no quadro de cada área. |
| `incidents` | `incidents/{incidentId}` | registro central e áreas envolvidas. |
| `internal_updates` | `incidents/{id}/internalUpdates` | histórico operacional compartilhado. |
| `area_status` | `incidents/{id}/areaStatus/{areaId}` | andamento de cada área. |
| `flights` | *(novo)* | catálogo de voos: código, origem, destino, horários e aeronave. |
| `customer_flights` | `profiles/{uid}/customerFlights/{flightKey}` | voos que o cliente acompanha. |
| `public_updates` | `flights/{flightKey}/publicUpdates` | comunicados para passageiros, separados dos dados internos. |

Criar ocorrência e registrar atualização usam as funções `create_incident` e `register_incident_update`, que validam permissões no banco e gravam tudo numa única transação (substituem o `writeBatch`).

## 4. Novas áreas operacionais

- **Visão geral**: indicadores de ocorrências abertas, prioridades, conclusão por áreas, distribuição por setor e atividade recente.
- **Radar de voos**: mapa esquemático das rotas cadastradas e cartões pesquisáveis por código, origem e destino. O catálogo inicial contém dados de demonstração; o radar **não rastreia posições GPS em tempo real**.
- **Central de relatórios**: tabela filtrável e exportação CSV. O botão de PDF abre a impressão do navegador, onde é possível escolher “Salvar como PDF”.
- **Central de Impacto Operacional**: destaca ocorrências de prioridade alta/crítica, áreas ainda pendentes e horário da última atividade conhecida. As sugestões são baseadas em regras simples, não em inteligência artificial nem em previsão operacional.

Os indicadores são calculados com os registros que o usuário autenticado tem permissão para consultar. A implementação das novas telas não exige uma migração SQL adicional; ela reutiliza as tabelas e políticas existentes. Para uso com dados reais, é necessário validar as políticas RLS, as contas e as fontes de informação antes da publicação.

## 5. Credenciar pessoas funcionárias

Não existe senha comum nem botão que conceda papel. Um administrador cria o usuário em **Authentication → Users → Add user** (marcando *Auto Confirm User*) e depois roda no SQL Editor:

```sql
-- troque o e-mail e as áreas/papéis
update public.profiles set account_type = 'employee', full_name = 'Nome da Pessoa'
where email = 'pessoa@empresa.com';

insert into public.memberships (user_id, org_id, active, organization_name, area_ids, area_names, roles, can_view_all, can_manage_incidents)
select id, 'azul-operacao', true, 'Operação de demonstração',
       array['manutencao'], '{"manutencao":"Manutenção"}', '{"manutencao":"maintenance"}', false, false
from auth.users where email = 'pessoa@empresa.com';
```

Papéis aceitos: `cco`, `admin`, `maintenance`, `handling`, `customer_service`, `commercial`. Só `cco`, `admin`, `customer_service` e `commercial` publicam para passageiros. CCO/admin deve ter `can_view_all = true` e `can_manage_incidents = true`. Para uma conta de equipe sem CCO, `area_ids` contém somente as áreas autorizadas e as duas permissões ficam `false`.

## 6. Publicar

O site é estático: publique a pasta em qualquer hospedagem (Netlify, Vercel, GitHub Pages, Cloudflare Pages). Depois coloque o endereço publicado em **Authentication → URL Configuration** (*Site URL* e *Redirect URLs*).

## 7. Limites desta base

As regras RLS foram escritas e testadas para este modelo, mas revise antes de qualquer uso real. Não conecte dados operacionais ou pessoais reais da Azul sem autorização formal, requisitos definidos e revisão de segurança. Os voos do catálogo são de demonstração; a integração com sistemas de voos da companhia dependeria de acesso oficial.
