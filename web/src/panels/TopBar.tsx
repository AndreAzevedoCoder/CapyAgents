import { useState } from 'react';
import { useOffice } from '../state/store';

export function TopBar() {
  const connected = useOffice((s) => s.connected);
  const cost = useOffice((s) => s.cost);
  const send = useOffice((s) => s.send);
  const [editingBudget, setEditingBudget] = useState<string | null>(null);

  const budget = cost?.budgetUsd ?? null;

  return (
    <div className="topbar panel">
      <span className="wordmark">
        agent<span className="bee">office</span>
      </span>
      <span
        className="conn-dot"
        title={connected ? 'conectado' : 'reconectando…'}
        style={{ background: connected ? '#6fbf73' : '#e25555' }}
      />
      <span className="spacer" />
      <div className="costline">
        <span>gasto total</span>
        <strong>${(cost?.totalUsd ?? 0).toFixed(4)}</strong>
        <span>limite</span>
        {editingBudget === null ? (
          <button
            onClick={() => setEditingBudget(budget === null ? '' : String(budget))}
            title="Definir limite de gasto (pausa a execução ao atingir)"
          >
            {budget === null ? 'sem limite' : `$${budget.toFixed(2)}`}
          </button>
        ) : (
          <input
            autoFocus
            value={editingBudget}
            placeholder="ex. 5"
            onChange={(e) => setEditingBudget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const v = editingBudget.trim();
                send({ type: 'set_budget', budgetUsd: v === '' ? null : Number(v) });
                setEditingBudget(null);
              }
              if (e.key === 'Escape') setEditingBudget(null);
            }}
            onBlur={() => setEditingBudget(null)}
          />
        )}
        {cost?.budgetExceeded && <span className="budget-hit">limite atingido</span>}
      </div>
    </div>
  );
}
