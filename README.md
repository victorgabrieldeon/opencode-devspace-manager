# DevSpace Manager

Cockpit de desenvolvimento local para a TUI do OpenCode V2. Descobre projetos com `devspace.yaml`, acompanha sessoes DevSpace existentes e reune pods, logs, URLs, diagnosticos e metricas em uma interface de terminal.

```text
DEVSPACE  /  meu-projeto                      HEALTHY
7/7 pods prontos  |  7 servicos  |  2 avisos

Pods             Logs                   URLs e proxies
> api   Running  12:30 INFO Ready       http://api.localhost:8080/
  db    Running  12:31 INFO Connected   http://localhost:8080/

8 Doctor  9 Timeline  0 Mapa  m Metricas  S Shell  A Analisar
```

## Recursos

- **Overview:** prontidao, reinicios recentes e historicos, servicos, alertas e tempo de estabilidade dos containers.
- **Pods e logs:** detalhes por container, logs do Kubernetes e arquivos em `.devspace/logs`, com busca, filtros, pausa e follow.
- **Doctor:** consultas de leitura ao Docker, Kubernetes, DNS, port forwards, PVCs, readiness probes e Metrics API. Mostra evidencias; nao executa reparos.
- **Metricas:** usa a Metrics API quando disponivel. Se ela falhar, tenta `docker stats` do **node Docker** e identifica esses valores como metricas do node, nunca dos pods.
- **Timeline e mapa:** eventos Kubernetes e ultimos reinicios; ligacoes Service -> Pod verificadas pelos selectors do Kubernetes. Nao inventa dependencias de aplicacao.
- **URLs:** mostra ingressos e proxies locais. Em Linux, uma URL de port forward so e exibida quando a porta esta aberta pelo processo DevSpace detectado.
- **Acoes:** abre URLs, copia links, inicia/para apenas sessoes criadas por esta TUI, abre um shell no pod selecionado e retorna a TUI ao sair.
- **AI Debugger:** `A` cria uma sessao OpenCode no projeto com metadados do pod e pede uma investigacao de leitura. Nao inclui conteudo de logs ou valores de variaveis no prompt inicial.

A tela se adapta a terminais largos e estreitos. Sessoes DevSpace iniciadas em outro terminal podem ser acompanhadas, mas este plugin nao as encerra.

## Requisitos

- OpenCode **V2** com suporte a plugins de TUI.
- DevSpace CLI e `kubectl` no `PATH`; um projeto com `devspace.yaml` ou `devspace.yml` e acesso ao contexto Kubernetes correspondente.
- Node.js e pnpm para instalar dependencias locais; Bun para rodar testes e gerar o servidor MCP opcional.
- Linux para identificar processos DevSpace externos e confirmar que port forwards pertencem a eles. Em outras plataformas, as consultas ao Kubernetes continuam disponiveis, mas essa identificacao nao e feita.
- Docker e Metrics API sao opcionais. A ausencia deles aparece como dado indisponivel, nao como consumo estimado de um pod.

## Instalacao no OpenCode V2

O OpenCode descobre automaticamente `index.ts` e `tui.tsx` em sua pasta global de plugins. Clone o repositorio diretamente nela:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
git clone https://github.com/victorgabrieldeon/opencode-devspace-manager.git \
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/devspace-manager"
cd "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/devspace-manager"
pnpm install --frozen-lockfile
```

Reinicie a TUI e execute `/devspace` (ou procure **Gerenciar DevSpace** na paleta). `/devspace-doctor` abre diretamente o diagnostico. Se o seu executavel V2 se chama `opencode2`, use esse comando para abrir a TUI.

Por padrao, o plugin busca projetos ate quatro niveis abaixo de `~/code` e tambem inclui o diretorio ativo se ele contiver uma configuracao DevSpace.

## Atalhos

| Tecla | Acao |
| --- | --- |
| `1`-`9`, `0`, `m` | Overview, projetos, pods, logs, URLs, DevSpace, configuracoes, Doctor, timeline, mapa e metricas |
| `j` / `k` | Selecionar pod ou rolar a tela atual |
| `p` / `d` | Escolher projeto / pod |
| `l` / `g` | Logs do pod / arquivos de log DevSpace |
| `o` / `u` / `c` | Abrir URL / ver URLs / copiar todas as URLs (OSC 52) |
| `S` | Shell interativo no pod selecionado; ao sair, a TUI volta |
| `A` | Criar uma sessao OpenCode para analisar o pod |
| `r` / `?` / `q` | Atualizar / ajuda / sair do painel |

Na tela de logs: `/` busca nas ultimas linhas; `f` alterna follow; espaco pausa; `e` filtra erros; `w` filtra avisos; `t` alterna timestamps; `c` limpa a visualizacao e pausa a atualizacao.

## Como os dados sao obtidos

O plugin le o nome e os selectors de `devspace.yaml`, o ultimo contexto/namespace de `.devspace/cache.yaml` (ou o contexto atual do `kubectl`), recursos Kubernetes rotulados para o projeto e portas declaradas por `devspace list ports`. Os arquivos de log DevSpace sao lidos pelo final, com limite de tamanho. A consulta aos pods nao le recursos de outros namespaces para compor o painel.

O Doctor e o overview distinguem reinicios historicos de reinicios recentes: uma contagem acumulada alta, por si so, nao marca um ambiente como degradado. A analise de IA e o shell so sao iniciados quando voce aciona suas teclas.

## Desenvolvimento

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`src/tui.tsx` contem a interface; `src/observability.ts` consulta o ambiente; `src/diagnostics.ts` calcula saude, Doctor, timeline e mapa. `src/manager.ts` controla apenas os processos que o plugin inicia.

O repositorio tambem inclui uma integracao MCP para Codex Desktop em `.codex-plugin/`. Ela e opcional para o OpenCode e usa o servidor gerado por `pnpm build` em `dist/server.mjs`.

## Licenca

MIT. Consulte [LICENSE](LICENSE).
