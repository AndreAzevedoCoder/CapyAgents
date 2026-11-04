# CapyAgents

Plataforma local e open source para orquestrar agentes Claude em pipelines de software e automação — com um escritório 3D no navegador, estilo Gather, que mostra em tempo real o que cada agente está fazendo.

Cada agente é uma capivara com chapéu. Quando trabalha, a mesa acende; quando pergunta algo a outro agente, um arco liga os dois; quando há reunião, todos caminham até a sala. Tudo que você vê reflete eventos reais do runtime.

**Não é SaaS**: roda 100% na sua máquina (`127.0.0.1`), sem cadastro, sem cobrança, sem nuvem.

## Instalação

Pré-requisitos: Node.js 20+, git e o [Claude Code CLI](https://claude.com/claude-code) logado (`claude login`).

```bash
git clone <este-repositorio> capyagents
cd capyagents
cp .env.example .env   # opcional: ajuste porta e limite de gasto
npm run setup          # instala dependências e gera os assets 3D
npm run dev            # sobe servidor (4777) e interface (5173)
```

Abra http://127.0.0.1:5173.

### Autenticação

- **Padrão (assinatura)**: sem nada no `.env`, os agentes usam o login da sua assinatura feito com `claude login` — o runtime herda as credenciais do Claude CLI em `~/.claude`.
- **Alternativa (API)**: defina `ANTHROPIC_API_KEY` no `.env` para usar a API da Anthropic com cobrança por token.

A chave nunca aparece em logs nem no banco. O servidor escuta apenas em `127.0.0.1`.

### Produção local (opcional)

```bash
npm run build && npm start   # tudo em http://127.0.0.1:4777
```

## A demonstração

Na interface, clique em **iniciar** na pipeline `demo-todo-app`. Ela constrói um pequeno app de tarefas:

1. `planner` (Opus, chapéu de mago) divide o trabalho em duas partes;
2. `dev-1` e `dev-2` (Sonnet, chapéus de cowboy) implementam em paralelo, cada um em uma **git worktree** separada;
3. `reviewer` (Opus, cartola) revisa, convoca uma **reunião** com os devs e dá o veredito;
4. a etapa de **merge** pede a sua aprovação na interface e integra as branches na `main` do `workspace/`.

Durante a execução você verá: pedidos de permissão dos devs ao reviewer (comandos bash), estados mudando no 3D, a reunião na sala e o custo estimado acumulando na barra superior.

Para conferir o motor de permissões: clique em um dev e peça no chat "leia o arquivo .env". A chamada é **bloqueada no backend** (nunca pelo prompt) e registrada nos logs com o motivo.

## Vários projetos

A plataforma é um motor reutilizável: por padrão roda a demo embutida, mas você
pode apontá-la para outro projeto (com seus próprios `agents/`, `pipelines/` e
`config/`) pela variável `CAPYAGENTS_PROJECT`:

```bash
CAPYAGENTS_PROJECT=/caminho/do/projeto npm run dev
```

Nesse modo, os agentes rodam com o diretório de trabalho na raiz do projeto
(configurável em `config/project.json` com `{ "work_dir": "." }`), o histórico
(SQLite) e os artefatos ficam dentro do projeto, e os assets 3D (capivara,
chapéus) continuam vindo da plataforma.

## Como funciona

```
agents/<nome>/agent.json   permissões e configuração (fonte de verdade)
agents/<nome>/AGENT.md     papel e instruções (nunca amplia permissões)
pipelines/<nome>.yaml      grafo de etapas
config/models.json         modelos disponíveis e preços (edite sem tocar no código)
workspace/                 repositório git onde os agentes trabalham
data/                      SQLite + worktrees (apague para zerar o histórico)
assets/hats/*.glb          chapéus (solte um .glb novo aqui e ele aparece na UI)
```

### Agentes

Cada tipo de agente vive em `agents/<nome>/` com dois arquivos. O `agent.json`:

```json
{
  "name": "dev",
  "model": "claude-sonnet-5",
  "instances": 2,
  "hat": "cowboy",
  "tools": { "allow": ["read", "edit", "bash"], "deny": ["web"] },
  "paths": { "allow": ["./workspace"], "deny": ["./.env"] },
  "can_talk_to": ["reviewer", "planner"],
  "requires_approval_from": { "bash": "reviewer" },
  "max_turns": 80
}
```

- `tools`: grupos `read`, `edit`, `bash`, `web` (deny vence allow). O grupo `web` dá acesso à busca, ao WebFetch e à ferramenta `download_file`, que baixa um arquivo preservando os bytes originais (PDF, CSV, planilha) — o WebFetch devolve texto processado e não serve para guardar a fonte. O download é feito pelo servidor, sem shell, e o destino passa pela mesma checagem de `paths`; quem for ler o arquivo depois usa `Read`, que abre PDF nativamente. `tools.deny_commands` nega comandos de shell específicos por nome (ex.: `["ls","cat","find"]`) mesmo com `bash` permitido — a negação é local e instantânea, sem passar pelo aprovador, e redireciona o agente para Read/Glob/Grep;
- `paths`: caminhos relativos à raiz do projeto; deny vence; symlinks e `..` são resolvidos antes da checagem;
- `can_talk_to`: com quem o agente pode falar (o humano é sempre permitido);
- `requires_approval_from`: ferramenta → agente aprovador (ou `human`);
- `instances`: quantas instâncias criar (`dev-1`, `dev-2`, ...), cada uma com sessão, logs e estado próprios.

Os arquivos são validados ao carregar, com erros claros. Você também pode criar e editar agentes pela interface (botão **novo agente**) — ela grava nesses mesmos arquivos.

**As permissões são aplicadas no backend**, antes de cada ferramenta executar e de cada mensagem ser entregue (hook `PreToolUse` do Claude Agent SDK + motor próprio). O `AGENT.md` orienta o agente, mas nunca amplia o que o `agent.json` permite. Ações bloqueadas são registradas e o agente recebe o motivo.

### Comunicação e aprovações

Barramento de mensagens tipadas: `message`, `question`, `permission_request`, `permission_response`.

- Um agente pergunta (`ask_question`) e fica em `waiting` até a resposta;
- pedidos sem resposta em 120s são **escalados para você**;
- ciclos de espera (A aguarda B que aguarda A) são detectados e escalados na hora;
- todo pedido pendente aparece na interface com botões de aprovar/negar/responder.

### Pipelines

`pipelines/<nome>.yaml` descreve um grafo de etapas:

```yaml
name: minha-pipeline
steps:
  - id: implementar
    agent: dev            # tipo (qualquer instância livre) ou instância exata (dev-1)
    task: "implemente X usando o plano: {{steps.plan.output}}"
    depends_on: [plan]    # etapas sem dependência entre si rodam em paralelo
    worktree: true        # roda em git worktree isolada
    retries: 1
    human_approval: false # true = espera seu aprovar na interface
    done_when: critério de conclusão passado ao agente
  - id: merge
    agent: reviewer
    depends_on: [implementar]
    merge: true           # integra as worktrees das dependências na main
    human_approval: true
```

A interface permite iniciar, pausar, retomar e cancelar execuções, vendo etapa atual, instância responsável, erros e artefatos. Ciclos de dependência são rejeitados na validação.

### Reuniões

1:1 ou em grupo, iniciadas por você (**convocar**) ou por um agente autorizado (`request_meeting`). Têm pauta, turnos moderados em rodadas e limite de rodadas; falas são sem ferramentas (conversa pura). Ao final, a transcrição e um resumo com decisões/próximos passos são salvos e entregues ao contexto de cada participante. No 3D, os participantes caminham até a sala e voltam ao terminar.

### Estados visíveis

`idle` · `working` · `waiting` · `in_meeting` · `blocked` · `paused` · `done` · `error` — na cor do ponto sobre a cabeça, no painel e no trilho da equipe.

### Custo e orçamento

Tokens e custo estimado por instância e por pipeline. O número vem do próprio SDK quando ele o informa; na falta dele, é calculado pelos preços de `config/models.json`.

**Com assinatura (o padrão), não há cobrança por token** — o valor é uma estimativa de quanto aquele consumo custaria pela API, útil para comparar agentes e achar quem está gastando demais. Por isso o limite vem **desligado**: defina um na barra superior (ou `BUDGET_USD` no `.env`) só se estiver usando `ANTHROPIC_API_KEY`. Ao atingir o limite a execução pausa, e ao aumentá-lo ou removê-lo os agentes retomam sozinhos.

### Persistência

Agentes, mensagens, tarefas, logs, reuniões e execuções ficam em SQLite (`data/office.db`) e sobrevivem a reinícios. Execuções interrompidas voltam pausadas, prontas para retomar.

## Interface

- **Clique em um agente**: a câmera vai até a frente dele, em três quartos, para mostrar o rosto, e o acompanha se ele caminhar; clicar fora volta à vista geral. Abre também o painel com nome, modelo, chapéu, estado, tarefa, logs em tempo real (filtros: raciocínio, ferramentas, mensagens, permissões, erros), chat direto, pedidos pendentes e botões de pausar/retomar/encerrar.
- Mensagens enviadas enquanto o agente trabalha entram na fila e são entregues no próximo ponto seguro.
- **Chapéus**: cada agente usa o mesmo modelo 3D; o chapéu diferencia. Troque pelo painel do agente. Para adicionar um chapéu, solte um `.glb` em `assets/hats/` e (opcional) ajuste posição/rotação/escala em `assets/hats/hats.json`.

## Testes

```bash
npm test
```

Cobrem o motor de permissões (grupos, paths, escapes por `..`/symlink, aprovações), o barramento (perguntas, aprovações, timeout com escalação, detecção de ciclo) e o executor de pipelines (paralelismo, interpolação, aprovação humana, retry) — com o SDK mockado.

## Solução de problemas

- **Agentes falham com erro de login**: rode `claude login`, ou defina `ANTHROPIC_API_KEY` no `.env`.
- **"limite atingido"**: aumente o limite na barra superior ou no `.env`.
- **Zerar tudo**: pare o servidor e apague a pasta `data/` (e `workspace/`, se quiser descartar o código gerado).
- O modelo 3D original tem 178k vértices; `npm run setup` gera uma versão otimizada (~28k) usada automaticamente.
