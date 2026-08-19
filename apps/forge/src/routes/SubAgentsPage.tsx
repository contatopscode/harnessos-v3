import { PagePlaceholder } from '../components/PagePlaceholder';

export function SubAgentsPage() {
  return (
    <PagePlaceholder
      title="SubAgents"
      description="Sub-agentes instalados (do HarnessOS `.archon/agents/`). Cada subagente é um prompt + tool spec que pode ser invocado por uma demanda ou manualmente."
      bullets={[
        'Lista de agentes por source (bundled / global / projeto)',
        'Detalhe com system prompt + tools + métricas',
        'Roteamento (qual agente responde qual mensagem)',
      ]}
    />
  );
}
