import { useState } from 'react';
import type { BusMessage } from '@capyagents/shared';
import { useOffice } from '../state/store';

function Approval({ m }: { m: BusMessage }) {
  const send = useOffice((s) => s.send);
  const [text, setText] = useState('');
  const isPermission = m.type === 'permission_request';

  const respond = (approved?: boolean) => {
    send({ type: 'respond', messageId: m.id, approved, text: text || undefined });
  };

  return (
    <div className="approval">
      <div className="meta">
        {m.from} · {isPermission ? 'pedido de permissão' : 'pergunta'}
        {m.status === 'escalated' && ' · escalado'}
      </div>
      <div>{m.content}</div>
      {m.tool && (
        <div className="meta" style={{ marginTop: 4 }}>
          ferramenta: {m.tool}
        </div>
      )}
      <textarea
        placeholder={isPermission ? 'justificativa (opcional)' : 'sua resposta'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        {isPermission ? (
          <>
            <button className="primary" onClick={() => respond(true)}>
              Aprovar
            </button>
            <button className="danger" onClick={() => respond(false)}>
              Negar
            </button>
          </>
        ) : (
          <button className="primary" disabled={!text.trim()} onClick={() => respond()}>
            Responder
          </button>
        )}
      </div>
    </div>
  );
}

export function Approvals() {
  const pending = useOffice((s) => s.pendingForHuman);
  const selected = useOffice((s) => s.selectedId);
  if (pending.length === 0 || selected) return null; // o painel do agente ocupa a direita
  return (
    <div className="approvals panel">
      <h3>Esperando por você ({pending.length})</h3>
      {pending.map((m) => (
        <Approval key={m.id} m={m} />
      ))}
    </div>
  );
}

export { Approval };
