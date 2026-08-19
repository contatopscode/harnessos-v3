import type { JSX } from 'react';
import { PagePlaceholder } from '../components/PagePlaceholder';

export function TracesPage(): JSX.Element {
  return (
    <PagePlaceholder
      title="Traces"
      description="Trilha cronológica de execuções de pipelines e subagentes. Cada run tem steps, tokens consumidos, custo, resultado."
      bullets={[
        'Lista de runs recentes (status, duração, custo)',
        'Detalhe da run com timeline de steps',
        'Filtros por agente, projeto, status',
      ]}
    />
  );
}
