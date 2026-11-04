import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogKind } from '@agent-office/shared';
import { useOffice } from '../state/store';
import { STATE_COLORS, STATE_LABELS } from '../stateColors';
import { Approval } from './Approvals';

type Tab = 'logs' | 'chat' | 'pedidos';

// referência estável para seletores (evita re-render infinito do zustand)
const NO_LOGS: never[] = [];

const FILTERS: Array<{ key: string; label: string; kinds: LogKind[] }> = [
  { key: 'thinking', label: 'raciocínio', kinds: ['thinking'] },
  { key: 'tools', label: 'ferramentas', kinds: ['tool', 'tool_result'] },
  { key: 'messages', label: 'mensagens', kinds: ['message'] },
  { key: 'perms', label: 'permissões', kinds: ['permission'] },
  { key: 'errors', label: 'erros', kinds: ['error', 'system'] },
];

export function AgentPanel() {
  const selectedId = useOffice((s) => s.selectedId);
  const instance = useOffice((s) => (s.selectedId ? s.instances[s.selectedId] : null));
  const logs = useOffice((s) => (s.selectedId ? s.logs[s.selectedId] ?? NO_LOGS : NO_LOGS));
  const pending = useOffice((s) => s.pendingForHuman);
  const hats = useOffice((s) => s.hats);
  const send = useOffice((s) => s.send);
  const select = useOffice((s) => s.select);

  const [tab, setTab] = useState<Tab>('logs');
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [chat, setChat] = useState('');
  const logsRef = useRef<HTMLDivElement>(null);

  const fromAgent = useMemo(
    () => pending.filter((m) => m.from === selectedId),
    [pending, selectedId],
  );

  const activeKinds = useMemo(() => {
    const anyOn = FILTERS.some((f) => on[f.key]);
    const set = new Set<LogKind>();
    for (const f of FILTERS) if (!anyOn || on[f.key]) f.kinds.forEach((k) => set.add(k));
    return set;
  }, [on]);

  const visible = useMemo(() => logs.filter((l) => activeKinds.has(l.kind)), [logs, activeKinds]);

  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, tab]);

  if (!instance) return null;
  const color = STATE_COLORS[instance.state];

  const sendChat = () => {
    const text = chat.trim();
    if (!text) return;
    send({ type: 'chat', instanceId: instance.id, text });
    setChat('');
    setTab('logs');
  };

  return (
    <div className="agentpanel panel">
      <header>
        <div className="row1">
          <h2>{instance.id}</h2>
          <span className="badge" style={{ background: `${color}33`, color }}>
            {STATE_LABELS[instance.state]}
          </span>
          <button onClick={() => select(null)} title="fechar">
            ✕
          </button>
        </div>
        <div className="row2">
          <span>{instance.model}</span>
          <span>
            {(instance.tokensIn / 1000).toFixed(1)}k in · {(instance.tokensOut / 1000).toFixed(1)}k
            out · ${instance.costUsd.toFixed(4)}
          </span>
          <label>
            chapéu{' '}
            <select
              value={instance.hat}
              onChange={(e) => send({ type: 'set_hat', agent: instance.agent, hat: e.target.value })}
            >
              <option value="none">nenhum</option>
              {hats.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.id}
                </option>
              ))}
            </select>
          </label>
          {instance.interactingWith && <span>falando com {instance.interactingWith}</span>}
          {instance.queuedMessages > 0 && <span>{instance.queuedMessages} na fila</span>}
          {instance.workdir && <span title={instance.workdir}>worktree ativa</span>}
        </div>
        {instance.task && <div className="task">{instance.task}</div>}
        <div className="controls">
          {instance.state === 'paused' ? (
            <button className="primary" onClick={() => send({ type: 'control', instanceId: instance.id, action: 'resume' })}>
              Retomar
            </button>
          ) : (
            <button onClick={() => send({ type: 'control', instanceId: instance.id, action: 'pause' })}>
              Pausar
            </button>
          )}
          <button
            className="danger"
            onClick={() => send({ type: 'control', instanceId: instance.id, action: 'stop' })}
          >
            Encerrar
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>
          Logs
        </button>
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          Chat
        </button>
        <button className={tab === 'pedidos' ? 'active' : ''} onClick={() => setTab('pedidos')}>
          Pedidos{fromAgent.length > 0 ? ` (${fromAgent.length})` : ''}
        </button>
      </div>

      {tab !== 'pedidos' && (
        <>
          {tab === 'logs' && (
            <div className="logfilters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={on[f.key] ? 'on' : ''}
                  onClick={() => setOn((s) => ({ ...s, [f.key]: !s[f.key] }))}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          <div className="logs" ref={logsRef}>
            {visible.length === 0 && (
              <div className="panel-empty">
                Sem registros ainda. Mande uma mensagem no chat ou atribua uma tarefa.
              </div>
            )}
            {visible.map((l) => (
              <div key={l.id} className={`logline k-${l.kind}`}>
                <span className="k">{kindTag(l.kind)}</span>
                {l.text}
              </div>
            ))}
          </div>
          <div className="chatbox">
            <input
              placeholder={
                instance.state === 'working'
                  ? 'entra na fila e é entregue no próximo ponto seguro…'
                  : `falar com ${instance.id}…`
              }
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            />
            <button className="primary" onClick={sendChat}>
              Enviar
            </button>
          </div>
        </>
      )}

      {tab === 'pedidos' && (
        <div className="pending-list">
          {fromAgent.length === 0 && (
            <div className="panel-empty">Nenhum pedido deste agente esperando por você.</div>
          )}
          {fromAgent.map((m) => (
            <Approval key={m.id} m={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function kindTag(kind: LogKind): string {
  switch (kind) {
    case 'thinking':
      return '…';
    case 'tool':
      return '⚙';
    case 'tool_result':
      return '↳';
    case 'message':
      return '✉';
    case 'permission':
      return '🛡';
    case 'error':
      return '✗';
    case 'system':
      return '·';
  }
}
