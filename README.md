# Regiões de Atendimento — Mapa de Vendedores

App estático (sem servidor, sem custo) para desenhar regiões de atendimento no mapa,
associar cidades e vendedores a cada região, definir o perfil mínimo de veículo exigido,
e consultar a distância rodoviária (ida / ida e volta) da origem até qualquer cidade.

- Mapa: OpenStreetMap + Leaflet (gratuito)
- Rotas/distância: OSRM (gratuito, sem chave)
- Geocodificação (endereço → coordenadas): Nominatim/OSM (gratuito, sem chave)
- Hospedagem: GitHub Pages (gratuito)

---

## 1. Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser público ou privado, desde que você tenha
   GitHub Pages disponível no seu plano).
2. Suba todo o conteúdo desta pasta (`index.html`, `css/`, `js/`, `data/`, `gerar-senha.html`)
   para a raiz do repositório.
3. No repositório, vá em **Settings → Pages** e escolha:
   - Source: **Deploy from a branch**
   - Branch: `main` (ou `master`), pasta `/ (root)`
4. Em alguns minutos o link ficará disponível (algo como
   `https://SEU_USUARIO.github.io/NOME_DO_REPO/`).

Nenhuma etapa de build é necessária — é HTML/CSS/JS puro.

---

## 2. Trocar a senha de administrador (faça isso antes de publicar)

A senha padrão de fábrica é **`trocaresta123`** — troque antes de publicar.

1. Abra o arquivo `gerar-senha.html` diretamente no navegador (duplo clique, sem precisar
   estar publicado).
2. Digite a nova senha e clique em **Gerar hash**.
3. Copie o hash gerado (uma sequência de letras e números) e cole no arquivo `js/config.js`,
   substituindo o valor de `ADMIN_PASSWORD_HASH`.
4. Suba (`commit`) o `config.js` atualizado para o GitHub.

A senha em si nunca fica escrita no código — só o hash. Isso não é segurança de nível
bancário (é um site estático público), mas é suficiente para impedir alterações
acidentais ou por pessoas sem a senha.

---

## 3. Como funciona o dia a dia

### Modo visualização (padrão, sem senha)
Qualquer pessoa que acessar o link vê:
- Todas as regiões já criadas, coloridas no mapa
- A lista de regiões, quantas cidades cada uma tem e o perfil mínimo de veículo
- Um filtro "Ver por vendedor" — escolhe o nome e o mapa mostra só as cidades daquele
  vendedor, com a região e o perfil de cada uma
- Clicando em qualquer cidade no mapa: vendedor(es), região, perfil exigido, e botões
  para calcular a distância rodoviária de ida ou de ida e volta a partir da origem
  (Terra Boa - PR)

Ninguém nesse modo consegue mover, criar ou apagar nada.

### Modo admin (com senha)
1. Clique em **"Entrar como admin"** no topo e digite a senha.
2. Uma barra horizontal aparece logo abaixo do topo, com as ferramentas do admin:
   desenhar região, exportar `regions.json`/`cities.json`, e o campo de busca de
   endereço.
3. Clique em **"Desenhar nova região"** e desenhe um polígono no mapa em volta das
   cidades que devem compor a região (clique para adicionar pontos, dê duplo clique
   para fechar o polígono).
3. Um formulário abre com as cidades detectadas dentro do polígono. Você pode:
   - Desmarcar cidades que não devem entrar
   - Dar um nome à região (ex: `REGIÃO FOOD MARINGÁ`)
   - Escolher o perfil mínimo de veículo
4. Clique em **Salvar região**.
5. Repita para as demais regiões. Para editar ou excluir uma região já criada, clique
   em "editar" na lista de regiões da barra lateral.

### Corrigindo uma cidade com localização errada (admin)
Serviços gratuitos de geocodificação às vezes erram — por exemplo, uma cidade pequena
pode "cair" em outro estado com nome parecido (ex: "Santa Fé" existe em vários estados
do Brasil). Para reduzir isso, a busca de cada cidade já é restrita ao estado dela
(Paraná ou São Paulo, os únicos usados nesta base) — só se não achar nada dentro desse
estado é que o sistema tenta de novo sem essa restrição, e nesse caso já marca a cidade
como suspeita automaticamente.

O app detecta isso sozinho: compara a UF do nome da cidade (ex: "- PR") com o estado
que a busca encontrou, e se não bater (ou se precisou cair fora da busca restrita),
mostra um **selo de aviso vermelho (!)** em cima do pin no mapa, mesmo sem precisar
clicar nele.

A busca também usa o formato de endereço mais confiável: internamente convertemos
"Cidade - UF" para "Cidade, Estado por extenso, Brasil" (ex: "Santa Fé, Paraná,
Brasil") antes de mandar pro serviço de busca — o formato com hífen e sigla direto
("Santa Fé - PR, Brasil") confundia a busca e fazia ela ignorar a restrição de estado
sem avisar.

**Se você notar cidades antigas com localização errada mas sem o selo de aviso** — isso
acontece com cidades que foram localizadas antes dessa verificação existir. Use o botão
**"Reconferir todas as cidades"** na barra do admin: ele refaz a localização de todas as
cidades que não foram corrigidas manualmente (as que já foram, ficam intactas), e
aplica a verificação de estado a todas elas. Pode levar alguns minutos para 217+
cidades, com uma barra de progresso mostrando o andamento.

Há duas formas de corrigir uma cidade específica, com o modo admin ativo:

**1. Arrastando o pin direto no mapa**
1. Clique na cidade errada para abrir o popup.
2. Arraste o pin até o lugar certo (o cursor vira "mãozinha" em modo admin).
3. Ao soltar, a correção já fica salva e o aviso desaparece.

**2. Buscando por nome (campo "Localizar / corrigir cidade por busca")**
1. No painel do admin, escolha a cidade no seletor.
2. Ajuste o texto de busca se quiser ser mais específico (ex: acrescentar bairro,
   rodovia, ponto de referência) — por padrão já vem preenchido com "Cidade, Brasil".
3. Clique em **"Buscar no mapa"** — um pin azul aparece no local encontrado, e o mapa
   centraliza nele, para você conferir se caiu no lugar certo antes de confirmar.
4. Se precisar, arraste esse pin azul para ajustar.
5. Clique em **"Usar esta localização para [cidade]"** para aplicar.

Nos dois casos, se quiser desfazer e deixar o sistema tentar geocodificar de novo do
zero, use o botão "Refazer busca automática" no popup daquela cidade.

### Cor das regiões
Ao criar ou editar uma região, tem um seletor de cor livre — escolha qualquer cor que
quiser, não fica preso a uma paleta fixa. Cidades sem região ficam sempre em cinza.

### Janelas arrastáveis, sem tampar o mapa
Todas as janelas do admin (entrar como admin, criar/editar região, nova cidade,
detalhes da região) são painéis flutuantes — não tampam mais a tela toda. Segure com
o mouse no título de qualquer uma delas e arraste pra onde quiser, pra poder ver o
mapa por trás enquanto preenche o formulário.

### Somando cidades a uma região já existente (sem duplicar)
Ao desenhar um novo polígono, o formulário que abre agora tem um campo no topo:
**"Somar essas cidades a uma região já existente?"**. Se você escolher uma região ali:
- O nome, o perfil de veículo e a cor passam a vir da região escolhida (ficam
  travados, pois são da região existente).
- As cidades capturadas pelo novo polígono são **somadas** às que a região já tinha
  (sem duplicar as que já estavam lá).
- Ao salvar, não cria uma região nova — as cidades entram direto na região
  selecionada.

Se deixar em "— Criar uma região nova —" (padrão), funciona como antes: cria uma
região nova do zero com essas cidades.

### Desenho de polígono
O desenho da região já é ponto a ponto: clique no mapa para marcar cada vértice do
polígono ao redor das cidades desejadas, e dê um duplo clique para fechar a forma. O
sistema detecta automaticamente quais cidades caíram dentro do polígono desenhado.

### Desenhando a região de um vendedor específico
Se você quer montar a região só com as cidades de um vendedor, use o filtro **"Ver por
vendedor"** no topo da barra lateral antes de desenhar o polígono: ao escolher um
vendedor, todos os outros pontos somem do mapa (não ficam só apagados, somem mesmo).
Assim, quando você desenhar o polígono, só as cidades daquele vendedor entram na
captura — mesmo que o polígono acabe passando perto de cidades de outros vendedores.
Escolha "— Todos —" no filtro para voltar a ver o mapa completo.

### Adicionando uma cidade "avulsa" numa região
Nem toda cidade de uma região vai necessariamente cair dentro do polígono desenhado —
às vezes você quer incluir uma cidade específica manualmente. No formulário de criar
ou editar região, logo abaixo da lista de cidades capturadas, tem um campo **"+
Adicionar cidade à região"**: escolha a cidade na lista e clique em "+ Adicionar" — ela
entra na lista já marcada, junto com as demais. Funciona tanto ao criar uma região nova
quanto ao editar uma já existente.

### Cerca eletrônica (contorno real das cidades da região)
Ao clicar no nome de uma região, o app desenha automaticamente um contorno azul
tracejado ao redor dela — mas agora esse contorno segue o **limite administrativo
real de cada cidade** (a fronteira do município, não só uma linha ligando os pontos),
unindo o contorno de todas as cidades da região em um único desenho. Como isso busca
o limite de cada cidade em um serviço externo, aparece uma barra de progresso
enquanto calcula (pode levar alguns segundos, mais tempo quanto mais cidades a
região tiver). Se alguma cidade não tiver contorno disponível no serviço gratuito, o
app tenta usar as demais; se nenhuma tiver, cai de volta para uma casca convexa
simples ao redor dos pontos (melhor que nada).

O painel de detalhes que abre ao lado **não tampa mais o mapa** — ele fica flutuando
no canto, e dá pra continuar vendo e navegando no mapa por baixo/ao redor dele. Tem
um botão **"—" (minimizar)** que encolhe o painel para uma barrinha pequena, deixando
o mapa totalmente livre, sem perder o que já foi calculado (a cerca e os anéis
continuam no mapa mesmo com o painel minimizado) — clique de novo para expandir.

### Vendo em qual raio (50, 100, 150... km) uma região se enquadra
A lista de regiões na barra lateral já mostra o raio de cada uma direto na linha
(junto com quantidade de cidades e perfil de veículo) — calculado automaticamente em
segundo plano ao abrir o app. Enquanto calcula, aparece "calculando raio…"; pode levar
alguns segundos dependendo de quantas regiões e cidades existem.

Clique no nome de qualquer região (não no "editar") para abrir um painel com o
detalhamento completo: a distância rodoviária de ida, a partir de Terra Boa - PR, até
cada cidade daquela região, ordenadas da mais distante para a mais próxima. O raio geral da região é
definido pela **cidade mais distante**, arredondado para cima em faixas de 50 km — por
exemplo, uma cidade a 57 km enquadra a região no raio de até 100 km; uma cidade a 112
km enquadra no raio de até 150 km.

Tem também um botão **"Mostrar anéis de 50 km no mapa"**, que desenha círculos
concêntricos a partir da origem (a cada 50 km, até o raio da região) diretamente no
mapa — útil para visualizar de forma gráfica onde a região se encaixa.

### Menu de exportação (consolidado)
Os botões de exportar viraram um único menu: **"Exportar dados ▾"**. Clique nele,
marque quais arquivos você quer (Regiões, Cidades/geocodificação, Diretório), e
clique em "Exportar selecionados" — baixa só o que você marcou, de uma vez.

### Gerando um PDF do roteiro
Clique em **"📄 Gerar PDF"** na barra do admin. Você escolhe:
- **Escopo**: roteiro de um vendedor específico, de uma região específica, ou de
  todas as regiões num documento só.
- **O que incluir**: distância de ida, distância de ida e volta, o vendedor
  responsável por cada cidade, e o perfil mínimo de veículo de cada região.

Ao clicar em "Gerar PDF", se alguma distância ainda não tiver sido calculada, o app
calcula na hora (mostra uma barra de progresso) antes de montar o arquivo. O PDF sai
formatado com cabeçalho, logo, tabelas por região, e baixa direto pro computador —
pronto pra imprimir ou mandar pro vendedor.

### Detectando regiões com vendedores cruzados
Clique em **"⚠ Conflitos de vendedor"** na barra do admin. O painel mostra sozinho
todas as regiões que têm cidades de mais de um vendedor — útil pra garantir que cada
região/rota fique com um vendedor só, como pedido pelo gerente comercial.

Pra cada cidade "fora do padrão" numa região, o app sugere pra qual outra região ela
se encaixaria melhor (a região onde aquele vendedor já atende mais cidades), com um
botão **"Aplicar sugestão"** — mas nada muda sozinho, só depois que você confirma.

Tem também um campo de comando simples: digite algo como `mover Jataizinho para
Arapongas` e clique em "Interpretar comando" — ele mostra uma prévia do que vai
acontecer, e só aplica depois que você clicar em "Confirmar". Importante: isso **não é
uma IA de verdade** (que entenderia qualquer frase) — é um reconhecedor de comando
simples, no formato fixo "mover [cidade] para [região]". Pra qualquer outra mudança,
use os botões de sugestão ou edite a região manualmente pela lista.

### Adicionando uma cidade nova que ainda não existe na base
Se precisar atender uma cidade que ainda não está cadastrada, clique em **"+ Nova
cidade"** na barra do admin:

1. Digite o nome da cidade e escolha a UF.
2. Marque qual(is) vendedor(es) vai(vão) atender essa cidade — a lista já vem com
   todos os vendedores que já existem no sistema.
3. Se quiser, escolha uma região pra já incluir essa cidade direto (opcional — dá pra
   deixar sem região por enquanto e organizar depois).
4. Clique em **"Adicionar cidade"**.

O app localiza a cidade sozinho no mapa, adiciona ela na lista de cidades do(s)
vendedor(es) escolhido(s), e, se você escolheu uma região, ela já entra na região na
hora — a cerca eletrônica e o raio daquela região são recalculados automaticamente pra
já refletir a cidade nova (se o painel daquela região estiver aberto no momento, ele
atualiza na tela em tempo real).

**Publicando a cidade nova pra todo mundo ver**: como cidades e vendedores também
seguem o mesmo modelo de rascunho local das regiões, depois de adicionar uma ou mais
cidades, clique em **"Exportar diretório (vendedores/cidades)"** — isso baixa três
arquivos (`sellers.json`, `cities_list.json`, `city_to_sellers.json`). Suba os três
por cima no GitHub, na pasta `data/`, do mesmo jeito que faz com `regions.json` e
`cities.json`.

### Salvando as alterações para todo mundo ver (importante!)
Como o site é estático (sem banco de dados), as edições do admin ficam guardadas
**só no navegador dele** até serem publicadas. Para tornar as mudanças visíveis a
todos os vendedores:

1. No painel do admin, clique em **"Exportar regions.json"** — isso baixa o arquivo
   atualizado com todas as regiões.
2. Suba esse arquivo para o GitHub, substituindo `data/regions.json` no repositório
   (pode editar direto pela interface web do GitHub: abra o arquivo, clique no lápis
   de editar, cole o conteúdo novo, e faça o commit).
3. Em alguns segundos o GitHub Pages atualiza e todo mundo passa a ver as regiões novas.

Também clique em **"Exportar cities.json"** de vez em quando e suba esse arquivo junto —
ele guarda as coordenadas já localizadas de cada cidade, para que o site não precise
buscar tudo de novo (mais rápido) toda vez que alguém abre pela primeira vez.

---

## 4. Editar a lista de vendedores/cidades ou os perfis de veículo

- `data/sellers.json` — vendedor → lista de cidades que ele atende
- `data/city_to_sellers.json` — o inverso (gerado a partir do sellers.json)
- `data/cities_list.json` — lista única de todas as cidades
- `data/vehicle_profiles.json` — perfis de veículo e capacidade em kg

Se você adicionar/remover cidades ou vendedores, edite `sellers.json` e regenere os
outros dois arquivos (`cities_list.json` e `city_to_sellers.json`) a partir dele, ou
me peça e eu regenero pra você a partir de uma planilha nova.

---

## 6. Modo apresentação

Clique em **"🖥️ Apresentar"** no canto superior direito (funciona tanto no modo
visualização quanto no modo admin) — esconde o topo, a barra do admin e a barra
lateral, deixando só o mapa na tela, e tenta abrir em tela cheia de verdade também.
Ótimo pra projetar numa reunião sem mostrar botões e menus.

Pra sair: clique no botãozinho **"✕ Sair da apresentação"** que aparece no canto, ou
aperte **Esc**.

## 7. Identidade visual (cores, fonte e logo)

O app já segue a paleta e a tipografia do Portal de Cargas GTF: fundo azul-marinho
escuro no topo, destaque em verde-azulado (teal), e fonte Inter em vez da fonte
padrão do sistema.

**Sobre o logo**: já está usando o logotipo oficial da GTF (`img/logo.png`). Se quiser
trocar por uma versão em resolução maior ou outro formato, é só substituir esse
arquivo (mantendo o nome `logo.png`, ou ajustando o `src` no `index.html` se mudar a
extensão).

Se quiser ajustar as cores exatas (o teal ou o azul-marinho, por exemplo, caso a
marca oficial use tons ligeiramente diferentes), os valores ficam centralizados no
topo do arquivo `css/style.css`, dentro do bloco `:root` — é só trocar o valor
hexadecimal de `--accent` (verde-azulado) ou `--navy` (azul-marinho escuro).

## 5. Limites a saber

- **Nominatim** (geocodificação) e **OSRM** (rotas) são serviços públicos e gratuitos,
  mas têm limite de uso razoável — o app já respeita isso (não faz mais de 1 busca de
  cidade por segundo, e só calcula rota quando alguém clica). Para uso normal da
  equipe, isso não deve ser um problema.
- Os hashes de senha protegem contra **uso indevido casual**, não contra um ataque
  técnico sério — é adequado para controlar quem edita as regiões, não para proteger
  informação sigilosa.
- No **modo visualização**, todas as ações que alteram dados (criar/editar/excluir
  região, arrastar pin, buscar/corrigir endereço, adicionar cidade a uma região) ficam
  bloqueadas duas vezes: primeiro porque os botões nem aparecem na tela, e segundo
  porque cada função que altera dado confere de novo se a sessão é de admin antes de
  fazer qualquer coisa. Isso evita que essas ações rodem por engano ou por algum
  atalho fora do fluxo normal da interface.
- A **origem** usa coordenadas fixas (`ORIGIN_LAT`/`ORIGIN_LNG` em `js/config.js`), e
  não tenta geocodificar o nome "GTF - Unidade Terra Boa" — nomes de empresa não são
  reconhecidos pelo Nominatim, só endereços/cidades públicos. O valor padrão é o
  centro da cidade de Terra Boa - PR; se a unidade fica em outro ponto exato da
  cidade, ajuste esses dois números (clique com o botão direito no local certo no
  Google Maps e copie a latitude/longitude que aparece).
- Se o cálculo de distância der erro, a mensagem agora mostra o motivo (ex: origem
  sem coordenadas, cidade sem coordenadas, ou o próprio OSRM fora do ar) — isso ajuda
  a diagnosticar rápido caso aconteça de novo.
- Cidade **"Brasiléia - AC"** (vendedor "A & D") ficou fora do eixo PR/SP das demais —
  verifique se não é erro de digitação da planilha original.
