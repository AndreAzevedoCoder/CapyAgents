# Projeto: plataforma local de agentes com escritório 3D

## Objetivo
Crie um projeto open source para orquestrar agentes Claude em pipelines complexas de software e automação, com um escritório 3D limpo, no estilo Gather, que mostre o que está acontecendo em tempo real.

O projeto roda localmente e é instalado a partir do GitHub. Não é um SaaS: não implemente cadastro, cobrança, multi-tenant ou deploy em nuvem.

## Stack e instalação
- Use TypeScript em todo o projeto, React com React Three Fiber no frontend, Node.js no backend, Claude Agent SDK e SQLite.
- Use WebSocket para atualizar a interface em tempo real.
- O servidor deve escutar apenas em `127.0.0.1`.
- A chave da API deve vir de um `.env`, nunca do código ou dos logs.
- Depois de clonar o repositório, deve bastar configurar o `.env` e rodar um único comando de instalação e outro de execução.
- Voce deve usar Django

## Definição dos agentes
Cada tipo de agente fica em `agents/<nome>/`:

- `AGENT.md`: papel, instruções, entregas esperadas e quando pedir ajuda.
- `agent.json`: configuração e permissões, seguindo este formato:

```json
{
  "name": "dev",
  "model": "claude-sonnet-5-5",
  "instances": 2,
  "hat": "cowboy",
  "tools": { "allow": ["read", "edit", "bash"], "deny": ["web"] },
  "paths": { "allow": ["./workspace"], "deny": ["./.env"] },
  "can_talk_to": ["reviewer", "planner"],
  "requires_approval_from": { "bash": "reviewer" }
}
```

- O `agent.json` é a fonte de verdade para permissões e comunicação. O `AGENT.md` não pode ampliá-las.
- Valide os arquivos ao carregar e mostre erros claros.
- Permita criar e editar agentes pela interface, gravando nesses mesmos arquivos.
- Mantenha a lista de modelos em um arquivo de configuração, para que um modelo novo não exija alteração no código. Cada agente pode usar um modelo diferente, como Opus, Sonnet ou Fable.

## Runtime
- Aplique as permissões no backend, antes de executar cada ferramenta ou entregar cada mensagem. Nunca dependa apenas do prompt para isso.
- Registre em log as ações bloqueadas e informe o motivo ao agente.
- Cada agente deve ter um estado visível: `idle`, `working`, `waiting`, `in_meeting`, `blocked`, `done` ou `error`.
- Permita pausar, retomar e encerrar cada agente.
- Salve agentes, mensagens, tarefas e logs no SQLite, para que o histórico sobreviva a um reinício.
- Mostre o consumo de tokens e o custo estimado por agente e por pipeline. Permita definir um limite de gasto que pause a execução ao ser atingido.
- Quando um agente interagir com outro isso deve ser claro
- Quando um agente estiver trabalhando isso deve ser claro


## Execução paralela
- Permita criar várias instâncias a partir do mesmo `AGENT.md`, com nomes como `dev-1` e `dev-2`.
- Cada instância deve ter sessão, logs e estado próprios.
- Em tarefas de código, cada instância deve trabalhar em uma git worktree separada. O merge deve ser uma etapa explícita da pipeline.

## Comunicação e aprovações
Implemente um barramento de mensagens tipadas: `message`, `question`, `permission_request` e `permission_response`.

- Um agente pode fazer uma pergunta ou pedir permissão a outro quando tiver dúvida ou quando sua configuração exigir.
- Enquanto espera uma resposta, ele fica em `waiting` e retoma a tarefa ao recebê-la.
- Pedidos sem resposta dentro do tempo limite devem ser escalados para mim.
- Detecte ciclos de espera, como A aguardando B e B aguardando A, e escale esses casos para mim.
- Eu devo poder responder ou aprovar qualquer pedido pela interface.

## Reuniões
- Permita reuniões 1:1 e em grupo, iniciadas por mim ou por um agente autorizado.
- Cada reunião tem pauta, participantes, turnos moderados e limite de rodadas.
- Ao final, salve a transcrição e um resumo com decisões e próximos passos no contexto dos participantes.
- No 3D, os participantes caminham até uma sala de reunião e voltam ao terminar.

## Pipelines
Defina pipelines em `pipelines/<nome>.yaml`, como um grafo de etapas com:

- agente responsável;
- entradas e saídas;
- dependências;
- etapas paralelas;
- aprovação humana opcional;
- critério de conclusão;
- política de retry.

A interface deve permitir iniciar, pausar e acompanhar cada execução, mostrando etapa atual, bloqueios e artefatos gerados.

## Mundo 3D
- Crie um escritório 3D simples no navegador, com mesas, sala de reunião e câmera orbital com zoom.
- Priorize legibilidade e bom desempenho com pelo menos 20 agentes.
- Todos os agentes usam o modelo `assets/Meshy_AI_Sunny_Fluffbear_1103224035_texture.glb`. O que os diferencia é o chapéu.
- Inspecione o `.glb` antes de implementar. Verifique se ele tem esqueleto e animações. Se não tiver, use animações procedurais simples de andar, trabalhar e ficar parado.
- Reaproveite geometria e texturas entre as instâncias.
- Os chapéus ficam em `assets/hats/*.glb`, e cada um pode ter ajustes próprios de posição, rotação e escala.
- Inclua alguns chapéus de exemplo e permita adicionar outros colocando um arquivo na pasta. Eu devo poder escolher o chapéu de cada agente pela interface.
- Mostre sempre o nome do agente sobre a cabeça, voltado para a câmera, junto com um indicador discreto de estado.
- O movimento deve refletir eventos reais do runtime, nunca ser apenas decorativo.

## Interação
Ao clicar em um agente, abra um painel com:

- nome, modelo, chapéu, estado e tarefa atual;
- logs em tempo real, com filtros para raciocínio resumido, ferramentas, mensagens e erros;
- chat direto com o agente;
- pedidos pendentes e botões para aprovar ou negar;
- botões para pausar, retomar e encerrar.

Mensagens enviadas enquanto o agente trabalha entram em uma fila e são entregues no próximo ponto seguro da execução.

## Critério de aceite
Inclua uma pipeline de demonstração que crie um pequeno app de tarefas usando estes agentes:

- `planner` (Opus), que divide o trabalho;
- `dev-1` e `dev-2` (Sonnet), que implementam em paralelo em worktrees separadas;
- `reviewer` (Opus), que revisa, faz uma reunião com os devs e aprova o merge.

A demonstração só está pronta quando, em uma instalação limpa:

1. os quatro agentes aparecem no 3D com nomes e chapéus diferentes;
2. um pedido de permissão aparece na interface e pode ser aprovado;
3. uma ação proibida pelo `agent.json` é bloqueada e registrada;
4. consigo clicar em um agente, ler seus logs e falar com ele;
5. a pipeline termina com o código integrado e o histórico continua disponível após reiniciar o sistema.

Inclua testes do motor de permissões, do barramento de mensagens e do executor de pipelines, além de um README com instalação, configuração e criação de agentes.

## Como trabalhar
1. Inspecione o repositório e o `.glb`.
2. Apresente a arquitetura, a estrutura de pastas e as principais decisões técnicas.
3. Pergunte apenas o que bloquear o trabalho e espere minha aprovação antes de implementar.
4. Depois, entregue nesta ordem, mantendo o projeto executável e testado ao fim de cada etapa:
   - runtime com um agente, logs e permissões;
   - mensagens, aprovações e paralelismo;
   - pipelines e reuniões;
   - mundo 3D e painel do agente;
   - demonstração, testes finais e README.