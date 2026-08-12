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
2. Clique em **"Desenhar nova região"** e desenhe um polígono no mapa em volta das
   cidades que devem compor a região (clique para adicionar pontos, dê duplo clique
   para fechar o polígono).
3. Um formulário abre com as cidades detectadas dentro do polígono. Você pode:
   - Desmarcar cidades que não devem entrar
   - Dar um nome à região (ex: `REGIÃO FOOD MARINGÁ`)
   - Escolher o perfil mínimo de veículo
4. Clique em **Salvar região**.
5. Repita para as demais regiões. Para editar ou excluir uma região já criada, clique
   em "editar" na lista de regiões da barra lateral.

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

## 5. Limites a saber

- **Nominatim** (geocodificação) e **OSRM** (rotas) são serviços públicos e gratuitos,
  mas têm limite de uso razoável — o app já respeita isso (não faz mais de 1 busca de
  cidade por segundo, e só calcula rota quando alguém clica). Para uso normal da
  equipe, isso não deve ser um problema.
- Os hashes de senha protegem contra **uso indevido casual**, não contra um ataque
  técnico sério — é adequado para controlar quem edita as regiões, não para proteger
  informação sigilosa.
- Cidade **"Brasiléia - AC"** (vendedor "A & D") ficou fora do eixo PR/SP das demais —
  verifique se não é erro de digitação da planilha original.
