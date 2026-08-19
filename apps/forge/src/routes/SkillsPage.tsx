import type { JSX } from 'react';
import { PagePlaceholder } from '../components/PagePlaceholder';

export function SkillsPage(): JSX.Element {
  return (
    <PagePlaceholder
      title="Skills"
      description="Catálogo de skills (procedimentos reutilizáveis que o agente pode invocar). Instalados via botão 1-clique no Console do HarnessOS."
      bullets={[
        'Lista de skills instaladas (do HarnessOS)',
        'Botão "Instalar em todos os projetos"',
        'Detalhe com SKILL.md + metadata',
      ]}
    />
  );
}
