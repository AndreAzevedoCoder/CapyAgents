import { useMemo, useState } from 'react';
import type { AgentConfig } from '@agent-office/shared';
import { useOffice } from '../state/store';

const TOOL_GROUPS = ['read', 'edit', 'bash', 'web'] as const;

const DEFAULT_MD = `# Novo agente

## Papel
Descreva o papel deste agente.

## Instruções
- O que fazer e como.

## Entregas esperadas
- O que ele deve produzir.

## Quando pedir ajuda
- Em que situações deve perguntar (ask_question) em vez de seguir sozinho.
`;

export function AgentEditor() {
  const open = useOffice((s) => s.editorOpen);
  const editing = useOffice((s) => s.editorAgent);
  const agents = useOffice((s) => s.agents);
  const models = useOffice((s) => s.models);
  const hats = useOffice((s) => s.hats);
  const send = useOffice((s) => s.send);
  const close = useOffice((s) => s.closeEditor);

  const base = useMemo(() => agents.find((a) => a.config.name === editing), [agents, editing]);

  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [hat, setHat] = useState('none');
  const [instances, setInstances] = useState(1);
  const [allow, setAllow] = useState<string[]>(['read']);
  const [deny, setDeny] = useState<string[]>(['web']);
  const [denyCommands, setDenyCommands] = useState('');
  const [pathsAllow, setPathsAllow] = useState('./workspace\n./data/worktrees');
  const [pathsDeny, setPathsDeny] = useState('./.env');
  const [canTalkTo, setCanTalkTo] = useState<string[]>([]);
  const [approvals, setApprovals] = useState(''); // linhas "bash: reviewer"
  const [maxTurns, setMaxTurns] = useState(80);
  const [md, setMd] = useState(DEFAULT_MD);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>('__nunca__');

  if (!open) return null;

  // carrega os campos quando o modal abre para um agente específico
  const key = editing ?? '__novo__';
  if (loadedFor !== key) {
    setLoadedFor(key);
    setError(null);
    if (base) {
      const c = base.config;
      setName(c.name);
      setModel(c.model);
      setHat(c.hat);
      setInstances(c.instances);
      setAllow(c.tools.allow);
      setDeny(c.tools.deny);
      setDenyCommands((c.tools.deny_commands ?? []).join(' '));
      setPathsAllow(c.paths.allow.join('\n'));
      setPathsDeny(c.paths.deny.join('\n'));
      setCanTalkTo(c.can_talk_to);
      setApprovals(
        Object.entries(c.requires_approval_from)
          .map(([t, a]) => `${t}: ${a}`)
          .join('\n'),
      );
      setMaxTurns(c.max_turns);
      setMd(base.instructions);
    } else {
      setName('');
      setModel(models[0]?.id ?? '');
      setHat(hats[0]?.id ?? 'none');
      setInstances(1);
      setAllow(['read']);
      setDeny(['web']);
      setDenyCommands('');
      setPathsAllow('./workspace\n./data/worktrees');
      setPathsDeny('./.env');
      setCanTalkTo([]);
      setApprovals('');
      setMaxTurns(80);
      setMd(DEFAULT_MD);
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, item: string) => {
    set(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  const save = () => {
    try {
      const requires: Record<string, string> = {};
      for (const line of approvals.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const [tool, approver] = t.split(':').map((s) => s.trim());
        if (!tool || !approver) throw new Error(`linha inválida em aprovações: "${line}" (use "ferramenta: aprovador")`);
        requires[tool] = approver;
      }
      const config: AgentConfig = {
        name: name.trim(),
        model,
        instances,
        hat,
        tools: {
          allow,
          deny,
          deny_commands: denyCommands.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        },
        paths: {
          allow: pathsAllow.split('\n').map((s) => s.trim()).filter(Boolean),
          deny: pathsDeny.split('\n').map((s) => s.trim()).filter(Boolean),
        },
        can_talk_to: canTalkTo,
        requires_approval_from: requires,
        max_turns: maxTurns,
      };
      send({ type: 'save_agent', config, instructions: md });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        <h2>{base ? `Editar agente: ${base.config.name}` : 'Novo agente'}</h2>
        <div className="grid">
          <label>
            nome (pasta em agents/)
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(base)} placeholder="ex. tester" />
          </label>
          <label>
            modelo
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} (${m.inputPerMtok}/{m.outputPerMtok} por MTok)
                </option>
              ))}
            </select>
          </label>
          <label>
            chapéu
            <select value={hat} onChange={(e) => setHat(e.target.value)}>
              <option value="none">nenhum</option>
              {hats.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            instâncias padrão
            <input
              type="number"
              min={1}
              max={20}
              value={instances}
              onChange={(e) => setInstances(Number(e.target.value))}
            />
          </label>
          <label className="full">
            ferramentas permitidas
            <div className="checks">
              {TOOL_GROUPS.map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={allow.includes(t)} onChange={() => toggle(allow, setAllow, t)} />
                  {t}
                </label>
              ))}
            </div>
          </label>
          <label className="full">
            ferramentas negadas (vence o allow)
            <div className="checks">
              {TOOL_GROUPS.map((t) => (
                <label key={t}>
                  <input type="checkbox" checked={deny.includes(t)} onChange={() => toggle(deny, setDeny, t)} />
                  {t}
                </label>
              ))}
            </div>
          </label>
          <label className="full">
            comandos de shell negados (separados por espaço; negados na hora, sem aprovação)
            <input
              placeholder="ls cat find grep"
              value={denyCommands}
              onChange={(e) => setDenyCommands(e.target.value)}
            />
          </label>
          <label>
            caminhos permitidos (um por linha)
            <textarea rows={3} value={pathsAllow} onChange={(e) => setPathsAllow(e.target.value)} />
          </label>
          <label>
            caminhos negados
            <textarea rows={3} value={pathsDeny} onChange={(e) => setPathsDeny(e.target.value)} />
          </label>
          <label className="full">
            pode falar com
            <div className="checks">
              {agents
                .filter((a) => a.config.name !== name)
                .map((a) => (
                  <label key={a.config.name}>
                    <input
                      type="checkbox"
                      checked={canTalkTo.includes(a.config.name)}
                      onChange={() => toggle(canTalkTo, setCanTalkTo, a.config.name)}
                    />
                    {a.config.name}
                  </label>
                ))}
              {name && (
                <label>
                  <input
                    type="checkbox"
                    checked={canTalkTo.includes(name)}
                    onChange={() => toggle(canTalkTo, setCanTalkTo, name)}
                  />
                  {name} (entre instâncias)
                </label>
              )}
            </div>
          </label>
          <label>
            aprovações exigidas (ferramenta: aprovador)
            <textarea rows={2} placeholder={'bash: reviewer\nedit: human'} value={approvals} onChange={(e) => setApprovals(e.target.value)} />
          </label>
          <label>
            máx. de turnos por tarefa
            <input type="number" min={1} max={500} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} />
          </label>
          <label className="full">
            AGENT.md — papel e instruções (não amplia permissões)
            <textarea rows={10} value={md} onChange={(e) => setMd(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <footer>
          {base && (
            <button
              className="danger"
              style={{ marginRight: 'auto' }}
              onClick={() => {
                send({ type: 'delete_agent', agent: base.config.name });
                close();
              }}
            >
              Excluir agente
            </button>
          )}
          <button onClick={close}>Cancelar</button>
          <button className="primary" onClick={save} disabled={!name.trim() || !model}>
            Salvar em agents/{name.trim() || '…'}/
          </button>
        </footer>
      </div>
    </div>
  );
}
